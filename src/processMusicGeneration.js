const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { sunoFetch } = require("./sunoProxy");
const { lyriaGenerate } = require("./lyriaProxy");
const { uploadAudioBufferToS3, getPresignedAudioUrl } = require("./audioStorage");
const { currentPeriodKey } = require("./creditPlans");
const { initSunoStatusCache } = require("./sunoStatusCache");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME; // UsersTable — jeton düşmek için
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME;
const SONG_CREDIT_COST = Number(process.env.SONG_CREDIT_COST || 1);

// Bu worker MusicGenerationQueue'dan (SQS) tetiklenir. generate.js artık
// Suno'yu çağırmıyor, sadece bir "job" kaydı bırakıp burayı tetikliyor.
//
// İDEMPOTENCY NOTU: SQS "en az bir kez teslim" garantisi verir — yani aynı
// mesaj nadiren de olsa İKİ KEZ işlenebilir (paralel iki Lambda invocation'ı
// gibi). Suno'ya çift istek atmak = çift ücret demek olduğu için, Suno'yu
// çağırmadan önce job'u DynamoDB'de koşullu bir UpdateCommand ile
// "submitting" olarak KİLİTLİYORUZ. İkinci teslimat bu koşulu geçemez ve
// sessizce atlanır.
//
// Kalan tek risk: Lambda, Suno'yu çağırdıktan SONRA ama sonucu tabloya
// yazmadan ÖNCE çökerse (ör. konteyner kesintisi) — bu durumda job
// "submitting" durumunda asılı kalır. STALE_CLAIM_MS'den daha eski bir
// "submitting" kaydını bir sonraki deneme yeniden ele alabilir (kurtarma).
// Bu, gerçekten çok nadir bir pencere ve ~$0.06/şarkı ölçeğinde kabul
// edilebilir bir risk; ileride gerçek kullanıcı hacmi artarsa Suno
// tarafında bir idempotency-key desteği varsa ona geçilebilir.
const STALE_CLAIM_MS = 2 * 60 * 1000; // 2 dakika

async function claimJob(jobId) {
  const { Item: job } = await client.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { jobId } })
  );
  if (!job) return null; // TTL ile silinmiş veya hiç yazılmamış olabilir
  if (job.status === "ready" || job.status === "failed") return null; // zaten sonuçlanmış

  const isStaleSubmitting =
    job.status === "submitting" &&
    Date.now() - new Date(job.updatedAt).getTime() > STALE_CLAIM_MS;

  if (job.status !== "queued" && !isStaleSubmitting) {
    // Başka bir invocation şu an bu işi zaten işliyor
    return null;
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { jobId },
        UpdateExpression: "SET #st = :submitting, updatedAt = :now",
        ConditionExpression: "#st = :expected",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":submitting": "submitting",
          ":now": new Date().toISOString(),
          ":expected": job.status,
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null; // yarış kaybedildi
    throw err;
  }

  return job;
}

async function releaseJobForRetry(jobId) {
  // Kilidi geri bırak ki SQS'in bir sonraki teslim denemesi işi yeniden alabilsin.
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :queued, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":queued": "queued", ":now": new Date().toISOString() },
    })
  );
}

async function markFailed(jobId, message) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :failed, errorMessage = :msg, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":msg": message,
        ":now": new Date().toISOString(),
      },
    })
  );
}

async function markReady(jobId, taskId) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression: "SET #st = :ready, taskId = :taskId, updatedAt = :now",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":ready": "ready",
        ":taskId": taskId,
        ":now": new Date().toISOString(),
      },
    })
  );
}

// YENİ (Lyria): Suno'daki gibi "taskId" ile sonra tekrar sorgulanacak bir
// dış görev yok -- sonuç (başlık, oynatılabilir URL, süre) TEK seferde,
// şimdi elimizde. Bu yüzden status.js'in Flutter'a döneceği son hali
// doğrudan job kaydına yazıyoruz (bkz. status.js'teki 'lyria' dalı).
async function markReadyWithResult(jobId, result) {
  await client.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { jobId },
      UpdateExpression:
        "SET #st = :ready, updatedAt = :now, resultTitle = :title, " +
        "resultAudioUrl = :audioUrl, resultLyrics = :lyrics",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":ready": "ready",
        ":now": new Date().toISOString(),
        ":title": result.title,
        ":audioUrl": result.audioUrl,
        ":lyrics": result.lyrics || "",
      },
    })
  );
}

async function deductCredits(userId, cost) {
  const now = new Date();
  const { Item: user } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId } })
  );
  const plan = user?.plan || "free";
  const currentPeriod = currentPeriodKey(plan, now);
  const used = user?.aiCreditsPeriod === currentPeriod ? (user.aiCreditsUsed || 0) : 0;

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId },
      UpdateExpression:
        "SET aiCreditsUsed = :newUsed, aiCreditsPeriod = :period, #plan = if_not_exists(#plan, :freePlan)",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: {
        ":newUsed": used + cost,
        ":period": currentPeriod,
        ":freePlan": "free",
      },
    })
  );
}

// HTTP 5xx ve 429 (rate limit) = geçici, yeniden denemeye değer.
// Diğer her şey (400 gibi parametre/içerik reddi) = kalıcı, tekrar
// denemenin anlamı yok — job'u direkt "failed" işaretliyoruz.
function isTransientSunoError(status) {
  return status >= 500 || status === 429;
}

// Lyria/Gemini için aynı mantık: 5xx ve 429 geçici, güvenlik filtresi
// reddi (400) ya da yetkilendirme hatası (401/403) kalıcı.
function isTransientLyriaError(status) {
  return status >= 500 || status === 429;
}

// Lyria'ya "sözleri şu dilde yaz" talimatını AÇIKÇA verebilmek için dil
// kodundan (music-spec'in tespit ettiği ya da uygulama arayüz dili) doğal
// dil ismine çeviri. Lyria dokümantasyonu tam bu şekilde bir örnek veriyor:
// "Write the lyrics in French". Eşlemede olmayan bir kod gelirse (Claude
// nadiren farklı bir dil tespit edebilir) talimat eklenmez, Lyria kendi
// haline bırakılır -- yanlış bir dil ismi uydurmaktansa bu daha güvenli.
const LANGUAGE_NAMES = {
  tr: "Turkish",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  ar: "Arabic",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  hi: "Hindi",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
};

// Kullanıcının seçtiği tür/ruh hali/vokal bilgilerinden Lyria 3.5 için
// doğal dilde bir prompt kurar. Lyria'nın kendi API'si "genre"/"mood" gibi
// ayrı alanlar KABUL ETMİYOR -- her şey tek bir metin promptu (bkz. Gemini
// dokümantasyonu) -- bu yüzden burada birleştiriyoruz.
function buildLyriaPrompt(job) {
  const { style, title, instrumental, lyrics, vocalGender, durationSeconds, lyricsLanguage } =
    job.payload;

  const parts = [];

  const durationText = durationSeconds
    ? `Create a ${Math.round(durationSeconds / 60) || 1}-minute song.`
    : "Create a 2-minute song.";
  parts.push(durationText);

  if (style) parts.push(style);

  if (instrumental) {
    parts.push("Instrumental only, no vocals.");
  } else if (vocalGender === "f") {
    parts.push("Female vocals.");
  } else if (vocalGender === "m") {
    parts.push("Male vocals.");
  }

  if (title) parts.push(`Song title theme: ${title}.`);

  // DÜZELTME: Lyria hangi dilde söz yazacağını PROMPT'UN KENDİ DİLİNDEN
  // çıkarıyor -- ama yukarıdaki parçaların hepsi (durationText, "Song
  // title theme", style/generation_prompt) kasıtlı olarak İNGİLİZCE
  // (bkz. music-spec'in generation_prompt alanı). Bu, kullanıcı Türkçe
  // yazsa bile Lyria'nın hep İngilizce söz yazmasına sebep oluyordu.
  // Artık AÇIKÇA "şu dilde yaz" talimatı ekliyoruz.
  if (!instrumental && lyricsLanguage && LANGUAGE_NAMES[lyricsLanguage]) {
    parts.push(`Write the lyrics in ${LANGUAGE_NAMES[lyricsLanguage]}.`);
  }

  // Kullanıcı Gelişmiş modda kendi sözlerini/nakaratını verdiyse (ya da
  // Suno söz motorundan zaten bir söz metni üretilmişse), Lyria'nın
  // "Lyrics:" öneki ile bunları OLDUĞU GİBİ kullanmasını istiyoruz --
  // aksi halde Lyria kendi sözlerini uydurur.
  if (!instrumental && lyrics && lyrics.trim()) {
    parts.push(`\n\nLyrics:\n\n${lyrics.trim()}`);
  }

  return parts.join(" ");
}

async function processLyriaJob(job) {
  const prompt = buildLyriaPrompt(job);
  const result = await lyriaGenerate(prompt);

  if (!result.ok) {
    if (isTransientLyriaError(result.status)) {
      throw new Error(
        `Lyria geçici hata döndürdü: HTTP ${result.status} — ${result.data?.message || "bilinmiyor"}`
      );
    }
    throw { permanent: true, message: result.data?.message || "Şarkı üretimi başlatılamadı." };
  }

  const audioBuffer = Buffer.from(result.audioBase64, "base64");
  const songId = job.jobId; // her job zaten benzersiz, ayrı bir songId üretmeye gerek yok
  const audioKey = await uploadAudioBufferToS3(audioBuffer, job.userId, songId);
  const audioUrl = await getPresignedAudioUrl(audioKey);

  return {
    title: job.payload.title || "Adsız Şarkı",
    audioUrl,
    lyrics: result.lyrics,
  };
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
      // YENİ: sağlayıcıya göre dallan. Suno akışı AŞAĞIDA HİÇ
      // DEĞİŞTİRİLMEDEN duruyor; Lyria tamamen ayrı, kendi kendine yeten
      // bir fonksiyonda (job.provider yoksa/tanınmıyorsa 'suno' varsayılır,
      // eski job kayıtlarıyla geriye dönük uyumluluk için).
      if (job.provider === "lyria") {
        let result;
        try {
          result = await processLyriaJob(job);
        } catch (err) {
          if (err?.permanent) {
            console.error(`Job ${jobId} (lyria) kalıcı olarak başarısız:`, err.message);
            await markFailed(jobId, err.message);
            continue; // mesaj başarıyla "işlendi" sayılır, SQS'ten silinir
          }
          throw err; // geçici hata -> dış catch, releaseJobForRetry + SQS retry
        }

        // Gemini isteği başarılı oldu — SADECE ŞİMDİ jeton düşülüyor
        // (Suno dalıyla birebir aynı adalet ilkesi).
        await deductCredits(job.userId, SONG_CREDIT_COST);
        await markReadyWithResult(jobId, result);
        continue;
      }

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

        // Kalıcı hata — jeton düşülmedi, tekrar denemeye gerek yok.
        console.error(`Job ${jobId} kalıcı olarak başarısız: HTTP ${status}`, JSON.stringify(data));
        await markFailed(jobId, data?.msg || "Şarkı üretimi başlatılamadı.");
        continue; // mesaj başarıyla "işlendi" sayılır, SQS'ten silinir
      }

      // Suno isteği kabul etti — SADECE ŞİMDİ jeton düşülüyor
      await deductCredits(job.userId, SONG_CREDIT_COST);
      await markReady(jobId, data.data.taskId);
      // YENİ: webhook/cache alanlarını PENDING'e kur -- sunoCallback.js
      // (Suno'nun webhook'u) ve status.js'in güvenlik-ağı poll'u bundan
      // sonra bu alanları güncelleyecek. status.js artık bu noktadan
      // sonra, webhook gelene kadar Suno'yu HER pollamada değil, en
      // fazla 18sn'de bir sorgulayacak (bkz. sunoStatusCache.js).
      await initSunoStatusCache(jobId);
    } catch (err) {
      console.error(`Job ${jobId} işleme hatası:`, err);
      throw err; // SQS retry/DLQ mekanizmasını tetikle
    }
  }
};