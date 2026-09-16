// ---------------------------------------------------------------------
// YENİ (5.000 kullanıcı ölçeklendirmesi — webhook + 18sn cache; FINAL
// PRODUCTION HARDENING madde 2 — monotonic state machine):
//
// Bu dosya, bir Suno job'ının "Suno tarafındaki durumu"nu -- status.js'in
// Flutter'a döndüğü record-info benzeri şekli -- OKUYAN/YAZAN tek ortak
// yerdir. Üç yer bunu kullanır: processSunoGeneration.js (PENDING'e
// kurar), sunoCallback.js (webhook geldiğinde ilerletir), status.js
// (webhook gelmediyse güvenlik-ağı poll'u sonrası günceller).
//
// MONOTONIC STATE MACHINE: her durumun sabit bir "rank"ı var (aşağıdaki
// STATUS_RANK). Bir job'ın durumu SADECE eşit ya da daha yüksek rank'a
// sahip bir duruma geçebilir -- DynamoDB'nin ConditionExpression'ı ile
// ATOMİK olarak zorlanıyor (stored rank <= yeni rank). Bunun iki somut
// sonucu var:
//   1) Final bir duruma (SUCCESS / *_FAILED, en yüksek rank) ulaşmış
//      bir job bir daha ASLA geri alınamaz -- geç kalmış/sırasız bir
//      webhook ya da bayat bir poll sonucu onu bozamaz.
//   2) Ara durumlar da (PENDING -> TEXT_SUCCESS -> FIRST_SUCCESS)
//      SADECE ileri gidebilir -- sırasız gelen bir "text" callback'i,
//      zaten "first" aşamasına geçmiş bir job'ı geriye ALAMAZ.
// Bu, hem sunoCallback.js'in webhook'ları hem de status.js'in
// güvenlik-ağı poll'unun sonuçları için TEK bir yerden, tutarlı şekilde
// uygulanır.
// ---------------------------------------------------------------------

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;

// Webhook zaten anında güncellediği için bu süre normal şartlarda HİÇ
// devreye girmiyor -- sadece Suno'nun webhook'u gecikirse/kaybolursa
// devreye giren bir GÜVENLİK AĞI penceresi.
const CACHE_TTL_MS = 18000;

// Suno'nun kendi durum sözlüğü (Flutter'ın TaskStatus.fromString'i ile
// BİREBİR eşleşiyor, bkz. melodia/lib/models/song.dart).
const SUNO_STATUS = {
  PENDING: "PENDING",
  TEXT_SUCCESS: "TEXT_SUCCESS",
  FIRST_SUCCESS: "FIRST_SUCCESS",
  SUCCESS: "SUCCESS",
  GENERATE_AUDIO_FAILED: "GENERATE_AUDIO_FAILED",
};

// Rank tablosu -- monotonic state machine'in tek kaynağı. Final
// durumların hepsi (SUCCESS ve tüm *_FAILED/*_ERROR varyantları) EN
// YÜKSEK rank'ı (99) paylaşır: hangisine ULAŞILIRSA ulaşılsın, bir
// daha hiçbiri (bir diğer final durum dahil) onun üzerine yazamaz.
const STATUS_RANK = {
  PENDING: 0,
  TEXT_SUCCESS: 1,
  FIRST_SUCCESS: 2,
  SUCCESS: 99,
  CREATE_TASK_FAILED: 99,
  GENERATE_AUDIO_FAILED: 99,
  CALLBACK_EXCEPTION: 99,
  SENSITIVE_WORD_ERROR: 99,
};
const FINAL_RANK = 99;

function rankOf(sunoTaskStatus) {
  return STATUS_RANK[sunoTaskStatus] ?? 0;
}

function isFinalStatus(sunoTaskStatus) {
  return rankOf(sunoTaskStatus) >= FINAL_RANK;
}

function isCacheFresh(statusCachedAt) {
  if (!statusCachedAt) return false;
  return Date.now() - statusCachedAt < CACHE_TTL_MS;
}

// processSunoGeneration.js: Suno isteği kabul edildiği AN çağrılır.
// Job zaten "ready" işaretleniyordu (bkz. jobLifecycle.js -> markReady)
// -- burada SADECE webhook/cache alanlarını ilk değerine (PENDING,
// sonuç yok) kurar.
//
// NADİR IRK KORUMASI: markReady taskId'yi yazdığı ANDAN itibaren Suno
// teorik olarak webhook'u ateşleyebilir -- bu, biz henüz
// initSunoStatusCache'i çalıştırmadan ÖNCE olabilir. attribute_not_exists
// koşulu sayesinde, webhook bizden ÖNCE yazdıysa bu çağrı onu PENDING'e
// GERİ ALMAZ, sessizce atlanır (aynı monotonic ilke, burada da geçerli).
async function initSunoStatusCache(jobId) {
  try {
    await client.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { jobId },
        UpdateExpression:
          "SET sunoTaskStatus = :pending, sunoStatusRank = :rank, " +
          "sunoResponseData = :empty, sunoErrorMessage = :null, statusCachedAt = :now",
        ConditionExpression: "attribute_not_exists(sunoTaskStatus)",
        ExpressionAttributeValues: {
          ":pending": SUNO_STATUS.PENDING,
          ":rank": rankOf(SUNO_STATUS.PENDING),
          ":empty": { sunoData: [] },
          ":null": null,
          ":now": Date.now(),
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return;
    throw err;
  }
}

// jobId biliniyorken (status.js'in güvenlik-ağı poll'u VEYA
// sunoCallback.js'in webhook'u) cache'i günceller. Yazma GERÇEKTEN
// uygulandıysa true, monotonic koruma yüzünden ATLANDIYSA false döner
// -- çağıran taraf (ör. sunoCallback.js'in kredi iade kararı) bu
// "gerçekten kazandı mı" bilgisine ihtiyaç duyabilir.
//
// MONOTONIC KORUMA (madde 2): yazma İKİ koşulu BİRDEN sağlamalı:
//  1) Job HENÜZ final bir duruma ULAŞMAMIŞ olmalı (stored rank < 99).
//     Bu tek şart bile, iki FARKLI final durumun (ör. "complete"tan
//     SONRA gecikmiş bir "error") birbirini EZMESİNİ engeller -- rank'ları
//     eşit (99) olsa bile, ilk ulaşan kazanır ve bir daha KİMSE
//     (bir diğer final durum DAHİL) üzerine yazamaz.
//  2) Yeni rank, mevcut rank'tan KÜÇÜK olmamalı (ara durumlar da SADECE
//     ileri gidebilir; ör. FIRST_SUCCESS'ten TEXT_SUCCESS'e regresyon
//     engellenir).
async function writeSunoStatusCache(jobId, { sunoTaskStatus, sunoResponseData, sunoErrorMessage }) {
  const newRank = rankOf(sunoTaskStatus);
  const params = {
    TableName: JOBS_TABLE_NAME,
    Key: { jobId },
    UpdateExpression:
      "SET sunoTaskStatus = :status, sunoStatusRank = :rank, sunoResponseData = :response, " +
      "sunoErrorMessage = :error, statusCachedAt = :now",
    ConditionExpression:
      "attribute_not_exists(sunoStatusRank) OR (sunoStatusRank < :finalRank AND sunoStatusRank <= :rank)",
    ExpressionAttributeValues: {
      ":status": sunoTaskStatus,
      ":rank": newRank,
      ":response": sunoResponseData || { sunoData: [] },
      ":error": sunoErrorMessage || null,
      ":now": Date.now(),
      ":finalRank": FINAL_RANK,
    },
  };

  try {
    await client.send(new UpdateCommand(params));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Job zaten final bir duruma ulaşmış (ya da daha yüksek bir ara
      // rank'ta) -- geç kalmış/sırasız bir callback ya da bayat bir
      // poll sonucu. Sessizce yok say, bu beklenen ve zararsız bir durum.
      return false;
    }
    throw err;
  }
}

// sunoCallback.js: sadece Suno'nun taskId'si biliniyor (jobId değil).
// GenerationJobsTable'daki TaskIdIndex GSI'ı (KEYS_ONLY -- sadece jobId/
// taskId taşır, ucuz) üzerinden jobId'yi bulur, ardından TAM job
// kaydını (userId, creditReservation, status vb. dahil) ana tablodan
// okur -- webhook'un "error" dalı kredi iadesi için bu alanlara
// ihtiyaç duyuyor (bkz. sunoCallback.js).
async function findJobByTaskId(taskId) {
  const { Items } = await client.send(
    new QueryCommand({
      TableName: JOBS_TABLE_NAME,
      IndexName: "TaskIdIndex",
      KeyConditionExpression: "taskId = :taskId",
      ExpressionAttributeValues: { ":taskId": taskId },
      Limit: 1,
    })
  );
  const hit = Items?.[0];
  if (!hit) return null;

  const { Item: job } = await client.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId: hit.jobId } })
  );
  return job || null;
}

// Webhook'un data.data[] (snake_case) dizisini, status.js'in Suno'nun
// canlı /record-info yanıtından beklediği response.sunoData[]
// (camelCase, Song.fromJson ile birebir eşleşen) şekline çevirir.
function mapWebhookTracksToSunoData(tracks) {
  return (tracks || []).map((t) => ({
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    audioUrl: t.audio_url,
    streamAudioUrl: t.stream_audio_url,
    imageUrl: t.image_url,
    duration: t.duration,
  }));
}

module.exports = {
  CACHE_TTL_MS,
  SUNO_STATUS,
  STATUS_RANK,
  rankOf,
  isFinalStatus,
  isCacheFresh,
  initSunoStatusCache,
  writeSunoStatusCache,
  findJobByTaskId,
  mapWebhookTracksToSunoData,
};
