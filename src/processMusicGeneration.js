const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { sunoFetch } = require("./sunoProxy");
const { currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME; // UsersTable — jeton düşmek için
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
const SONG_CREDIT_COST = Number(process.env.SONG_CREDIT_COST || 1);

// Bu worker MusicGenerationQueue'dan (SQS) tetiklenir. generate.js artık
// Suno'yu çağırmıyor, sadece bir "job" kaydı bırakıp burayı tetikliyor.
//
// İDEMPOTENCY NOTU: SQS "en az bir kez teslim" garantisi verir — yani aynı
// mesaj nadiren de olsa İKİ KEZ işlenebilir (paralel iki Lambda invocation'ı
// gibi). Suno'ya çift istek atmak = çift ücret demek olduğu için, Suno'yu
// çağırmadan önce job'u DynamoDB'de koşullu bir UpdateCommand ile
// "submitting" olarak KİLİTLİYORUZ. İkinci teslimat bu koşulu geçemez ve
// sessizce atlanır.
//
// Kalan tek risk: Lambda, Suno'yu çağırdıktan SONRA ama sonucu tabloya
// yazmadan ÖNCE çökerse (ör. konteyner kesintisi) — bu durumda job
// "submitting" durumunda asılı kalır. STALE_CLAIM_MS'den daha eski bir
// "submitting" kaydını bir sonraki deneme yeniden ele alabilir (kurtarma).
// Bu, gerçekten çok nadir bir pencere ve ~$0.06/şarkı ölçeğinde kabul
// edilebilir bir risk; ileride gerçek kullanıcı hacmi artarsa Suno
// tarafında bir idempotency-key desteği varsa ona geçilebilir.
const STALE_CLAIM_MS = 2 * 60 * 1000; // 2 dakika

async function claimJob(jobId) {
  const { Item: job } = await client.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId } })
  );
  if (!job) return null; // TTL ile silinmiş veya hiç yazılmamış olabilir
  if (job.status === "ready" || job.status === "failed") return null; // zaten sonuçlanmış

  const isStaleSubmitting =
    job.status === "submitting" &&
    Date.now() - new Date(job.updatedAt).getTime() > STALE_CLAIM_MS;

  if (job.status !== "queued" && !isStaleSubmitting) {
    // Başka bir invocation şu an bu işi zaten işliyor
    return null;
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { jobId },
        UpdateExpression: "SET #st = :submitting, updatedAt = :now",
        ConditionExpression: "#st = :expected",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":submitting": "submitting",
          ":now": new Date().toISOString(),
          ":expected": job.status,
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null; // yarış kaybedildi
    throw err;
  }

  return job;
}

async function releaseJobForRetry(jobId) {
  // Kilidi geri bırak ki SQS'in bir sonraki teslim denemesi işi yeniden alabilsin.
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :queued, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":queued": "queued", ":now": new Date().toISOString() },
    })
  );
}

async function markFailed(jobId, message) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :failed, errorMessage = :msg, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":msg": message,
        ":now": new Date().toISOString(),
      },
    })
  );
}

async function markReady(jobId, taskId) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :ready, taskId = :taskId, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":ready": "ready",
        ":taskId": taskId,
        ":now": new Date().toISOString(),
      },
    })
  );
}

async function deductCredits(userId, cost) {
  const now = new Date();
  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );
  const plan = user?.plan || "free";
  const currentPeriod = currentPeriodKey(plan, now);
  const used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId },
      UpdateExpression:
        "SET aiCreditsUsed = :newUsed, aiCreditsPeriod = :period, #plan = if_not_exists(#plan, :freePlan)",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: {
        ":newUsed": used + cost,
        ":period": currentPeriod,
        ":freePlan": "free",
      },
    })
  );
}

// HTTP 5xx ve 429 (rate limit) = geçici, yeniden denemeye değer.
// Diğer her şey (400 gibi parametre/içerik reddi) = kalıcı, tekrar
// denemenin anlamı yok — job'u direkt "failed" işaretliyoruz.
function isTransientSunoError(status) {
  return status >= 500 || status === 429;
}

exports.handler = async (event) => {
  // BatchSize=1 olduğu için normalde tek kayıt gelir, yine de döngüyle yazıyoruz.
  for (const record of event.Records) {
    const { jobId } = JSON.parse(record.body);

    const job = await claimJob(jobId);
    if (!job) {
      console.log(`Job ${jobId} zaten işlenmiş/işlenmekte veya bulunamadı, atlanıyor.`);
      continue;
    }

    try {
      const { ok, status, data } = await sunoFetch("/api/v1/generate", {
        method: "POST",
        body: JSON.stringify({
          customMode: true,
          instrumental: job.payload.instrumental,
          prompt: job.payload.lyrics,
          style: job.payload.style,
          title: job.payload.title,
          model: "V5_5",
          callBackUrl: job.callBackUrl,
        }),
      });

      if (!ok) {
        if (isTransientSunoError(status)) {
          await releaseJobForRetry(jobId);
          // Hatayı fırlat: SQS bu mesajı otomatik yeniden dener; maxReceiveCount
          // (3) aşılırsa mesaj kendiliğinden MusicGenerationDLQ'ya düşer.
          throw new Error(`Suno geçici hata döndürdü: HTTP ${status} — ${data?.msg || "bilinmiyor"}`);
        }

        // Kalıcı hata — jeton düşülmedi, tekrar denemeye gerek yok.
        console.error(`Job ${jobId} kalıcı olarak başarısız: HTTP ${status}`, JSON.stringify(data));
        await markFailed(jobId, data?.msg || "Şarkı üretimi başlatılamadı.");
        continue; // mesaj başarıyla "işlendi" sayılır, SQS'ten silinir
      }

      // Suno isteği kabul etti — SADECE ŞİMDİ jeton düşülüyor
      await deductCredits(job.userId, SONG_CREDIT_COST);
      await markReady(jobId, data.data.taskId);
    } catch (err) {
      console.error(`Job ${jobId} işleme hatası:`, err);
      throw err; // SQS retry/DLQ mekanizmasını tetikle
    }
  }
};