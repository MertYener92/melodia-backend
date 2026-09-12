const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { limitForPlan, currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
const GENERATION_QUEUE_URL = process.env.GENERATION_QUEUE_URL;
const SONG_CREDIT_COST = Number(process.env.SONG_CREDIT_COST || 1);

async function checkCreditsAvailable(userId, cost) {
  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();

  // SAVUNMA KATMANI (madde 11 — paywall): Apple'ın webhook'u bir sebeple
  // gecikirse ya da hiç gelmezse diye SADECE ona güvenmiyoruz — abonelik
  // süresi (planExpiresAt) burada da kontrol ediliyor. Süresi geçmiş bir
  // "pro" kullanıcı otomatik olarak free limitine düşer.
  const isExpired = user?.planExpiresAt && new Date(user.planExpiresAt) < now;
  const plan = isExpired ? "free" : user?.plan || "free";

  const limit = limitForPlan(plan);
  const currentPeriod = currentPeriodKey(plan, now);
  const used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  return { allowed: used + cost <= limit, remaining: Math.max(limit - used, 0), used, currentPeriod };
}

// DİKKAT — DAVRANIŞ DEĞİŞİKLİĞİ:
// Eskiden bu fonksiyon Suno'yu SENKRON çağırıp cevabı bekliyordu; Suno
// geçici bir hata verdiğinde (ağ sorunu, 5xx, timeout) kullanıcıya direkt
// 502 dönüyorduk ve otomatik yeniden deneme yoktu.
//
// YENİ: Suno'ya gerçek istek burada ATILMIYOR. Sadece jeton kontrolü
// yapılıp iş kaydı (job) DynamoDB'ye yazılıyor ve SQS kuyruğuna bir
// mesaj bırakılıyor. Asıl Suno çağrısını processMusicGeneration.js
// (kuyruktan tetiklenen ayrı bir Lambda) yapıyor — video projesindeki
// startAssembly.js / AssemblyQueue deseninin birebir aynısı. Böylece:
//  - Suno geçici hata verirse SQS otomatik olarak yeniden dener
//  - 3 denemeden sonra hâlâ başarısızsa mesaj MusicGenerationDLQ'ya düşer
//  - jeton, Suno isteği gerçekten kabul edildiğinde (worker içinde) düşülür
exports.handler = async (event) => {
  try {
    // 1) Kullanıcı kim?
    const userId = event.requestContext.authorizer.claims.sub;

    // 1.5) HIZ SINIRI — jeton kontrolüne (DynamoDB okuma) bile gitmeden önce
    // en ucuz ve en hızlı reddi burada yapıyoruz. /generate pahalı bir uç
    // nokta (gerçek para harcıyor), bu yüzden limiti sıkı tutuyoruz: bir
    // kullanıcı dakikada en fazla 5 üretim isteği başlatabilir.
    const rl = await checkRateLimit(userId, "generate", 5, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 2) JETON KONTROLÜ — kuyruğa hiç yazmadan önce hızlıca reddet
    const creditCheck = await checkCreditsAvailable(userId, SONG_CREDIT_COST);
    if (!creditCheck.allowed) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: "quota_exceeded",
          message: `Bu ayki jeton hakkınız yetersiz (kalan: ${creditCheck.remaining}, gereken: ${SONG_CREDIT_COST}).`,
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback`;
    const jobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // 3) İş kaydı oluştur (henüz Suno'ya hiçbir şey gönderilmedi)
    await client.send(
      new PutCommand({
        TableName: JOBS_TABLE_NAME,
        Item: {
          jobId,
          userId,
          status: "queued", // queued -> submitting -> ready | failed
          payload: {
            lyrics: body.lyrics,
            style: body.style,
            title: body.title,
            instrumental: body.instrumental ?? false,
          },
          callBackUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 saat sonra TTL ile silinir
        },
      })
    );

    // 4) Kuyruğa at — mesaj küçük tutuluyor (jobId yeter), worker detayı
    // tablodan okuyor. Video projesiyle aynı yaklaşım.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: GENERATION_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId }),
      })
    );

    return {
      statusCode: 202,
      body: JSON.stringify({
        jobId,
        status: "queued",
        remainingCredits: creditCheck.remaining - SONG_CREDIT_COST,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "internal_error", message: err.message }),
    };
  }
};