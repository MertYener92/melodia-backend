// ---------------------------------------------------------------------
// YENİ (FINAL PRODUCTION HARDENING — madde 8): Suno ve Lyria artık ayrı
// SQS kuyruğu + ayrı Lambda worker'da işleniyor (processSunoGeneration.js
// / processLyriaGeneration.js). Bu dosya, ikisinin de PAYLAŞTIĞI job
// yaşam-döngüsü mantığını (claim/lock, başarısızlık, hazır işaretleme,
// kredi iadesi) TEK yerde tutar -- iki worker'ın aynı kilit/idempotency
// kodunu ayrı ayrı (ve potansiyel olarak birbirinden sapan şekilde)
// yazmasını önler.
// ---------------------------------------------------------------------

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { refundCredits } = require("./creditReservation");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;

// İDEMPOTENCY NOTU: SQS "en az bir kez teslim" garantisi verir -- aynı
// mesaj nadiren de olsa İKİ KEZ işlenebilir. Suno/Lyria'ya çift istek
// atmak gerçek para demek olduğu için, istek atmadan önce job'u
// DynamoDB'de koşullu bir UpdateCommand ile "submitting" olarak
// KİLİTLİYORUZ. İkinci teslimat bu koşulu geçemez ve atlanır.
//
// KALAN RİSK (madde 9 — bilinçli kabul edilen, tam kapatılamayan risk):
// Lambda, sağlayıcıyı çağırdıktan SONRA ama sonucu tabloya yazmadan
// ÖNCE çökerse, job "submitting" durumunda asılı kalır. STALE_CLAIM_MS'
// den eski bir "submitting" kaydı bir sonraki deneme tarafından
// yeniden ele alınabilir (kurtarma) -- bu, Suno/Lyria'ya DUPLICATE bir
// istek gitmesi ihtimalini taşır. Suno/Lyria hiçbir idempotency-key
// desteği SUNMUYOR (doğrulandı), bu yüzden bu risk kod tarafında %100
// kapatılamaz. Bunun yerine GÖZLEMLENEBİLİR hale getiriyoruz: her
// stale-claim kurtarmasında STALE_CLAIM_RECLAIMED etiketli bir uyarı
// logu basıyoruz -- template.yaml'daki bir CloudWatch Logs Metric
// Filter + Alarm bunu SNS'e bildiriyor, böylece prod'da sık
// tekrarlanırsa (anormal) hemen fark edilir.
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
    return null; // başka bir invocation şu an bu işi zaten işliyor
  }

  if (isStaleSubmitting) {
    // YENİ (madde 9 — gözlemlenebilirlik): bu satır CloudWatch'ta bir
    // Metric Filter tarafından yakalanıyor (bkz. template.yaml). Metnini
    // değiştirirsen filtreyi de güncellemen gerekir.
    console.warn(
      `STALE_CLAIM_RECLAIMED jobId=${jobId} önceki güncelleme=${job.updatedAt} -- olası duplicate submission riski, izleniyor.`
    );
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

// DEĞİŞTİ (madde 1 — atomik kredi rezervasyonu): kredi artık burada
// DÜŞÜLMÜYOR (generate.js'de job kuyruğa yazılmadan ÖNCE zaten atomik
// olarak rezerve edildi) -- kalıcı bir hatada burada sadece o
// rezervasyonu İADE ediyoruz. job.creditReservation, generate.js
// tarafından job oluşturulurken yazılan {cost, period} bilgisidir.
async function markFailed(job, message) {
  if (job.creditReservation) {
    await refundCredits(
      job.userId,
      job.jobId,
      job.creditReservation.cost,
      job.creditReservation.period,
      job.creditReservation.source || "periodic"
    );
  }
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId: job.jobId },
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

// Lyria: tekrar sorgulanacak bir dış "taskId" yok -- sonuç (başlık,
// oynatılabilir URL, süre) TEK seferde elimizde. status.js'in Flutter'a
// döneceği son hali doğrudan job kaydına yazıyoruz.
async function markReadyWithResult(jobId, result) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression:
        "SET #st = :ready, updatedAt = :now, resultTitle = :title, " +
        "resultAudioUrl = :audioUrl, resultLyrics = :lyrics",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":ready": "ready",
        ":now": new Date().toISOString(),
        ":title": result.title,
        ":audioUrl": result.audioUrl,
        ":lyrics": result.lyrics || "",
      },
    })
  );
}

module.exports = {
  STALE_CLAIM_MS,
  claimJob,
  releaseJobForRetry,
  markFailed,
  markReady,
  markReadyWithResult,
};
