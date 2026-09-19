const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { copyExternalAudioToS3 } = require("./audioStorage");
const { findJobByTaskId } = require("./sunoStatusCache");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;

// Suno klip ID'leri UUID, Lyria'da songId = jobId (requestId ya da UUID).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function badRequest(error) {
  return { statusCode: 400, body: JSON.stringify({ error }) };
}

// GÜVENLİK DÜZELTMESİ (SORUN 2754 #13 — SSRF): ses dosyasının kaynağı artık
// istemcinin gönderdiği audioUrl DEĞİL, kullanıcının KENDİ üretim işinin
// (GenerationJobsTable) kaydı. Önceden sunucu istemciden gelen herhangi bir
// URL'yi indirip kütüphaneye koyuyordu (SSRF + sınırsız boyutta dosya ile
// bedava depolama). Suno'da ses URL'si job'un sunoResponseData'sından,
// Lyria'da dosya zaten kendi S3'ümüzde (processLyriaGeneration.js,
// songs/<userId>/<jobId>.mp3) olduğu için hiç indirilmiyor.
async function resolveAudioSource(userId, taskId, songId) {
  let job = null;
  // Lyria (ve jobId ile gelen her iş): taskId === jobId.
  const { Item } = await client.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId: taskId } })
  );
  job = Item || (await findJobByTaskId(taskId));
  if (!job || job.userId !== userId) return null;

  if (job.provider === "lyria") {
    if (songId !== job.jobId) return null;
    return { existingKey: `songs/${userId}/${job.jobId}.mp3` };
  }

  const tracks = job.sunoResponseData?.sunoData || [];
  const track = tracks.find((t) => t.id === songId);
  const url = track?.audioUrl || track?.streamAudioUrl;
  return url ? { url } : null;
}

// Kullanıcının kütüphanesine yeni bir şarkı kaydeder.
//
// ÖNEMLİ DÜZELTME: Önceden Suno'nun kendi (geçici) audioUrl'i doğrudan
// DB'ye yazılıyordu. Suno bu dosyaları bir süre sonra silebilir/URL süresi
// dolabilir -- kullanıcı kütüphanesine döndüğünde şarkı sessizce
// açılamaz hale gelirdi (videolardaki ExpiredToken sorununun sesli
// versiyonu). Artık kayıt anında ses dosyası kendi S3 bucket'ımıza
// kopyalanıyor ve DB'ye sadece S3 KEY yazılıyor.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const body = JSON.parse(event.body || "{}");

    const songId = typeof body.songId === "string" ? body.songId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!body.title || !ID_PATTERN.test(songId) || !ID_PATTERN.test(taskId)) {
      return badRequest("title, songId ve taskId zorunludur.");
    }

    const source = await resolveAudioSource(userId, taskId, songId);
    if (!source) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Şarkının üretim kaydı bulunamadı." }),
      };
    }

    const createdAt = body.createdAt || new Date().toISOString();
    const audioKey = source.existingKey || (await copyExternalAudioToS3(source.url, userId, songId));

    const item = {
      userId,
      songId,
      title: String(body.title).slice(0, 200),
      prompt: String(body.prompt || "").slice(0, 10000),
      audioKey, // DİKKAT: artık bir S3 key, oynatılabilir URL değil
      imageUrl: body.imageUrl || "",
      duration: body.duration ?? null,
      genre: body.genre || "",
      mood: body.mood || "",
      isFavorite: body.isFavorite ?? false,
      taskId,
      // DÜZELTME (kütüphane sekmesi hatası): "mode" (quick/standard/
      // advanced) ve "provider" (suno/lyria) önceden HİÇ SAKLANMIYORDU --
      // Flutter tarafı bu alanları listSongs.js'den geri okumaya
      // çalışıyordu ama hep boş/varsayılan geliyordu, bu yüzden
      // uygulama yeniden başlatıldığında şarkılar sadece "Tümü"
      // sekmesinde görünüyordu (kendi mod sekmesinde değil).
      mode: body.mode || null,
      provider: body.provider || "suno",
      createdAt,
    };

    await client.send(
      new PutCommand({
        TableName: SONGS_TABLE_NAME,
        Item: item,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ songId }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Şarkı kaydedilemedi." }),
    };
  }
};
