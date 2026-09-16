// ---------------------------------------------------------------------
// Suno'nun webhook'unu işleyen fonksiyon. Suno'nun bize gönderdiği
// sonucu (ya da hatayı) doğrudan GenerationJobsTable'daki job kaydına
// yazar -- status.js normal şartlarda Suno'yu HİÇ aramaz, doğrudan bu
// kaydı okur (bkz. status.js, sunoStatusCache.js).
//
// Suno'nun callBackUrl format ve davranışı (docs.sunoapi.org/suno-api/
// generate-music-callbacks):
//  - code=200 + data.callbackType: "text" (söz hazır) / "first" (ilk
//    klip hazır) / "complete" (tüm klipler hazır) -- ÜÇÜ DE, task
//    tamamlanana kadar AYRI AYRI POST'lar olarak gelebilir.
//  - code!=200 + data.callbackType: "error" -- üretim kalıcı olarak
//    başarısız.
//  - AYNI taskId için birden fazla callback (ör. Suno'nun kendi 3
//    deneme mekanizması) gelebilir -- işlem İDEMPOTENT olmalı.
//
// YENİ (FINAL PRODUCTION HARDENING — madde 6, webhook authentication):
// sunoapi.org'un dokümantasyonu HMAC/imza tabanlı bir webhook doğrulama
// mekanizması SUNMUYOR (kendileri sadece "kaynağı doğrula" diyor,
// somut bir araç vermiyor -- bu doğrulandı). Bu yüzden biz KENDİ
// callBackUrl'imizi oluştururken (generate.js) içine paylaşılan, rastgele
// bir secret'ı query param olarak gömüyoruz. Bu fonksiyon her istekte
// bu secret'ı SABİT ZAMANLI (timing-attack'e dayanıklı) karşılaştırma
// ile doğruluyor -- eşleşmezse istek DynamoDB'ye HİÇ dokunmadan reddedilir.
//
// LOGLAMA GÜVENLİĞİ: Bu dosyanın hiçbir yerinde event.queryStringParameters,
// tam callBackUrl ya da secret'ın kendisi LOGLANMIYOR -- sadece jobId/
// taskId/durum etiketleri. API Gateway tarafında da bu stage için
// AccessLogSetting/execution logging AÇIK DEĞİL (template.yaml'da
// tanımlı değil) -- yani query string (secret dahil) hiçbir CloudWatch
// Log grubuna otomatik olarak yazılmıyor.
//
// REPLAY/DUPLICATE KORUMASI: (a) secret olmadan hiçbir istek işlenmez
// -- yetkisiz/tekrar oynatılmış (replay) bir istek en azından secret'ı
// bilmeyen bir kaynaktan gelemez; (b) sunoStatusCache.js'teki monotonic
// rank koruması, AYNI secret'la gelen meşru ama sırasız/tekrar eden
// (ör. Suno'nun kendi 3-deneme mekanizmasından) callback'leri zaten
// zararsız bir no-op'a çeviriyor (bkz. writeSunoStatusCache).
// ---------------------------------------------------------------------

const crypto = require("crypto");
const {
  SUNO_STATUS,
  findJobByTaskId,
  writeSunoStatusCache,
  mapWebhookTracksToSunoData,
} = require("./sunoStatusCache");
const { refundCredits } = require("./creditReservation");

const SUNO_CALLBACK_SECRET = process.env.SUNO_CALLBACK_SECRET;

function sunoStatusForCallbackType(callbackType) {
  switch (callbackType) {
    case "text":
      return SUNO_STATUS.TEXT_SUCCESS;
    case "first":
      return SUNO_STATUS.FIRST_SUCCESS;
    case "complete":
      return SUNO_STATUS.SUCCESS;
    case "error":
    default:
      return SUNO_STATUS.GENERATE_AUDIO_FAILED;
  }
}

// Sabit zamanlı (timing-safe) karşılaştırma. crypto.timingSafeEqual
// FARKLI uzunluktaki buffer'larda istisna fırlatır -- bu istisnanın
// kendisi bile (varlığı/yokluğu) bir zamanlama sinyali taşıyabileceği
// için, önce HER İKİ tarafı da SABİT uzunluklu SHA-256 özetine
// çeviriyoruz; iki özet HER ZAMAN aynı uzunlukta olduğundan
// timingSafeEqual asla uzunluk istisnası fırlatmaz.
function secretMatches(provided) {
  if (!provided || !SUNO_CALLBACK_SECRET) return false;
  const providedDigest = crypto.createHash("sha256").update(String(provided)).digest();
  const expectedDigest = crypto.createHash("sha256").update(SUNO_CALLBACK_SECRET).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

exports.handler = async (event) => {
  // YENİ (madde 6): secret kontrolü EN BAŞTA, herhangi bir DynamoDB
  // erişiminden ÖNCE yapılır -- yetkisiz istekler için hiçbir iş
  // yapılmaz. NOT: event.queryStringParameters İÇERİĞİ loglanmıyor.
  const providedKey = event.queryStringParameters?.key;
  if (!secretMatches(providedKey)) {
    console.warn("Suno callback: geçersiz/eksik secret, istek reddedildi.");
    // 401 dönüyoruz -- Suno'nun kendi retry mekanizması zaten en fazla
    // 3 deneme yapıp vazgeçiyor, bu yüzden gerçek bir sahte istekte
    // kotalarını gereksiz tüketmiyoruz; 200 dönüp "başarılıymış gibi"
    // davranmak yerine sorunun log'da NET görünmesini tercih ediyoruz.
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    console.error("Suno callback: geçersiz JSON gövdesi", err);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    const code = body.code;
    const data = body.data || {};
    const callbackType = data.callbackType;
    const taskId = data.task_id || data.taskId;

    if (!taskId) {
      console.warn("Suno callback: task_id yok, atlanıyor.");
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    const job = await findJobByTaskId(taskId);
    if (!job) {
      // Job TTL ile silinmiş olabilir ya da başka bir sebeple
      // bulunamıyor olabilir -- Suno'ya yine de 200 dönüp gereksiz
      // retry'lardan kaçınıyoruz, kaybedecek bir şey yok.
      console.warn(`Suno callback: taskId=${taskId} için job bulunamadı.`);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    const sunoTaskStatus = sunoStatusForCallbackType(callbackType);

    if (code === 200 && (callbackType === "text" || callbackType === "first" || callbackType === "complete")) {
      const sunoResponseData = { sunoData: mapWebhookTracksToSunoData(data.data) };
      await writeSunoStatusCache(job.jobId, {
        sunoTaskStatus,
        sunoResponseData,
        sunoErrorMessage: null,
      });
    } else {
      // code != 200 (400/451/500) ya da callbackType === "error" --
      // Suno SENKRON /generate isteğini KABUL ETMİŞTİ (taskId aldık,
      // kredi o an rezerve edildi -- bkz. generate.js) ama üretim
      // SONRADAN, ASENKRON olarak başarısız oldu. Bu, worker'ın
      // (processSunoGeneration.js) senkron hata dalından TAMAMEN FARKLI
      // bir başarısızlık noktası. Kullanıcı parasını ödediği bir şey
      // ALAMADIĞI için kredi BURADA iade ediliyor -- ama SADECE bu
      // "error" yazısı GERÇEKTEN KAZANDIYSA (writeSunoStatusCache true
      // döndüyse): job zaten "complete" ile SONUÇLANMIŞSA (gecikmiş bir
      // error callback'i geldiyse) monotonic koruma yazmayı reddeder,
      // biz de İADE ETMEYİZ -- kullanıcı şarkısını almışsa refund YOK.
      const wrote = await writeSunoStatusCache(job.jobId, {
        sunoTaskStatus,
        sunoResponseData: null,
        sunoErrorMessage: body.msg || "Şarkı üretimi başarısız oldu.",
      });
      if (wrote && job.creditReservation) {
        await refundCredits(
          job.userId,
          job.jobId,
          job.creditReservation.cost,
          job.creditReservation.period
        );
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error("Suno callback işlenirken hata:", err);
    // Yine de 200 dönüyoruz: Suno'nun retry mekanizması sınırlı (3
    // deneme) ve status.js'teki 18sn'lik güvenlik-ağı zaten bu job'ı
    // er ya da geç canlı pollayarak kurtaracak.
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }
};
