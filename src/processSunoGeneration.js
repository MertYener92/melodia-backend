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

// HTTP 5xx ve 429 (rate limit) = geçici, yeniden denemeye değer.
// Diğer her şey (400 gibi parametre/içerik reddi) = kalıcı, tekrar
// denemenin anlamı yok — job'u direkt "failed" işaretliyoruz (+ kredi
// iadesi, bkz. jobLifecycle.markFailed).
function isTransientSunoError(status) {
  return status >= 500 || status === 429;
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
      const { ok, status, data } = await sunoFetch("/api/v1/generate", {
        method: "POST",
        body: JSON.stringify({
          customMode: true,
          instrumental: job.payload.instrumental,
          prompt: job.payload.lyrics,
          style: job.payload.style,
          title: job.payload.title,
          model: "V5_5",
          callBackUrl: job.callBackUrl,
        }),
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
