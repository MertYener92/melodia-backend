const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { reserveCredits, refundCreditsStandalone, QuotaExceededError } = require("./creditReservation");
const { songCreditCostForMode, SONG_CREDIT_COST_BY_MODE } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
// YENİ (Remix): kaynak şarkı kullanıcının kendi kütüphanesinden okunur.
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME;
// YENİ (madde 8 — ayrı Suno/Lyria kuyrukları): provider'a göre doğru
// kuyruğa yönlendiriyoruz, böylece uzun süren Lyria job'ları Suno'nun
// hızlı submission akışının Lambda concurrency slotlarını tüketemez.
const GENERATION_QUEUE_URL = process.env.GENERATION_QUEUE_URL; // Suno
const LYRIA_GENERATION_QUEUE_URL = process.env.LYRIA_GENERATION_QUEUE_URL;
// KALDIRILDI (JETON SİSTEMİ x10 GÜNCELLEMESİ): sabit, tek bir
// SONG_CREDIT_COST env var'ı yerine artık maliyet body.mode'a göre
// (bkz. songCreditCostForMode, creditPlans.js) İSTEK ANINDA hesaplanıyor
// -- Hızlı/Standart 10 jeton, Gelişmiş 20 jeton. Suno bir generation'da
// 2 şarkı döndürse bile bu maliyet JOB BAŞINA tek sefer uygulanıyor.
// YENİ (madde 6 — webhook authentication): Suno/Lyria bize dönerken
// callBackUrl'e eklenen paylaşılan secret. Global env değişkeni olarak
// Secrets Manager'dan deploy anında çözülüyor (SUNO_API_KEY ile aynı
// desen) -- koda asla açık yazılmıyor, hiçbir yerde loglanmıyor.
const SUNO_CALLBACK_SECRET = process.env.SUNO_CALLBACK_SECRET;

// YENİ (çift jeton düşme koruması): Flutter her üretim için bir
// requestId üretip AĞ İSTEĞİNDEN ÖNCE diske yazıyor ve uygulama yeniden
// açılınca /status?jobId=<requestId> ile o işi arıyor. Bu yüzden
// requestId geçerliyse jobId olarak AYNEN kullanılıyor -- aynı requestId
// ikinci kez gelirse yeni iş açılmıyor, yeni jeton düşülmüyor.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Suno upload-cover sınırları (custom mode).
const MAX_STYLE_LENGTH = 1000;
const MAX_TITLE_LENGTH = 100;
const MAX_LYRICS_LENGTH = 5000;
const REMIX_TITLE_SUFFIX = " (Remix)";

function badRequest(error, message) {
  return { statusCode: 400, body: JSON.stringify({ error, message }) };
}

function duplicateResponse(job) {
  return {
    statusCode: 202,
    body: JSON.stringify({ jobId: job.jobId, status: job.status, duplicate: true }),
  };
}

// YENİ (Remix): kaynak şarkıyı kullanıcının KENDİ kütüphanesinden bulur ve
// job payload'ını hazırlar. İstemciden asla bir ses URL'si alınmıyor
// (SSRF / başkasının dosyasını kullanma riskine karşı) -- sadece songId;
// ses dosyası worker tarafından S3 anahtarından imzalanıp Suno'ya verilir.
async function buildRemixPayload(userId, body) {
  const songId = typeof body.remixOf === "string" ? body.remixOf.trim() : "";
  if (!songId || songId.length > 128) {
    return { error: badRequest("invalid_remix_source", "Geçersiz kaynak şarkı.") };
  }

  const style = typeof body.style === "string" ? body.style.trim() : "";
  if (!style) {
    return { error: badRequest("style_required", "Remix için bir tarz seçmelisin.") };
  }

  const { Item: song } = await client.send(
    new GetCommand({ TableName: SONGS_TABLE_NAME, Key: { userId, songId } })
  );
  if (!song || !song.audioKey) {
    return {
      error: { statusCode: 404, body: JSON.stringify({ error: "song_not_found", message: "Kaynak şarkı bulunamadı." }) },
    };
  }

  const lyrics = (song.prompt || "").trim().slice(0, MAX_LYRICS_LENGTH);
  const baseTitle = (song.title || "Şarkı").slice(0, MAX_TITLE_LENGTH - REMIX_TITLE_SUFFIX.length);

  return {
    payload: {
      operation: "cover",
      sourceSongId: songId,
      sourceAudioKey: song.audioKey,
      lyrics,
      style: style.slice(0, MAX_STYLE_LENGTH),
      title: `${baseTitle}${REMIX_TITLE_SUFFIX}`,
      // Kaynağın sözü yoksa (enstrümantal şarkı) Suno custom mode'da söz
      // istemediği için remix de enstrümantal olur.
      instrumental: body.instrumental === true || !lyrics,
      vocalGender: null,
      durationSeconds: null,
      lyricsLanguage: null,
      mode: "remix",
    },
  };
}

// DİKKAT — DAVRANIŞ DEĞİŞİKLİĞİ (FINAL PRODUCTION HARDENING, madde 1):
// Kredi artık worker'da (Suno/Lyria isteği kabul edildiğinde) DEĞİL,
// BURADA, job kuyruğa yazılmadan ÖNCE, ATOMİK olarak rezerve ediliyor
// (bkz. creditReservation.js). Bu, aynı kullanıcının eşzamanlı (çift
// dokunma, çoklu cihaz) isteklerinin ikisinin de kotayı "boşta" görüp
// ikisinin de geçmesi (TOCTOU) riskini TAMAMEN kapatır: reserveCredits
// tek bir koşullu DynamoDB yazması olduğu için iki eşzamanlı istekten
// SADECE biri başarılı olabilir.
//
// Suno/Lyria isteği KALICI olarak reddedilirse (worker'da markFailed),
// bu rezervasyon otomatik olarak İADE edilir (bkz. jobLifecycle.js ->
// markFailed -> refundCredits). Geçici hatalarda (SQS retry) rezervasyon
// yerinde kalır -- iş sonunda ya başarılı olur ya da kalıcı başarısızlıkla
// iade edilir, ASLA sessizce kaybolmaz.
exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;
  let reservation = null;
  let songCost = null;
  let jobId = null;
  let jobWritten = false;

  try {
    const body = JSON.parse(event.body || "{}");
    const isRemix = body.remixOf != null;
    // YENİ (JETON SİSTEMİ x10 GÜNCELLEMESİ): maliyet artık body.mode'a
    // göre hesaplanıyor -- Flutter tarafı 'quick' | 'standard' | 'advanced'
    // gönderiyor. Bilinmeyen/eksik mod 'standard' maliyetine (10) düşer,
    // bkz. songCreditCostForMode (creditPlans.js). Remix'te maliyet
    // istemcinin gönderdiği moddan bağımsız, her zaman remix maliyeti.
    songCost = isRemix ? SONG_CREDIT_COST_BY_MODE.remix : songCreditCostForMode(body.mode);

    // 1) HIZ SINIRI — jeton kontrolüne (DynamoDB okuma/yazma) bile
    // gitmeden önce en ucuz ve en hızlı reddi burada yapıyoruz.
    const rl = await checkRateLimit(userId, "generate", 5, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 2) TEKRAR EDEN İSTEK Mİ? — jeton düşmeden ÖNCE bakılır.
    const requestId =
      typeof body.requestId === "string" && REQUEST_ID_PATTERN.test(body.requestId)
        ? body.requestId
        : null;
    if (requestId) {
      const { Item: existing } = await client.send(
        new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId: requestId } })
      );
      if (existing && existing.userId === userId) return duplicateResponse(existing);
      // Aynı ID başka bir kullanıcıya aitse (pratikte imkansız) onu
      // kullanmıyoruz, yeni rastgele bir jobId açıyoruz.
      jobId = existing ? crypto.randomUUID() : requestId;
    } else {
      jobId = crypto.randomUUID();
    }

    // 3) İŞ İÇERİĞİ — remix'te kaynak şarkı jeton düşmeden ÖNCE
    // doğrulanır ki geçersiz istekte iade akışına hiç girilmesin.
    let provider;
    let payload;
    if (isRemix) {
      const remix = await buildRemixPayload(userId, body);
      if (remix.error) return remix.error;
      provider = "suno"; // upload-cover sadece Suno'da var
      payload = remix.payload;
    } else {
      provider = body.provider === "lyria" ? "lyria" : "suno";
      payload = {
        lyrics: body.lyrics,
        style: body.style,
        title: body.title,
        instrumental: body.instrumental ?? false,
        vocalGender: body.vocalGender || null,
        durationSeconds: body.durationSeconds || null,
        lyricsLanguage: body.lyricsLanguage || null,
        // YENİ: sadece izlenebilirlik için saklanıyor (worker bunu
        // okumuyor) -- hangi modun ne maliyete/sonuca yol açtığını
        // loglardan/DB'den takip edebilmek için.
        mode: body.mode || null,
      };
    }

    // 4) KREDİ REZERVASYONU — atomik, TOCTOU'suz (madde 1).
    try {
      reservation = await reserveCredits(userId, songCost);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return {
          statusCode: 429,
          body: JSON.stringify({
            error: "quota_exceeded",
            message: `Bu ayki jeton hakkınız yetersiz (kalan: ${err.remaining}, gereken: ${songCost}).`,
          }),
        };
      }
      throw err;
    }

    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback?key=${encodeURIComponent(SUNO_CALLBACK_SECRET)}`;
    const nowIso = new Date().toISOString();

    // 5) İş kaydı oluştur. creditReservation alanı, worker kalıcı bir
    // hatada bu jobId için TAM OLARAK NE KADAR ve HANGİ DÖNEMDEN
    // rezerve edildiğini bilip doğru şekilde iade edebilsin diye
    // tutuluyor (bkz. jobLifecycle.js -> markFailed).
    try {
      await client.send(
        new PutCommand({
          TableName: JOBS_TABLE_NAME,
          Item: {
            jobId,
            userId,
            provider,
            status: "queued", // queued -> submitting -> ready | failed
            creditReservation: {
              cost: songCost,
              period: reservation.period,
              source: reservation.source,
            },
            creditRefunded: false,
            payload,
            callBackUrl,
            createdAt: nowIso,
            updatedAt: nowIso,
            expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 saat sonra TTL ile silinir
          },
          // Aynı requestId ile eşzamanlı iki istekten sadece biri yazabilir.
          ConditionExpression: "attribute_not_exists(jobId)",
        })
      );
      jobWritten = true;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // Yarışı kaybettik: diğer istek işi zaten açtı. Bu istekte rezerve
      // edilen jetonu geri ver, var olan işi döndür.
      await refundCreditsStandalone(userId, songCost, reservation.period, reservation.source);
      reservation = null;
      const { Item: existing } = await client.send(
        new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId } })
      );
      return duplicateResponse(existing || { jobId, status: "queued" });
    }

    // 6) Doğru kuyruğa at (madde 8 — Suno/Lyria ayrı kuyruklar).
    const queueUrl = provider === "lyria" ? LYRIA_GENERATION_QUEUE_URL : GENERATION_QUEUE_URL;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ jobId }),
      })
    );

    return {
      statusCode: 202,
      body: JSON.stringify({
        jobId,
        status: "queued",
        remainingCredits: reservation.remaining,
      }),
    };
  } catch (err) {
    console.error(err);
    // YENİ (madde 1 — telafi edici iade): kredi rezerve edildi ama
    // bundan SONRAKİ bir adım (job kaydı/SQS) başarısız olduysa,
    // kullanıcıyı asla "ücret alındı ama iş hiç kuyruğa girmedi"
    // durumunda bırakmıyoruz -- aynı istek içinde, hemen telafi eden
    // bir iade deniyoruz. (Bu, işin normal SONUCUNA bağlı asıl
    // iade -- markFailed -- akışından FARKLI ve ONA EK bir güvenlik
    // ağıdır; yalnızca job hiç kuyruğa giremediyse devreye girer.)
    if (reservation) {
      try {
        await refundCreditsStandalone(userId, songCost, reservation.period, reservation.source);
      } catch (refundErr) {
        console.error("Telafi edici iade de başarısız oldu:", refundErr);
      }
    }
    // Job yazıldı ama kuyruğa giremediyse "failed" işaretle -- aksi halde
    // aynı requestId ile gelen tekrar istek sonsuza kadar "queued" görürdü.
    if (jobWritten) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: JOBS_TABLE_NAME,
            Key: { jobId },
            UpdateExpression: "SET #st = :failed, errorMessage = :msg, creditRefunded = :true, updatedAt = :now",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
              ":failed": "failed",
              ":msg": "Şarkı üretimi başlatılamadı.",
              ":true": true,
              ":now": new Date().toISOString(),
            },
          })
        );
      } catch (markErr) {
        console.error("Job failed olarak işaretlenemedi:", markErr);
      }
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "internal_error", message: err.message }),
    };
  }
};
