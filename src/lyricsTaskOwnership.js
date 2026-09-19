// GÜVENLİK (SORUN 2754): Suno söz görevleri (lyrics task) bir "job" kaydı
// oluşturmadığı için /lyrics-status herhangi bir kullanıcının herhangi bir
// taskId'yi sorgulamasına izin veriyordu. Görevi başlatan kullanıcıyı, zaten
// TTL'li olan RateLimitTable'a kısa ömürlü bir kayıt olarak yazıyoruz --
// yeni tablo/izin gerekmiyor (her iki fonksiyonda da bu tabloya CRUD var).
//
// YENİ (uzun söz açıklamaları): Suno'nun söz ucu en fazla 200 karakter
// kabul ediyor. Daha uzun açıklamalarda sözler Claude ile arka planda
// yazılıyor (lyricsWriter.js); bu görevlerin durumu ve sonucu da AYNI
// kayıtta tutuluyor. Bu görevlerin ID'si CLAUDE_TASK_PREFIX ile başlar.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME;
const KEY_PREFIX = "lyricsTask#";
const TTL_SECONDS = 24 * 60 * 60;
const CLAUDE_TASK_PREFIX = "cl_";

const keyFor = (taskId) => ({ rateLimitKey: `${KEY_PREFIX}${taskId}` });

async function recordLyricsTaskOwner(taskId, userId, extra = {}) {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...keyFor(taskId),
        ...extra,
        userId,
        expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    })
  );
}

async function getLyricsTask(taskId) {
  const { Item } = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: keyFor(taskId) }));
  return Item || null;
}

async function isLyricsTaskOwner(taskId, userId) {
  const task = await getLyricsTask(taskId);
  return task?.userId === userId;
}

// Claude görevinin sonucunu yazar: { status, title?, text?, errorMessage? }.
async function completeLyricsTask(taskId, result) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [field, value] of Object.entries(result)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
  }
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keyFor(taskId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

module.exports = {
  CLAUDE_TASK_PREFIX,
  recordLyricsTaskOwner,
  getLyricsTask,
  isLyricsTaskOwner,
  completeLyricsTask,
};
