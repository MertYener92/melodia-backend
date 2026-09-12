const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME;

// Basit, "sabit pencereli" (fixed-window) hız sınırlayıcı. Redis/ElastiCache
// gibi ekstra bir servis GEREKTİRMİYOR — DynamoDB'nin atomik ADD işlemini
// kullanıyor, projenin geri kalanıyla (jeton sistemi, job tablosu vb.) aynı
// desen. Bu ölçekte (henüz binlerce eşzamanlı kullanıcı yok) endüstri
// standardı, yeterince doğru ve neredeyse bedava bir çözüm.
//
// Nasıl çalışır: her (kullanıcı, işlem) çifti için zaman "pencerelere"
// bölünür (ör. 60 saniyelik dilimler). Her istekte o dilime ait sayaç
// atomik olarak +1 artırılır; sayaç limiti aşarsa istek reddedilir.
// Pencere kapandığında kayıt TTL ile kendiliğinden silinir — elle
// temizlik gerekmez.
//
// action: hangi uç noktanın sınırlandığı (ör. "generate", "status")
// limit: pencere başına izin verilen istek sayısı
// windowSeconds: pencere genişliği (saniye)
async function checkRateLimit(userId, action, limit, windowSeconds) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const key = `${userId}#${action}#${windowStart}`;

  const { Attributes } = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { rateLimitKey: key },
      UpdateExpression: "ADD requestCount :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
      ExpressionAttributeValues: {
        ":one": 1,
        ":ttl": windowStart + windowSeconds + 60, // pencere bitince biraz pay ile TTL'den silinir
      },
      ReturnValues: "UPDATED_NEW",
    })
  );

  const count = Attributes.requestCount;
  const retryAfterSeconds = Math.max(
    windowStart + windowSeconds - Math.floor(Date.now() / 1000),
    1
  );

  return { allowed: count <= limit, count, limit, retryAfterSeconds };
}

// 429 cevabını standart bir şekilde üretir. Retry-After header'ı sayesinde
// Flutter tarafı "ne kadar sonra tekrar denemeli" bilgisini otomatik alır.
function rateLimitResponse(retryAfterSeconds) {
  return {
    statusCode: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
    body: JSON.stringify({
      error: "rate_limited",
      message: `Çok hızlı istek gönderiyorsun, ${retryAfterSeconds} saniye sonra tekrar dene.`,
    }),
  };
}

module.exports = { checkRateLimit, rateLimitResponse };