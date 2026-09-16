// PROFESYONEL JETON DEFTERİ (ledger) — melodia-video ve melodia-music-spec
// AYNI mantığı kendi Node/Python kopyalarında tutar (creditLedger.js /
// credit_ledger.py), çünkü Lambda paketleri repo sınırları arasında kod
// paylaşamıyor. TÜM SAYILAR (limitler, maliyetler) tek kaynaktan (bu
// stack'in CFN parametreleri) geliyor — bkz. creditPlans.js. Sadece bu
// küçük orkestrasyon dosyası kopyalanıyor, riskin büyük kısmı (sabit
// değerlerin sapması) böylece ortadan kalkmış oluyor.
//
// İKİ KOVALI BAKİYE (Apple App Store kuralına uyum için ŞART):
//  - "plan payı"  : haftalık/aylık sıfırlanan, ABONELİĞİN bir parçası.
//                   Apple: "Subscriptions may include consumable
//                   credits..." — bu paternin kendisi tamamen onaylı.
//  - "kalıcı bakiye" (UsersTable.creditBalance): tek seferlik SATIN
//                   ALINAN (consumable IAP) jeton paketi. Apple:
//                   "Any credits ... purchased via in-app purchase may
//                   not expire" — bu yüzden bu bakiye ASLA sıfırlanmaz,
//                   dönem değişse de aynen kalır.
// Düşüm SIRASI: önce plan payından (zaten "bedava", dönem bitince
// kullanılmazsa gidiyor), o yetmezse kalıcı bakiyeden. Bu sıralama,
// satın alınmış jetonun mümkün olduğunca geç harcanmasını sağlayıp
// Apple'ın "asla süresi dolmaz" kuralına fiilen de saygı gösteriyor.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { limitForPlan, currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USAGE_TABLE_NAME = process.env.CREDIT_USAGE_TABLE_NAME;
const USERS_TABLE_NAME = process.env.TABLE_NAME || process.env.USERS_TABLE_NAME;

// Kullanıcının şu anki plan/dönem + iki bakiyesini okur. SALT OKUNUR --
// hiçbir yazma yapmaz, bu yüzden kendi başına yarış durumuna karşı
// savunmasız değil (sadece önizleme/ön-kontrol amaçlı).
async function getBalance(userId) {
  const { Item: user } = await client.send(
    new GetCommand({ TableName: USERS_TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  // SAVUNMA KATMANI: Apple webhook'u gecikse/gelmese de planExpiresAt
  // burada da kontrol ediliyor (generate.js'teki mevcut desenle aynı).
  const isExpired = user?.planExpiresAt && new Date(user.planExpiresAt) < now;
  const plan = isExpired ? "free" : user?.plan || "free";
  const period = currentPeriodKey(plan, now);
  const planLimit = limitForPlan(plan);

  const { Item: usage } = await client.send(
    new GetCommand({ TableName: USAGE_TABLE_NAME, Key: { userId, period } })
  );
  const planUsed = usage?.used || 0;
  const planRemaining = Math.max(planLimit - planUsed, 0);
  const topUpBalance = user?.creditBalance || 0;

  return {
    plan,
    period,
    planLimit,
    planUsed,
    planRemaining,
    topUpBalance,
    totalAvailable: planRemaining + topUpBalance,
  };
}

// Pahalı dış servis isteğinden (Suno/Lyria/Anthropic/fal.ai) ÖNCE hızlı,
// ucuz bir ön-kontrol. Kesin garanti chargeCredits()'teki atomik işlemden
// gelir — bu sadece kullanıcıya erken ve net bir "jeton yetersiz" mesajı
// vermek için, kesinlik garantisi TAŞIMAZ (iki eşzamanlı istek arada
// sıyırabilir; onu chargeCredits engeller).
async function canAfford(userId, cost) {
  const balance = await getBalance(userId);
  return { allowed: balance.totalAvailable >= cost, ...balance };
}

// GERÇEK, ATOMİK, TEK SEFERLİK DÜŞÜM.
//
// lock: { tableName, key } — bu aksiyon için "jeton zaten düşüldü mü?"
// kilidinin tutulacağı yer. Şarkı/video için kendi job/project kaydı
// (jobId/projectId zaten benzersiz), music-spec gibi kalıcı kaydı
// olmayan aksiyonlar için IdempotencyTable kullanılır. AYNI lock ile
// iki kez çağrılırsa (SQS yeniden teslimatı, network retry, worker'ın
// çökmesi sonrası stale-reclaim, ne olursa olsun) İKİNCİ çağrı jetonu
// TEKRAR DÜŞMEZ.
async function chargeCredits({ userId, cost, lock }) {
  // 1) İDEMPOTENCY KİLİDİ — koşullu update: SADECE "creditsCharged"
  // alanı henüz yoksa başarılı olur.
  try {
    await client.send(
      new UpdateCommand({
        TableName: lock.tableName,
        Key: lock.key,
        UpdateExpression: "SET creditsCharged = :true, creditsChargedAt = :now",
        ConditionExpression: "attribute_not_exists(creditsCharged)",
        ExpressionAttributeValues: { ":true": true, ":now": new Date().toISOString() },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { charged: false, reason: "already_charged" };
    }
    throw err;
  }

  // 2) Kilidi KAZANDIK -- artık güvenle, tam olarak bir kez düşüyoruz.
  //
  // DÜZELTME (yarış durumu): Önceki halde plan-payı ADD'i ve kalıcı-
  // bakiye SET'i İKİ AYRI, BİRBİRİNDEN BAĞIMSIZ istekti. fromPlan/
  // fromTopUp SPLİT'i (hangi kovadan ne kadar düşüleceği) bir "önce oku"
  // (getBalance) sonucuna göre hesaplanıyordu -- aynı kullanıcının İKİ
  // FARKLI aksiyonu (ör. aynı anda hem şarkı hem video) neredeyse aynı
  // anda buraya girerse, ikisi de AYNI eski bakiyeyi görüp kendi payını
  // hesaplayabiliyordu. Sonuç: kalıcı bakiye teorik olarak eksiye
  // düşebiliyordu (VEYA plan payı limitin üzerine çıkabiliyordu).
  //
  // ÇÖZÜM: İki yazma artık TEK bir DynamoDB TRANSACTION'ı (TransactWriteItems)
  // içinde, İKİSİ DE KOŞULLU. Koşullardan biri bile tutmazsa (bakiye
  // arada değişmiş demektir) TÜM işlem geri alınır (all-or-nothing) --
  // KISMİ bir yazma asla olmaz. Bu durumda bakiyeyi TAZE baştan okuyup
  // split'i yeniden hesaplıyoruz ve tekrar deniyoruz (sınırlı sayıda).
  // Bu, DynamoDB'de "oku-değiştir-yaz" güvenliği için standart desendir.
  const MAX_CONTENTION_RETRIES = 5;
  let lastErr;
  for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt++) {
    const balance = await getBalance(userId);
    const fromPlan = Math.min(balance.planRemaining, cost);
    const fromTopUp = cost - fromPlan;

    const transactItems = [];
    if (fromPlan > 0) {
      // Koşul: bu ADD'den SONRA plan kullanımı limiti AŞMAYACAK. Bakiye
      // okunduğumuzdan beri değiştiyse (başka bir eşzamanlı düşüm oldu)
      // bu koşul tutmaz, transaction TAMAMEN iptal olur.
      transactItems.push({
        Update: {
          TableName: USAGE_TABLE_NAME,
          Key: { userId, period: balance.period },
          UpdateExpression: "ADD used :fromPlan",
          ConditionExpression: "attribute_not_exists(used) OR used <= :maxUsedBefore",
          ExpressionAttributeValues: {
            ":fromPlan": fromPlan,
            ":maxUsedBefore": balance.planLimit - fromPlan,
          },
        },
      });
    }
    if (fromTopUp > 0) {
      // Koşul: kalıcı bakiye bu düşümü karşılamaya YETİYOR. Eksiye
      // düşme İHTİMALİ bile bu koşulla yapısal olarak ortadan kalkıyor.
      transactItems.push({
        Update: {
          TableName: USERS_TABLE_NAME,
          Key: { userId },
          UpdateExpression: "SET creditBalance = if_not_exists(creditBalance, :zero) - :fromTopUp",
          ConditionExpression: "attribute_not_exists(creditBalance) OR creditBalance >= :fromTopUp",
          ExpressionAttributeValues: { ":zero": fromTopUp, ":fromTopUp": fromTopUp },
        },
      });
    }

    if (transactItems.length === 0) {
      return { charged: true, fromPlan: 0, fromTopUp: 0 };
    }

    try {
      await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
      return { charged: true, fromPlan, fromTopUp };
    } catch (err) {
      if (err.name === "TransactionCanceledException") {
        // Yarış tespit edildi -- HİÇBİR ŞEY yazılmadı (transaction'ın
        // doğası budur), bakiyeyi taze okuyup tekrar dene.
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  // Buraya gelmek pratikte imkansıza yakın (5 kez üst üste aynı
  // kullanıcının eşzamanlı çakışması) -- yine de sessizce yutmak yerine
  // açıkça hata fırlatıyoruz, çağıran taraf (worker) bunu SQS retry'a
  // bırakır.
  throw lastErr || new Error("chargeCredits: çözülemeyen çakışma");
}

module.exports = { getBalance, canAfford, chargeCredits };
