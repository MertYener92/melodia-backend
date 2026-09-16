const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const {
  SUNO_STATUS,
  isFinalStatus,
  isCacheFresh,
  writeSunoStatusCache,
  findJobByTaskId,
} = require("./sunoStatusCache");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;

// YENİ: job kaydındaki webhook/cache alanlarını, Flutter'ın beklediği
// (Suno'nun canlı /record-info yanıtıyla BİREBİR aynı) HTTP gövdesine
// çevirir. status.js'in üç dönüş noktası da (taze cache / bayat cache
// fallback sonrası / hiç cache yokken fallback sonrası) AYNI şekli
// üretsin diye tek bir yerde.
function sunoJobToResponseBody(job, { sunoTaskStatus, sunoResponseData, sunoErrorMessage }) {
  return {
    status: sunoTaskStatus,
    response: sunoResponseData || { sunoData: [] },
    errorMessage: sunoErrorMessage || undefined,
    taskId: job.taskId,
  };
}

// YENİ: webhook henüz (hiç ya da tazelik süresi içinde) gelmediyse
// Suno'yu bizzat sorgulayan GÜVENLİK AĞI. Sonucu job kaydına yazar ki
// hem bir sonraki poll'lar hem de aynı job'ı paralel pollayan başka
// istekler (ör. kullanıcı iki cihazdan bağlıysa) bu tek canlı çağrıdan
// faydalansın.
async function fallbackLivePoll(job) {
  // DÜZELTME: sunoFetch artık (merkezi rate limiter tükendiğinde ya da
  // ağ hatasında) İSTİSNA FIRLATABİLİR -- eskiden her zaman {ok:false}
  // döndürürdü. Burada try/catch ile sarmazsak, bu istisna doğrudan
  // handler'ın dışına taşıp kullanıcıya çıplak bir 500 döner. Bunun
  // yerine HER durumda (ok:false DÖNSE de, İSTİSNA FIRLATSA da) elimizdeki
  // en son bilinen duruma (webhook'tan ya da önceki poll'dan) geri
  // dönüyoruz -- bir sonraki 5sn'lik pollamada tekrar denenecek.
  let result;
  try {
    result = await sunoFetch(
      `/api/v1/generate/record-info?taskId=${encodeURIComponent(job.taskId)}`
    );
  } catch (err) {
    console.warn(`Job ${job.jobId}: Suno güvenlik-ağı poll'u istisna fırlattı (${err.message}), son bilinen durum döndürülüyor.`);
    return sunoJobToResponseBody(job, {
      sunoTaskStatus: job.sunoTaskStatus || SUNO_STATUS.PENDING,
      sunoResponseData: job.sunoResponseData,
      sunoErrorMessage: job.sunoErrorMessage,
    });
  }

  const { ok, status, data } = result;
  if (!ok) {
    // Suno şu an cevap veremiyor (ya da merkezi rate limiter'da bekleme
    // tükendi) -- kullanıcıya çıplak bir hata göstermek yerine, elimizdeki
    // EN SON bilinen durumu (webhook'tan ya da önceki poll'dan) geri
    // döndürüyoruz; bir sonraki 5sn'lik pollamada tekrar denenecek.
    console.warn(`Job ${job.jobId}: Suno güvenlik-ağı poll'u başarısız (HTTP ${status}), son bilinen durum döndürülüyor.`);
    return sunoJobToResponseBody(job, {
      sunoTaskStatus: job.sunoTaskStatus || SUNO_STATUS.PENDING,
      sunoResponseData: job.sunoResponseData,
      sunoErrorMessage: job.sunoErrorMessage,
    });
  }

  const fresh = {
    sunoTaskStatus: data.data.status,
    sunoResponseData: data.data.response,
    sunoErrorMessage: data.data.errorMessage,
  };
  // Sonucu cache'e yaz -- webhook hiç gelmese BİLE bir sonraki 18sn'lik
  // pencerede tekrar canlı sormaya gerek kalmadan bu değer kullanılır.
  await writeSunoStatusCache(job.jobId, fresh);
  return sunoJobToResponseBody(job, fresh);
}

// YENİ: /generate artık senkron değil, hemen bir jobId dönüyor. Suno'nun
// kendi taskId'si ancak worker Suno'yu başarıyla çağırdıktan SONRA var
// oluyor. Bu yüzden bu uç nokta artık iki modu destekliyor:
//  - ?jobId=...   -> önce job kaydına bakar (queued/submitting/failed/ready)
//  - ?taskId=...  -> doğrudan Suno'nun durumunu sorar (eskisiyle aynı, geriye dönük uyumluluk)
// Flutter istemcisi: /generate'ten dönen jobId ile pollamaya başlar; job
// "ready" olduğunda cevapta hem job durumu hem de taskId birlikte döner,
// istemci dilerse o andan sonra taskId ile pollamaya geçebilir.
exports.handler = async (event) => {
  try {
    // HIZ SINIRI — bu bir polling uç noktası (Flutter periyodik çağırıyor),
    // bu yüzden limit /generate'e göre çok daha gevşek: dakikada 60 istek
    // (ortalama saniyede 1) normal bir polling döngüsünü asla etkilemez,
    // sadece döngüye giren bir bug'ı ya da kötüye kullanımı yakalar.
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "status", 60, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const jobId = event.queryStringParameters?.jobId;
    let taskId = event.queryStringParameters?.taskId;

    if (jobId) {
      const { Item: job } = await client.send(
        new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId } })
      );

      if (!job) {
        return { statusCode: 404, body: JSON.stringify({ error: "job_not_found" }) };
      }

      // YENİ (FINAL PRODUCTION HARDENING — madde 3, ownership kontrolü):
      // jobId tahmin edilebilir/bilinebilir bir UUID -- job kaydı
      // userId'yi taşısa da, bu ana kadar authenticated userId ile
      // KARŞILAŞTIRILMIYORDU. Başka bir kullanıcının jobId'sini bilen
      // biri onun şarkı sözünü/ses URL'sini görebilirdi (IDOR). 404
      // dönüyoruz (403 değil) ki job'ın VARLIĞI bile sızdırılmasın.
      if (job.userId !== userId) {
        return { statusCode: 404, body: JSON.stringify({ error: "job_not_found" }) };
      }

      if (job.status === "queued" || job.status === "submitting") {
        return { statusCode: 200, body: JSON.stringify({ status: "queued" }) };
      }

      if (job.status === "failed") {
        return {
          statusCode: 200,
          body: JSON.stringify({ status: "failed", message: job.errorMessage }),
        };
      }

      // YENİ (Lyria): Suno'nun aksine tekrar sorgulanacak bir dış "taskId"
      // yok -- sonuç zaten worker tarafından job kaydına yazıldı
      // (bkz. processLyriaGeneration.js -> markReadyWithResult). Flutter'ın
      // beklediği GenerationTask.fromJson şeklini burada birebir üretiyoruz,
      // Suno'ya hiç gitmeden.
      if (job.status === "ready" && job.provider === "lyria") {
        return {
          statusCode: 200,
          body: JSON.stringify({
            status: "SUCCESS",
            taskId: job.jobId,
            response: {
              sunoData: [
                {
                  id: job.jobId,
                  title: job.resultTitle,
                  prompt: job.payload?.lyrics || job.resultLyrics || "",
                  audioUrl: job.resultAudioUrl,
                  streamAudioUrl: job.resultAudioUrl,
                  imageUrl: "",
                  duration: job.payload?.durationSeconds ?? null,
                },
              ],
            },
          }),
        };
      }

      // DEĞİŞTİ (5.000 kullanıcı ölçeklendirmesi): job.status === "ready"
      // (Suno) artık HER pollamada Suno'yu sorgulamıyoruz. Sırasıyla:
      //  1) Webhook zaten SONUÇLANDIRMIŞ (SUCCESS/failed) mı? -> job
      //     kaydından doğrudan dön, Suno'ya ASLA gitme (madde 7).
      //  2) Webhook henüz sonuçlandırmadı ama son güncellemeden beri
      //     18sn'den AZ geçti mi? -> yine job kaydından dön (madde 6).
      //  3) 18sn'den FAZLA geçtiyse (webhook gecikti/kayboldu) -> tek
      //     seferlik güvenlik-ağı poll'u yap ve sonucu cache'e yaz.
      if (job.provider !== "lyria") {
        const sunoTaskStatus = job.sunoTaskStatus || SUNO_STATUS.PENDING;

        if (isFinalStatus(sunoTaskStatus) || isCacheFresh(job.statusCachedAt)) {
          return {
            statusCode: 200,
            body: JSON.stringify(
              sunoJobToResponseBody(job, {
                sunoTaskStatus,
                sunoResponseData: job.sunoResponseData,
                sunoErrorMessage: job.sunoErrorMessage,
              })
            ),
          };
        }

        const body = await fallbackLivePoll(job);
        return { statusCode: 200, body: JSON.stringify(body) };
      }

      // job.status === "ready" && provider === "lyria" yukarıda zaten
      // dönmüştü -- buraya normalde ulaşılmaz, savunma amaçlı.
      taskId = job.taskId;
    }

    if (!taskId) {
      return { statusCode: 400, body: JSON.stringify({ error: "jobId veya taskId gerekli." }) };
    }

    // YENİ (madde 3): doğrudan ?taskId= ile (jobId'siz) sorgulanan
    // geriye-dönük-uyumluluk yolu da ownership kontrolünden GEÇMELİ --
    // aksi halde taskId'yi bilen/tahmin eden biri başka bir kullanıcının
    // job'ını sorgulayabilirdi. Bu koddaki normal Flutter akışı ARTIK
    // HER ZAMAN jobId ile pollandığı için buraya normal şartlarda hiç
    // düşülmez; yine de var olduğu sürece güvenli olmalı.
    const ownerJob = await findJobByTaskId(taskId);
    if (!ownerJob || ownerJob.userId !== userId) {
      return { statusCode: 404, body: JSON.stringify({ error: "job_not_found" }) };
    }

    // Geriye dönük uyumluluk: eski istemciler için eski davranış korunuyor.
    const { ok, status, data } = await sunoFetch(
      `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`
    );

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Durum sorgulanamadı." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ ...data.data, taskId }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};