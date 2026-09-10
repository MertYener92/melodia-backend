// melodia-video/src/cloudfrontSigner.js ile aynı mantık -- stack'ler
// birbirinden izole olduğu için (mevcut proje felsefesi) burada ayrı bir
// key-pair ve ayrı bir CloudFront distribution kullanılıyor.

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getSignedUrl } = require("@aws-sdk/cloudfront-signer");

const secretsClient = new SecretsManagerClient({});

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID;
const PRIVATE_KEY_SECRET_ARN = process.env.CLOUDFRONT_PRIVATE_KEY_SECRET_ARN;

let _cachedPrivateKey = null;

async function getPrivateKey() {
  if (_cachedPrivateKey) return _cachedPrivateKey;
  const { SecretString } = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: PRIVATE_KEY_SECRET_ARN })
  );
  try {
    const parsed = JSON.parse(SecretString);
    _cachedPrivateKey = parsed.privateKey || SecretString;
  } catch {
    _cachedPrivateKey = SecretString;
  }
  return _cachedPrivateKey;
}

async function signMediaUrl(objectKey, expiresInSeconds = 3600) {
  const privateKey = await getPrivateKey();
  const url = `https://${CLOUDFRONT_DOMAIN}/${objectKey}`;
  const dateLessThan = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  return getSignedUrl({ url, keyPairId: KEY_PAIR_ID, privateKey, dateLessThan });
}

module.exports = { signMediaUrl };