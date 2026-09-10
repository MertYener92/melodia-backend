const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");
const { copyExternalAudioToS3 } = require("./audioStorage");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;

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

    if (!body.title || !body.audioUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "title ve audioUrl zorunludur." }),
      };
    }

    const songId = body.songId || crypto.randomUUID();
    const createdAt = body.createdAt || new Date().toISOString();

    const audioKey = await copyExternalAudioToS3(body.audioUrl, userId, songId);

    const item = {
      userId,
      songId,
      title: body.title,
      prompt: body.prompt || "",
      audioKey, // DİKKAT: artık bir S3 key, oynatılabilir URL değil
      imageUrl: body.imageUrl || "",
      duration: body.duration ?? null,
      genre: body.genre || "",
      mood: body.mood || "",
      isFavorite: body.isFavorite ?? false,
      taskId: body.taskId || "",
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
      body: JSON.stringify({ error: err.message }),
    };
  }
};