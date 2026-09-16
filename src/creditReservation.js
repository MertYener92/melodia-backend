// ---------------------------------------------------------------------
// YENİ (FINAL PRODUCTION HARDENING — madde 1): Kredi kullanımı artık
// GET→SET değil, DynamoDB'nin koşullu atomik yazmaları üzerine kurulu.
// İki işlev:
//
//   - reserveCredits(userId, cost): generate.js tarafından, job DAHA
//     KUYRUĞA YAZILMADAN ÖNCE çağrılır. Kontrol VE düşüm TEK atomik
//     operasyonda olduğu için aynı kullanıcının eşzamanlı (çift
//     dokunma, çoklu cihaz) istekleri arasındaki TOCTOU (check sonra
//     act) yarışı TAMAMEN kapanır.
//   - refundCredits(userId, jobId, cost, period): worker, Suno/Lyria
//     isteği KALICI olarak reddedildiğinde çağırır. DynamoDB Transaction
//     (TransactWriteItems) ile iade VE job üzerindeki "refunded"
//     bayrağı TEK atomik işlemde yazılır -- ikisi ya BİRLİKTE olur ya
//     HİÇBİRİ olmaz, bu yüzden bir stale-claim sonrası olası ikinci
//     bir deneme aynı job'ı iki kez iade ETTİREMEZ.
// ---------------------------------------------------------------------

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { limitForPlan, currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
// YENİ (jeton istismarı düzeltmesi): appleAuth.js tarafından UsersTable'a
// yazılan appleUserIdHash'in "bu kimlik ücretsiz denemesini kullandı mı"
// takibini tuttuğu, deleteAccount.js'nin ASLA SİLMEDİĞİ, kişisel veri
// İÇERMEYEN (sadece opak hash + zaman damgası) ayrı tablo.
const FREE_TRIAL_LEDGER_TABLE_NAME = process.env.FREE_TRIAL_LEDGER_TABLE_NAME;

class QuotaExceededError extends Error {
  constructor(remaining, limit) {
    super(`Kota yetersiz (kalan: ${remaining}).`);
    this.name = "QuotaExceededError";
    this.remaining = remaining;
    this.limit = limit;
  }
}

// Kullanıcının GÜNCEL plan/limit/dönem bilgisini okur. Bu SALT OKUNUR
// adımdır -- plan değişikliği subscription webhook'undan (verifySubscription.js
// / appleNotifications.js) gelir ve generate spam'iyle YARIŞMAZ; asıl
// korunması gereken yarış SADECE sayaç (aiCreditsUsed) üzerinde, o da
// aşağıda tamamen atomik.
async function getPlanContext(userId) {
  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );
  const now = new Date();
  const isExpired = user?.planExpiresAt && new Date(user.planExpiresAt) < now;
  const plan = isExpired ? "free" : user?.plan || "free";
  const limit = limitForPlan(plan);
  const period = currentPeriodKey(plan, now);
  return {
    plan,
    limit,
    period,
    appleUserIdHash: user?.appleUserIdHash,
    aiCreditsPeriod: user?.aiCreditsPeriod,
  };
}

// YENİ (jeton istismarı düzeltmesi -- "hesabı sil, aynı Apple kimliğiyle
// tekrar kaydol, yeniden ücretsiz jeton kazan" döngüsünü kapatır).
// appleUserIdHash BOŞSA (eski kayıt ya da Apple ile girilmemiş) hiçbir
// şey yapmadan geri döner -- bu koruma o durumda devreye giremez, ama
// girişi/üretimi de ENGELLEMEZ. Koşullu (atomik) bir PutItem: bu hash
// tabloda YOKSA başarıyla "iddia edilir" (claim) ve fonksiyon sessizce
// döner; ZATEN VARSA (bu Apple kimliği daha önce -- muhtemelen silinmiş
// bir hesapta -- ücretsiz jetonunu kullanmış demektir) QuotaExceededError
// fırlatılır, UsersTable'a HİÇ dokunulmadan reddedilir.
async function claimFreeTrialOrThrow(appleUserIdHash) {
  if (!appleUserIdHash || !FREE_TRIAL_LEDGER_TABLE_NAME) return;
  try {
    await client.send(
      new PutCommand({
        TableName: FREE_TRIAL_LEDGER_TABLE_NAME,
        Item: { appleUserIdHash, claimedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(appleUserIdHash)",
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      throw new QuotaExceededError(0, 1);
    }
    throw err;
  }
}

// İki adımlı atomik rezervasyon:
//
// ADIM 1 (dönem değişti / ilk kullanım): SADECE kayıtlı dönem MEVCUT
// dönemle eşleşmiyorsa (ya da hiç yoksa) çalışır -- sayaç bu isteğin
// maliyetiyle SIFIRDAN kurulur. İki eşzamanlı istek aynı anda buraya
// düşerse (ör. yeni ayın ilk saniyesi), koşulu SADECE biri geçer;
// kaybeden ADIM 2'ye düşer ve orada (artık dönem eşleştiği için) normal
// atomik ADD ile devam eder.
//
// ADIM 2 (aynı dönem içinde normal artış): DynamoDB'nin atomik "ADD"ı
// ile sayaç artırılır -- ama SADECE artıştan SONRAKİ toplam limiti
// AŞMAYACAKSA (koşul, artıştan ÖNCEKİ değere bakar: aiCreditsUsed <=
// limit-cost). Koşul sağlanmazsa DynamoDB yazmayı hiç yapmaz -- iki
// eşzamanlı istek son 1 krediyi aynı anda görüp ikisi de "başarılı"
// olamaz, sadece biri geçer, diğeri QuotaExceededError alır.
async function reserveCredits(userId, cost) {
  const { plan, limit, period, appleUserIdHash, aiCreditsPeriod } = await getPlanContext(userId);

  // YENİ (jeton istismarı düzeltmesi): SADECE bu satırın "free" planda
  // İLK KEZ ("lifetime" dönemi henüz hiç kurulmamış) jeton alacağı an
  // devreye giriyor -- yani ADIM 1'in az sonra tetikleneceği durum.
  // pro planlarda VEYA aynı hesabın normal (dönem zaten eşleşen) ikinci+
  // isteklerinde bu kontrol HİÇ çalışmaz, mevcut refund/retry akışlarını
  // etkilemez.
  if (plan === "free" && aiCreditsPeriod !== period) {
    await claimFreeTrialOrThrow(appleUserIdHash);
  }

  const now = new Date().toISOString();

  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression:
          "SET aiCreditsUsed = :cost, aiCreditsPeriod = :period, updatedAt = :now, " +
          "#plan = if_not_exists(#plan, :freePlan)",
        ConditionExpression:
          "(attribute_not_exists(aiCreditsPeriod) OR aiCreditsPeriod <> :period) AND :cost <= :limit",
        ExpressionAttributeNames: { "#plan": "plan" },
        ExpressionAttributeValues: {
          ":cost": cost,
          ":period": period,
          ":now": now,
          ":freePlan": "free",
          ":limit": limit,
        },
      })
    );
    return { allowed: true, remaining: limit - cost, limit, period, plan };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    // Dönem zaten mevcut dönemle eşleşiyor (normal durum) -- ADIM 2.
  }

  const maxBeforeAdd = limit - cost;
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression:
          "ADD aiCreditsUsed :cost SET updatedAt = :now, #plan = if_not_exists(#plan, :freePlan)",
        ConditionExpression:
          "aiCreditsPeriod = :period AND " +
          "(attribute_not_exists(aiCreditsUsed) OR aiCreditsUsed <= :maxBeforeAdd)",
        ExpressionAttributeNames: { "#plan": "plan" },
        ExpressionAttributeValues: {
          ":cost": cost,
          ":period": period,
          ":now": now,
          ":freePlan": "free",
          ":maxBeforeAdd": maxBeforeAdd,
        },
      })
    );
    return { allowed: true, remaining: maxBeforeAdd, limit, period, plan };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      const { Item: user } = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
      );
      const used = user?.aiCreditsPeriod === period ? (user.aiCreditsUsed || 0) : 0;
      throw new QuotaExceededError(Math.max(limit - used, 0), limit);
    }
    throw err;
  }
}

// Suno/Lyria isteği KALICI olarak reddedildiğinde rezerve edilen
// krediyi atomik ve TAM OLARAK BİR KEZ iade eder. Job kaydına bağlı
// (creditRefunded bayrağıyla) idempotency İÇİN transaction kullanır.
async function refundCredits(userId, jobId, cost, period) {
  if (!period) return false; // eski/eksik kayıt -- iade edilecek dönem bilgisi yok
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { userId },
              UpdateExpression: "ADD aiCreditsUsed :negCost SET updatedAt = :now",
              ConditionExpression: "aiCreditsPeriod = :period AND aiCreditsUsed >= :cost",
              ExpressionAttributeValues: {
                ":negCost": -cost,
                ":cost": cost,
                ":period": period,
                ":now": new Date().toISOString(),
              },
            },
          },
          {
            Update: {
              TableName: JOBS_TABLE_NAME,
              Key: { jobId },
              UpdateExpression: "SET creditRefunded = :true",
              ConditionExpression:
                "attribute_not_exists(creditRefunded) OR creditRefunded = :false",
              ExpressionAttributeValues: { ":true": true, ":false": false },
            },
          },
        ],
      })
    );
    return true;
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      // Ya dönem zaten değişmiş (iade edilecek bir şey kalmamış -- yeni
      // döneme rastgele kredi eklemek YANLIŞ olurdu, bilerek atlanıyor)
      // ya da bu job için iade DAHA ÖNCE yapılmış (idempotency). İkisi
      // de zararsız.
      console.warn(
        `Kredi iadesi atlandı (job ${jobId}): dönem değişmiş olabilir ya da zaten iade edilmiş.`
      );
      return false;
    }
    throw err;
  }
}

// YENİ: generate.js'in KENDİ isteği içindeki telafi-edici iade yolu
// için (kredi rezerve edildi ama job kaydı/SQS yazımı BAŞARISIZ oldu,
// yani ortada iade edilecek bir JOB KAYDI bile yok). refundCredits'in
// job-bayrağına bağlı transaction'ından KASITLI olarak FARKLI ve daha
// basit: tek bir koşullu ADD. İdempotency burada job'a değil, bu
// fonksiyonun SADECE senkron generate.js hata yakalayıcısından, işlem
// başına EN FAZLA BİR KEZ çağrılmasına dayanıyor -- worker'ın
// stale-claim sonrası tekrar deneme riskiyle KARIŞTIRILMAMALI (o risk
// SADECE gerçek job'lar için var, bu yol hiç job oluşmadığında devreye
// giriyor).
async function refundCreditsStandalone(userId, cost, period) {
  if (!period) return false;
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression: "ADD aiCreditsUsed :negCost SET updatedAt = :now",
        ConditionExpression: "aiCreditsPeriod = :period AND aiCreditsUsed >= :cost",
        ExpressionAttributeValues: {
          ":negCost": -cost,
          ":cost": cost,
          ":period": period,
          ":now": new Date().toISOString(),
        },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

module.exports = {
  reserveCredits,
  refundCredits,
  refundCreditsStandalone,
  QuotaExceededError,
  getPlanContext,
};
