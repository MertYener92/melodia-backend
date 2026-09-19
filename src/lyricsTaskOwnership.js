// GÜVENLİK (SORUN 2754): Suno söz görevleri (lyrics task) bir "job" kaydı
// oluşturmadığı için /lyrics-status herhangi bir kullanıcının herhangi bir
// taskId'yi sorgulamasına izin veriyordu. Görevi başlatan kullanıcıyı, zaten
// TTL'li olan RateLimitTable'a kısa ömürlü bir kayıt olarak yazıyoruz --
// yeni tablo/izin gerekmiyor (her iki fonksiyonda da bu tabloya CRUD var).

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME;
const KEY_PREFIX = "lyricsTask#";
const TTL_SECONDS = 24 * 60 * 60;

async function recordLyricsTaskOwner(taskId, userId) {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        rateLimitKey: `${KEY_PREFIX}${taskId}`,
        userId,
        expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    })
  );
}

async function isLyricsTaskOwner(taskId, userId) {
  const { Item } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { rateLimitKey: `${KEY_PREFIX}${taskId}` } })
  );
  return Item?.userId === userId;
}

module.exports = { recordLyricsTaskOwner, isLyricsTaskOwner };
