// Suno API (sunoapi.org), /generate ve /lyrics isteklerinde zorunlu bir
// callBackUrl ister ve işlem bitince oraya bir POST atar. Sonucu zaten
// /status ve /lyrics-status ile polling yaparak aldığımız için callback
// içeriğinin şarkı verisiyle ilgilenmemize gerek yok — ama bu callback,
// GERÇEK Suno maliyetini ölçmek için doğru an: task tam burada bitiyor.
// Auth: NONE, çünkü bu isteği Suno'nun sunucusu atıyor, giriş yapmış bir
// kullanıcı değil.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const COST_LOG_TABLE_NAME = process.env.COST_LOG_TABLE_NAME;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const SUNO_BASE_URL = "https://api.sunoapi.org";

async function getSunoCreditBalance() {
  try {
    const res = await fetch(`${SUNO_BASE_URL}/api/v1/generate/credit`, {
      headers: { Authorization: `Bearer ${SUNO_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return typeof data?.data === "number" ? data.data : null;
  } catch (err) {
    console.error("Suno bakiye sorgusu başarısız:", err);
    return null;
  }
}

exports.handler = async (event) => {
  try {
    console.log("Suno callback alındı:", event.body);

    const body = JSON.parse(event.body || "{}");
    const taskId = body?.data?.taskId;

    if (taskId && COST_LOG_TABLE_NAME) {
      const { Item: logItem } = await client.send(
        new GetCommand({ TableName: COST_LOG_TABLE_NAME, Key: { taskId } })
      );

      if (logItem?.creditsBefore != null) {
        const creditsAfter = await getSunoCreditBalance();
        if (creditsAfter != null) {
          const consumed = logItem.creditsBefore - creditsAfter;
          // GERÇEK MALİYET ÖLÇÜMÜ — CloudWatch loglarında ara:
          // "SUNO GERCEK MALIYET"
          console.log(
            `SUNO GERCEK MALIYET | taskId=${taskId} | oncekiBakiye=${logItem.creditsBefore} | sonrakiBakiye=${creditsAfter} | harcananKredi=${consumed}`
          );
        }
        // Ölçüm tamamlandı, geçici kaydı temizle (TTL zaten temizler
        // ama hemen silmek daha temiz).
        await client.send(
          new DeleteCommand({ TableName: COST_LOG_TABLE_NAME, Key: { taskId } })
        );
      }
    }
  } catch (err) {
    console.error("Callback işleme hatası:", err);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};