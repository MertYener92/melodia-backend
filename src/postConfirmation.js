const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USERS_TABLE_NAME = process.env.TABLE_NAME;
const FREE_TRIAL_LEDGER_TABLE_NAME = process.env.FREE_TRIAL_LEDGER_TABLE_NAME;

// YENİ (jeton istismarı düzeltmesi — e-posta/şifre boşluğu): appleAuth.js
// SADECE Apple ile girişi kapsıyordu. Flutter tarafında (auth_service.dart
// -> signUp) e-posta/şifre ile kayıt DOĞRUDAN Cognito'nun ham HTTP API'sine
// gidiyor, backend'e HİÇ uğramıyor -- appleAuth.js'deki appleUserIdHash
// yazma adımı bu yol için ASLA çalışmıyordu, dolayısıyla
// creditReservation.js'deki claimFreeTrialOrThrow da devreye giremiyordu
// (appleUserIdHash yoksa kontrol sessizce atlanıyor).
//
// ÇÖZÜM: Cognito User Pool'un kendi "PostConfirmation" tetikleyicisi --
// bu, e-posta doğrulama kodu onaylandığında (ConfirmSignUp) HANGİ
// CLIENT'TAN gelirse gelsin, Cognito tarafından OTOMATİK ve ATLANAMAZ
// şekilde çalışır. appleAuth.js'in appleUserId'si yerine burada e-postanın
// kendisini (hesap silinse bile Apple ID gibi "sabit" tek kimlik --
// kullanıcı aynı e-postayı tekrar kullanmadıkça zaten yeni bir hesap
// açamaz) hash'leyip AYNI FreeTrialLedgerTable'a yazıyoruz. Tablo adı
// yanıltıcı (Apple'a özel gibi duruyor) ama anahtar alanı genel bir hash
// olduğu için hem Apple hem e-posta kimlikleri aynı tabloda, çakışma
// riski olmadan (SHA-256 hash çakışması pratikte imkansız) bir arada
// tutulabiliyor -- yeni bir tablo/migrasyon gerekmiyor.
exports.handler = async (event) => {
  // Sadece YENİ KAYIT sonrası e-posta onayında çalışsın -- Cognito bu
  // triggeri "şifremi unuttum" akışında da (PostConfirmation_ConfirmForgotPassword)
  // tetikleyebiliyor, o durumda burada hiçbir şey yapmamalıyız.
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
    return event;
  }

  try {
    const userId = event.request.userAttributes.sub;
    const email = (event.request.userAttributes.email || event.userName || "").toLowerCase().trim();
    if (!userId || !email) return event;

    const emailHash = crypto.createHash("sha256").update(email).digest("hex");

    // appleAuth.js'deki appleUserIdHash yazma adımıyla BİREBİR AYNI desen
    // -- giriş/kayıt akışını ASLA engellememek için hata olsa bile yutuluyor.
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: USERS_TABLE_NAME,
          Key: { userId },
          UpdateExpression: "SET appleUserIdHash = if_not_exists(appleUserIdHash, :hash)",
          ExpressionAttributeValues: { ":hash": emailHash },
        })
      );
    } catch (hashErr) {
      console.error("emailHash yazılamadı (kayıt yine de devam ediyor):", hashErr);
      return event;
    }

    // YENİ: appleAuth.js'in aksine, burada BEKLEMİYORUZ -- bu Apple
    // akışında "hash'i yaz, gerçek engelleme reserveCredits/generate.js
    // sırasında olur" deseniyle aynı. claimFreeTrialOrThrow zaten
    // reserveCredits içinde çağrılıyor ve bu emailHash'i bulacak --
    // burada AYRICA bir claim denemesi yapmıyoruz, tekrarlı/çelişkili
    // bir yazım riski yaratmamak için tek sorumluluk tek yerde kalsın
    // istiyoruz (reserveCredits).
  } catch (err) {
    // BİLİNÇLİ: bu adım tamamen başarısız olsa bile kayıt/girişi ASLA
    // engellemiyoruz -- Cognito trigger'ı hata fırlatırsa kullanıcının
    // KAYDINI TAMAMEN İPTAL EDER, bu çok daha kötü bir kullanıcı deneyimi
    // olurdu. Bu koruma en kötü ihtimalle o kullanıcı için devreye
    // giremez (aşağı yönlü, kabul edilebilir bir risk).
    console.error("postConfirmation hatası (kayıt yine de devam ediyor):", err);
  }

  return event;
};
