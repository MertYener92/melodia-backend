const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const SUNO_BASE_URL = "https://api.sunoapi.org";
const SUNO_API_KEY = process.env.SUNO_API_KEY;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const RATE_LIMIT_TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME;

// ---------------------------------------------------------------------
// Merkezi, hesap-geneli Suno rate limiter + backoff.
//
// YENİ (FINAL PRODUCTION HARDENING — madde 5): "bizim kendi hesap-geneli
// penceremizde yer bekleme" ve "Suno'nun kendisi 429/5xx döndürünce
// yeniden deneme" artık İKİ TAMAMEN AYRI, kendi sınırına sahip döngü.
// Önceki tasarımda ikisi AYNI 3-denemelik bütçeyi paylaşıyordu -- yoğun
// eşzamanlılıkta sadece pencere beklemesi bile bu bütçeyi tüketip gerçek
// bir Suno hatasını hiç deneyemeden vazgeçilmesine yol açabiliyordu.
// Şimdi:
//   - waitForProviderSlot(): SADECE bizim DynamoDB sayacımızda yer açılana
//     kadar bekler (Suno'ya HİÇBİR istek atmadan). Kendi üst sınırı
//     (MAX_WAIT_MS) var; aşılırsa ProviderRateLimitError fırlatır.
//   - fetchWithRetry(): SADECE Suno'nun asıl HTTP cevabına (429/5xx/ağ
//     hatası) karşı, kendi bağımsız backoff bütçesiyle (MAX_HTTP_ATTEMPTS)
//     yeniden dener.
// sunoFetch bu ikisini SIRAYLA çağırır -- biri diğerinin bütçesini
// YEMEZ.
// ---------------------------------------------------------------------
const PROVIDER_WINDOW_SECONDS = 10;
const PROVIDER_WINDOW_LIMIT = 16; // Suno'nun gerçek limitinin (~20/10sn) altında, güvenlik payı
const PROVIDER_RATE_LIMIT_KEY = "provider#sunoapi.org";
const MAX_WAIT_MS = 8000; // pencere beklemesi için üst sınır

class ProviderRateLimitError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ProviderRateLimitError";
    this.providerRateLimited = true;
  }
}

async function reserveProviderSlot() {
  const windowStart =
    Math.floor(Date.now() / 1000 / PROVIDER_WINDOW_SECONDS) * PROVIDER_WINDOW_SECONDS;
  const key = `${PROVIDER_RATE_LIMIT_KEY}#${windowStart}`;

  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: RATE_LIMIT_TABLE_NAME,
      Key: { rateLimitKey: key },
      UpdateExpression: "ADD requestCount :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
      ExpressionAttributeValues: {
        ":one": 1,
        ":ttl": windowStart + PROVIDER_WINDOW_SECONDS + 60,
      },
      ReturnValues: "UPDATED_NEW",
    })
  );

  const count = Attributes.requestCount;
  const msUntilNextWindow = (windowStart + PROVIDER_WINDOW_SECONDS) * 1000 - Date.now();
  return { allowed: count <= PROVIDER_WINDOW_LIMIT, msUntilNextWindow: Math.max(msUntilNextWindow, 250) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs) {
  return baseMs + Math.floor(Math.random() * baseMs * 0.3);
}

// SADECE bizim hesap-geneli sayacımızda yer açılana kadar bekler.
// Suno'ya HİÇ istek atmaz. DynamoDB'nin kendisi throttle olursa (tek
// paylaşılan anahtar, hot-partition riski) "fail-open" yapar: isteği
// engellemek yerine izin verir, Suno'nun kendi 429 koruması (fetchWithRetry)
// ikinci savunma hattı olarak devrede kalır.
async function waitForProviderSlot() {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (true) {
    let reservation;
    try {
      reservation = await reserveProviderSlot();
    } catch (err) {
      console.warn("Suno rate limiter sayaç hatası (fail-open, isteğe izin veriliyor):", err.message);
      return;
    }

    if (reservation.allowed) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // YENİ (madde 10 — gözlemlenebilirlik): CloudWatch Logs Metric
      // Filter bu ASCII etiketi yakalıyor (bkz. template.yaml). Değiştirirsen
      // filtreyi de güncellemen gerekir.
      console.warn(
        `PROVIDER_RATE_LIMIT_EXHAUSTED limit=${PROVIDER_WINDOW_LIMIT}/${PROVIDER_WINDOW_SECONDS}s maxWaitMs=${MAX_WAIT_MS}`
      );
      throw new ProviderRateLimitError(
        `Suno hesap geneli hız sınırına takıldı (${PROVIDER_WINDOW_LIMIT}/${PROVIDER_WINDOW_SECONDS}sn), ${MAX_WAIT_MS}ms içinde yer açılmadı.`
      );
    }
    await sleep(Math.min(reservation.msUntilNextWindow, remaining, 4000));
  }
}

async function rawSunoFetch(path, options) {
  const response = await fetch(`${SUNO_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUNO_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  const ok = response.ok && data.code === 200;
  if (!ok) {
    console.error(`Suno API hatası — path=${path}, HTTP ${response.status}, cevap:`, JSON.stringify(data));
  }
  return { ok, status: response.status, data };
}

// SADECE Suno'nun asıl HTTP cevabına karşı, KENDİ bağımsız backoff
// bütçesiyle çalışır -- waitForProviderSlot'un bütçesinden TAMAMEN
// AYRI. Ağ hatası/timeout'ta İSTİSNA FIRLATIR (çağıran taraf, ör.
// jobLifecycle.js, bunu "geçici hata -> SQS retry" olarak ele alır).
// Suno'nun kendi 429/5xx'i tüm denemelerden sonra hâlâ sürüyorsa,
// normal {ok:false,status,data} DÖNER (fırlatmaz) -- çağıranlar zaten
// isTransientSunoError(status) ile kalıcı/geçici ayrımını kendileri
// yapıyor, bu davranış DEĞİŞTİRİLMEDİ.
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

async function fetchWithRetry(path, options) {
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await rawSunoFetch(path, options);
    } catch (err) {
      if (attempt === MAX_HTTP_ATTEMPTS) throw err;
      await sleep(jitter(RETRY_BASE_MS * 2 ** (attempt - 1)));
      continue;
    }

    lastResult = result;
    const isTransient = result.status === 429 || result.status >= 500;
    if (!result.ok && isTransient && attempt < MAX_HTTP_ATTEMPTS) {
      await sleep(jitter(RETRY_BASE_MS * 2 ** (attempt - 1)));
      continue;
    }

    return result;
  }

  return lastResult;
}

// Tüm Suno çağrılarının (processSunoGeneration.js, status.js,
// lyrics.js, lyricsStatus.js, lyricsTimestamps.js) geçtiği TEK giriş
// noktası. Önce hesap-geneli pencerede yer bekler (waitForProviderSlot),
// SONRA asıl HTTP çağrısını kendi backoff'uyla yapar (fetchWithRetry).
async function sunoFetch(path, options = {}) {
  await waitForProviderSlot();
  return fetchWithRetry(path, options);
}

module.exports = { sunoFetch, ProviderRateLimitError };
