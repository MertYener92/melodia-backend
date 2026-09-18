const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { limitForPlan, currentPeriodKey } = require("./creditPlans");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
// YENİ (jeton istismarı düzeltmesi -- /quota ekranının yanlış "1 jeton
// var" göstermesi sorunu): appleAuth.js/postConfirmation.js her girişte
// appleUserIdHash'i UsersTable'a yazıyor, ama FreeTrialLedgerTable'a
// SADECE generate.js sırasında (reserveCredits -> claimFreeTrialOrThrow)
// bakılıyordu -- yani kullanıcı hesabı silip aynı kimlikle yeniden
// açtığında /quota hâlâ "free, used 0, remaining 1" diyordu, gerçek
// engelleme ancak ilk üretim denemesinde ortaya çıkıyordu. Artık burada
// da (salt okunur bir GetItem ile, claimFreeTrialOrThrow'un yaptığı
// koşullu PutItem'a HİÇ dokunmadan, UsersTable'a hiçbir yazma yapmadan)
// aynı kontrolü yapıp remaining'i anlık olarak 0 gösteriyoruz. Tek
// kaynak (FreeTrialLedgerTable) otorite olarak kalıyor -- burada sadece
// OKUYORUZ, "tüketilmiş" durumunu ayrıca bir yere yazmıyoruz.
const FREE_TRIAL_LEDGER_TABLE_NAME = process.env.FREE_TRIAL_LEDGER_TABLE_NAME;

// DÜZELTME: Bu dosya daha önce kendi bağımsız (ve artık ESKİ/YANLIŞ)
// AI_CREDIT_LIMITS kopyasını kullanıyordu — pro_monthly'yi hâlâ 300
// sanıyordu, pro_weekly/pro_yearly'yi hiç tanımıyordu (bu ikisi için
// sessizce "free" limitine, yani pratik olarak sınırsıza düşüyordu).
// Artık generate.js ile AYNI ortak modülü (creditPlans.js) kullanıyor —
// bir daha birbirinden sapma riski yok.
exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;

  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );

  const now = new Date();
  const isExpired = user?.planExpiresAt && new Date(user.planExpiresAt) < now;
  const plan = isExpired ? "free" : user?.plan || "free";

  const limit = limitForPlan(plan);
  const currentPeriod = currentPeriodKey(plan, now);
  let used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  // YENİ: sadece "free" planda VE bu dönemde henüz hiç kullanım
  // yazılmamışsa (used === 0) kontrol etmeye değer -- pro planlarda ya
  // da zaten kullanılmış bir free hesapta bu ekstra DynamoDB okuması
  // gereksiz, atlanıyor.
  if (plan === "free" && used === 0 && user?.appleUserIdHash && FREE_TRIAL_LEDGER_TABLE_NAME) {
    try {
      const { Item: ledgerEntry } = await client.send(
        new GetCommand({
          TableName: FREE_TRIAL_LEDGER_TABLE_NAME,
          Key: { appleUserIdHash: user.appleUserIdHash },
        })
      );
      if (ledgerEntry) {
        used = limit; // bu kimlik daha önce ücretsiz denemesini kullanmış
      }
    } catch (err) {
      // BİLİNÇLİ: ledger okuması başarısız olsa bile /quota çağrısını
      // ASLA hataya düşürmüyoruz -- en kötü ihtimalle eski (yanlış
      // olabilecek) davranışa düşer, ama kullanıcı ekranı hiç açılmaz
      // hale gelmez. Gerçek engelleme zaten generate.js sırasında var.
      console.error("Free trial ledger kontrolü başarısız (quota yine de dönüyor):", err);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      plan,
      used,
      limit,
      remaining: limit - used,
      // YENİ (kredi paketleri): abonelik/ücretsiz deneme havuzundan
      // AYRI, süresi dolmayan, satın alınmış ekstra kredi bakiyesi.
      // Flutter tarafı toplam kullanılabilir krediyi (remaining +
      // bonusCredits) gösterecek.
      bonusCredits: user?.bonusCredits || 0,
      // YENİ (profil ekranı): appleAuth.js/postConfirmation.js
      // tarafından hesap İLK KEZ oluşturulduğunda yazılıyor. Bu
      // değişiklikten ÖNCE oluşturulmuş hesaplarda yok (null döner) --
      // Flutter tarafı bu durumda "Üye olma tarihi"ni göstermeyecek.
      createdAt: user?.createdAt || null,
      // YENİ (profil ekranı "Yenilenme tarihi"): verifySubscription.js/
      // appleNotifications.js tarafından yazılıyor, free planda null.
      planExpiresAt: user?.planExpiresAt || null,
    }),
  };
};