const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;

// YENİ: /generate artık senkron değil, hemen bir jobId dönüyor. Suno'nun
// kendi taskId'si ancak worker Suno'yu başarıyla çağırdıktan SONRA var
// oluyor. Bu yüzden bu uç nokta artık iki modu destekliyor:
//  - ?jobId=...   -> önce job kaydına bakar (queued/submitting/failed/ready)
//  - ?taskId=...  -> doğrudan Suno'nun durumunu sorar (eskisiyle aynı, geriye dönük uyumluluk)
// Flutter istemcisi: /generate'ten dönen jobId ile pollamaya başlar; job
// "ready" olduğunda cevapta hem job durumu hem de taskId birlikte döner,
// istemci dilerse o andan sonra taskId ile pollamaya geçebilir.
exports.handler = async (event) => {
  try {
    // HIZ SINIRI — bu bir polling uç noktası (Flutter periyodik çağırıyor),
    // bu yüzden limit /generate'e göre çok daha gevşek: dakikada 60 istek
    // (ortalama saniyede 1) normal bir polling döngüsünü asla etkilemez,
    // sadece döngüye giren bir bug'ı ya da kötüye kullanımı yakalar.
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "status", 60, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const jobId = event.queryStringParameters?.jobId;
    let taskId = event.queryStringParameters?.taskId;

    if (jobId) {
      const { Item: job } = await client.send(
        new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId } })
      );

      if (!job) {
        return { statusCode: 404, body: JSON.stringify({ error: "job_not_found" }) };
      }

      if (job.status === "queued" || job.status === "submitting") {
        return { statusCode: 200, body: JSON.stringify({ status: "queued" }) };
      }

      if (job.status === "failed") {
        return {
          statusCode: 200,
          body: JSON.stringify({ status: "failed", message: job.errorMessage }),
        };
      }

      // job.status === "ready" -> Suno'nun kendi durumunu sormaya devam ediyoruz
      taskId = job.taskId;
    }

    if (!taskId) {
      return { statusCode: 400, body: JSON.stringify({ error: "jobId veya taskId gerekli." }) };
    }

    const { ok, status, data } = await sunoFetch(
      `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`
    );

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Durum sorgulanamadı." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ ...data.data, taskId }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};