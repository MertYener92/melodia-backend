const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { reserveCredits, refundCreditsStandalone, QuotaExceededError } = require("./creditReservation");
const { songCreditCostForMode } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
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

  try {
    const body = JSON.parse(event.body || "{}");
    // YENİ (JETON SİSTEMİ x10 GÜNCELLEMESİ): maliyet artık body.mode'a
    // göre hesaplanıyor -- Flutter tarafı 'fast' | 'standard' | 'advanced'
    // gönderiyor. Bilinmeyen/eksik mod 'standard' maliyetine (10) düşer,
    // bkz. songCreditCostForMode (creditPlans.js).
    songCost = songCreditCostForMode(body.mode);

    // 1) HIZ SINIRI — jeton kontrolüne (DynamoDB okuma/yazma) bile
    // gitmeden önce en ucuz ve en hızlı reddi burada yapıyoruz.
    const rl = await checkRateLimit(userId, "generate", 5, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 2) KREDİ REZERVASYONU — atomik, TOCTOU'suz (madde 1).
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
    const jobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const provider = body.provider === "lyria" ? "lyria" : "suno";

    // 3) İş kaydı oluştur. creditReservation alanı, worker kalıcı bir
    // hatada bu jobId için TAM OLARAK NE KADAR ve HANGİ DÖNEMDEN
    // rezerve edildiğini bilip doğru şekilde iade edebilsin diye
    // tutuluyor (bkz. jobLifecycle.js -> markFailed).
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
          payload: {
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
          },
          callBackUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 saat sonra TTL ile silinir
        },
      })
    );

    // 4) Doğru kuyruğa at (madde 8 — Suno/Lyria ayrı kuyruklar).
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "internal_error", message: err.message }),
    };
  }
};
