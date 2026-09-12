const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const fs = require("fs");
const path = require("path");
const {
  SignedDataVerifier,
  AppStoreServerAPIClient,
  Environment,
} = require("@apple/app-store-server-library");

const secretsClient = new SecretsManagerClient({});

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID;
const ISSUER_ID = process.env.APPLE_IAP_ISSUER_ID;
const KEY_ID = process.env.APPLE_IAP_KEY_ID;
const KEY_SECRET_ARN = process.env.APPLE_IAP_KEY_SECRET_ARN;
// Production'da ZORUNLU (App Store Connect > App Information > Apple ID,
// sayısal bir değer). Sandbox'ta gerekmiyor, boş bırakılabilir.
const APP_APPLE_ID = process.env.APPLE_APP_APPLE_ID
  ? Number(process.env.APPLE_APP_APPLE_ID)
  : undefined;
const ENVIRONMENT =
  process.env.APPLE_IAP_ENVIRONMENT === "Production"
    ? Environment.PRODUCTION
    : Environment.SANDBOX;

// Apple Root CA - G3 sertifikası. GİZLİ DEĞİL (herkese açık bir sertifika),
// repoya commitlemek güvenlik sorunu yaratmıyor. İndirme adresi:
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// Bu dosyayı indirip AYNEN bu isimle apple-root-certs/ klasörüne koy.
const APPLE_ROOT_CA_PATH = path.join(__dirname, "apple-root-certs", "AppleRootCA-G3.cer");

let _cachedPrivateKey = null;
let _cachedVerifier = null;
let _cachedApiClient = null;

async function getPrivateKey() {
  if (_cachedPrivateKey) return _cachedPrivateKey;
  const { SecretString } = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: KEY_SECRET_ARN })
  );
  _cachedPrivateKey = SecretString; // .p8 dosyasının içeriği (PEM metni), olduğu gibi
  return _cachedPrivateKey;
}

function getVerifier() {
  if (_cachedVerifier) return _cachedVerifier;
  const rootCA = fs.readFileSync(APPLE_ROOT_CA_PATH);
  _cachedVerifier = new SignedDataVerifier(
    [rootCA],
    true, // enableOnlineChecks: Apple'ın iptal (revocation) listesini de kontrol eder
    ENVIRONMENT,
    BUNDLE_ID,
    APP_APPLE_ID
  );
  return _cachedVerifier;
}

async function getApiClient() {
  if (_cachedApiClient) return _cachedApiClient;
  const privateKey = await getPrivateKey();
  _cachedApiClient = new AppStoreServerAPIClient(
    privateKey,
    KEY_ID,
    ISSUER_ID,
    BUNDLE_ID,
    ENVIRONMENT
  );
  return _cachedApiClient;
}

// Flutter'dan (satın alma sonrası) gelen TEK BİR işlemin (transaction) JWS
// imzasını doğrular ve içeriğini çözer. İmza geçersizse fırlatır.
async function verifyAndDecodeTransaction(signedTransactionInfo) {
  return getVerifier().verifyAndDecodeTransaction(signedTransactionInfo);
}

// Apple'ın webhook'undan (App Store Server Notifications V2) gelen üst
// seviye bildirim JWS'ini doğrular ve çözer.
async function verifyAndDecodeNotification(signedPayload) {
  return getVerifier().verifyAndDecodeNotification(signedPayload);
}

module.exports = {
  verifyAndDecodeTransaction,
  verifyAndDecodeNotification,
  getApiClient,
  Environment,
};