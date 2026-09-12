const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID;

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