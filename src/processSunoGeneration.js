// ---------------------------------------------------------------------
// YENİ (FINAL PRODUCTION HARDENING — madde 8): Suno artık KENDİ ayrı SQS
// kuyruğunda (MusicGenerationQueue) ve kendi Lambda worker'ında işleniyor
// -- Lyria'dan (processLyriaGeneration.js) tamamen bağımsız. Lyria
// job'ları senkron olarak Lambda'yı ~150sn'e kadar açık tuttuğu için,
// eskiden ikisi AYNI fonksiyonu/kuyruğu paylaşırken uzun süren bir Lyria
// job'ı Suno'nun hızlı submission akışının concurrency slotlarını
// tüketebiliyordu. Artık bu imkansız -- her ikisinin kendi
// ScalingConfig.MaximumConcurrency'si var (bkz. template.yaml).
//
// Ortak job-lifecycle mantığı (claim/lock, markFailed/markReady,
// STALE_CLAIM_MS) jobLifecycle.js'de -- bu worker sadece Suno'ya ÖZGÜ
// kısmı (asıl /generate çağrısı) içerir.
//
// DEĞİŞTİ (madde 1 — atomik kredi rezervasyonu): kredi ARTIK BURADA
// DÜŞÜLMÜYOR -- generate.js, job kuyruğa yazılmadan ÖNCE zaten atomik
// olarak rezerve etti. Bu worker'ın kredi ile tek ilişkisi, KALICI bir
// hatada jobLifecycle.markFailed üzerinden o rezervasyonu İADE etmek.
// ---------------------------------------------------------------------

const { sunoFetch } = require("./sunoProxy");
const { initSunoStatusCache } = require("./sunoStatusCache");
const {
  claimJob,
  releaseJobForRetry,
  markFailed,
  markReady,
} = require("./jobLifecycle");
const { signMediaUrl } = require("./cloudfrontSigner");

// Normal üretim ve remix AYNI modeli kullanır -- maliyet ölçümü (üretim
// başına ~0,07$) bu modele göre yapıldı. NOT: Suno dokümanı V5_5'i
// "deprecated" olarak işaretliyor; model değişirse maliyet yeniden ölçülmeli.
const SUNO_MODEL = "V5_5";

// YENİ (Remix): Suno kaynak sesi bu linkten indiriyor. Kuyruk/rate limit
// gecikmeleri ve Suno'nun kendi kuyruğu için bol pay bırakıyoruz.
const REMIX_SOURCE_URL_TTL_SECONDS = 2 * 60 * 60;

// HTTP 5xx ve 429 (rate limit) = geçici, yeniden denemeye değer.
// Diğer her şey (400 gibi parametre/içerik reddi) = kalıcı, tekrar
// denemenin anlamı yok — job'u direkt "failed" işaretliyoruz (+ kredi
// iadesi, bkz. jobLifecycle.markFailed).
function isTransientSunoError(status) {
  return status >= 500 || status === 429;
}

// Job'a göre Suno isteğini hazırlar: normal üretim -> /generate,
// remix -> /generate/upload-cover (aynı callback/status akışı).
async function buildSunoRequest(job) {
  const { payload } = job;
  const common = {
    customMode: true,
    instrumental: payload.instrumental,
    style: payload.style,
    title: payload.title,
    model: SUNO_MODEL,
    callBackUrl: job.callBackUrl,
  };
  // Custom mode'da prompt = şarkı sözü; enstrümantalde gönderilmez.
  if (!payload.instrumental) common.prompt = payload.lyrics;

  if (payload.operation === "cover") {
    const uploadUrl = await signMediaUrl(payload.sourceAudioKey, REMIX_SOURCE_URL_TTL_SECONDS);
    return { path: "/api/v1/generate/upload-cover", body: { ...common, uploadUrl } };
  }
  return { path: "/api/v1/generate", body: { ...common, prompt: payload.lyrics } };
}

exports.handler = async (event) => {
  // BatchSize=1 olduğu için normalde tek kayıt gelir, yine de döngüyle yazıyoruz.
  for (const record of event.Records) {
    const { jobId } = JSON.parse(record.body);

    const job = await claimJob(jobId);
    if (!job) {
      console.log(`Job ${jobId} zaten işlenmiş/işlenmekte veya bulunamadı, atlanıyor.`);
      continue;
    }

    try {
      const request = await buildSunoRequest(job);
      const { ok, status, data } = await sunoFetch(request.path, {
        method: "POST",
        body: JSON.stringify(request.body),
      });

      if (!ok) {
        if (isTransientSunoError(status)) {
          await releaseJobForRetry(jobId);
          // Hatayı fırlat: SQS bu mesajı otomatik yeniden dener; maxReceiveCount
          // (3) aşılırsa mesaj kendiliğinden MusicGenerationDLQ'ya düşer.
          throw new Error(`Suno geçici hata döndürdü: HTTP ${status} — ${data?.msg || "bilinmiyor"}`);
        }

        // Kalıcı hata — kredi rezervasyonu iade edilir (bkz. markFailed),
        // tekrar denemeye gerek yok.
        console.error(`Job ${jobId} kalıcı olarak başarısız: HTTP ${status}`, JSON.stringify(data));
        await markFailed(job, data?.msg || "Şarkı üretimi başlatılamadı.");
        continue; // mesaj başarıyla "işlendi" sayılır, SQS'ten silinir
      }

      // Suno isteği kabul etti -- kredi zaten generate.js'de rezerve
      // edilmişti, burada TEKRAR düşülmüyor. Sadece job'ı "ready"
      // (submission başarılı, sonuç webhook ile gelecek) işaretliyoruz
      // ve webhook/cache alanlarını PENDING'e kuruyoruz.
      await markReady(jobId, data.data.taskId);
      await initSunoStatusCache(jobId);
    } catch (err) {
      console.error(`Job ${jobId} işleme hatası:`, err);
      throw err; // SQS retry/DLQ mekanizmasını tetikle
    }
  }
};
