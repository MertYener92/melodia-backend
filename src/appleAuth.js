const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const cognito = new CognitoIdentityProviderClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USER_POOL_ID = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID;
// YENİ (jeton istismarı düzeltmesi -- "hesabı sil, aynı Apple kimliğiyle
// tekrar kaydol, yeniden ücretsiz jeton kazan" döngüsünü kapatmak için).
// TABLE_NAME zaten Globals'tan geliyor (bkz. template.yaml), yeni bir
// env var gerekmedi.
const USERS_TABLE_NAME = process.env.TABLE_NAME;

const client = jwksClient({ jwksUri: "https://appleid.apple.com/auth/keys" });

function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

async function verifyAppleToken(identityToken) {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded) throw new Error("Geçersiz Apple token.");
  const publicKey = await getSigningKey(decoded.header.kid);
  return jwt.verify(identityToken, publicKey, {
    algorithms: ["RS256"],
    audience: APPLE_BUNDLE_ID,
    issuer: "https://appleid.apple.com",
  });
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { identityToken, email: appleProvidedEmail } = body;

    if (!identityToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "identityToken gerekli." }) };
    }

    const payload = await verifyAppleToken(identityToken);
    const appleUserId = payload.sub;
    const email = payload.email || appleProvidedEmail;
    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "E-posta bilgisi alınamadı." }) };
    }

    // ÖNEMLİ: UserPool'da UsernameAttributes: [email] ayarı var — Cognito
    // bu havuzda kullanıcı adının GERÇEK bir e-posta formatında olmasını
    // zorunlu kılıyor. Önceden burada "apple_<appleUserId>" gibi e-posta
    // olmayan bir kullanıcı adı kullanılıyordu, bu da Cognito tarafından
    // "Username should be an email" hatasıyla reddediliyordu.
    //
    // DÜZELTME: e-postanın kendisini kullanıcı adı olarak kullanıyoruz.
    // Bunun doğal bir sonucu var: aynı e-posta ile daha önce
    // şifre/normal kayıt olan bir kullanıcı, Apple ile giriş yaptığında
    // AYNI hesaba (aynı Cognito 'sub', dolayısıyla aynı jeton bakiyesi)
    // giriş yapmış olur — bu, tek kişi/tek hesap için doğru davranış.
    const username = email.toLowerCase();

    let userExists = true;
    try {
      await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    } catch (err) {
      if (err.name === "UserNotFoundException") userExists = false;
      else throw err;
    }

    const randomPassword = `Ap!${appleUserId.slice(0, 20)}${Date.now()}`;

    if (!userExists) {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          MessageAction: "SUPPRESS",
        })
      );
    }

    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: randomPassword,
        Permanent: true,
      })
    );

    const authResult = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: USER_POOL_ID,
        ClientId: USER_POOL_CLIENT_ID,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: username, PASSWORD: randomPassword },
      })
    );

    // YENİ (jeton istismarı düzeltmesi): Apple'ın bu uygulama+Apple ID
    // kombinasyonu için verdiği SABİT kimliği (appleUserId -- hesap
    // silinip yeniden oluşturulsa bile ASLA DEĞİŞMEZ, Cognito'nun kendi
    // rastgele ürettiği 'sub'ın aksine) hash'leyip bu girişle ilişkili
    // UsersTable satırına yazıyoruz. Bu hash, deleteAccount.js'nin
    // SİLMEDİĞİ ayrı bir tabloda (melodia-free-trial-ledger, bkz.
    // creditReservation.js) "bu kimlik ücretsiz denemesini kullandı mı"
    // takibi için kullanılacak. SADECE opak bir hash yazılıyor -- isim,
    // e-posta ya da başka bir kişisel veri YOK. Cognito'nun az önce
    // KENDİSİNİN ürettiği IdToken'ı çözüyoruz (tekrar doğrulamaya gerek
    // yok, zaten güvenilir kaynak) -- buradan hedef UsersTable
    // satırının userId'sini (Cognito 'sub') alıyoruz.
    try {
      const appleUserIdHash = crypto.createHash("sha256").update(appleUserId).digest("hex");
      const idTokenPayload = jwt.decode(authResult.AuthenticationResult.IdToken);
      const cognitoUserId = idTokenPayload?.sub;
      if (cognitoUserId) {
        await dynamo.send(
          new UpdateCommand({
            TableName: USERS_TABLE_NAME,
            Key: { userId: cognitoUserId },
            // if_not_exists: bu satırda zaten bir hash varsa (normal --
            // her girişte AYNI değer olurdu zaten) üzerine yazmaya
            // gerek yok, gereksiz bir yazma önleniyor.
            UpdateExpression: "SET appleUserIdHash = if_not_exists(appleUserIdHash, :hash)",
            ExpressionAttributeValues: { ":hash": appleUserIdHash },
          })
        );
      }
    } catch (hashErr) {
      // BİLİNÇLİ: bu adım BAŞARISIZ olsa bile girişin kendisi
      // engellenmemeli -- kullanıcı yine de giriş yapabilsin, sadece bu
      // durumda (çok nadir bir DynamoDB hatası) jeton-istismarı koruması
      // o kullanıcı için devreye girmeyebilir (aşağı yönlü, kabul
      // edilebilir bir risk -- girişin kendisini engellemekten çok
      // daha az kötü).
      console.error("appleUserIdHash yazılamadı (giriş yine de devam ediyor):", hashErr);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        idToken: authResult.AuthenticationResult.IdToken,
        refreshToken: authResult.AuthenticationResult.RefreshToken,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};