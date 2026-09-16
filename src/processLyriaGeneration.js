// ---------------------------------------------------------------------
// YENİ (FINAL PRODUCTION HARDENING — madde 8): Lyria artık KENDİ ayrı
// SQS kuyruğunda (LyriaGenerationQueue) ve kendi Lambda worker'ında
// işleniyor -- Suno'dan (processSunoGeneration.js) tamamen bağımsız.
// Lyria/Gemini isteği senkron olarak tam şarkı üretimini BEKLER (dakikalar
// sürebilir, Lambda'yı o süre boyunca açık tutar) -- bu yüzden AYRI bir
// worker'da olması, Suno'nun hızlı submission akışını hiç etkilemez.
//
// Ortak job-lifecycle mantığı jobLifecycle.js'de. Kredi rezervasyonu/
// iadesi de processSunoGeneration.js ile AYNI ilkeyi izler: kredi
// generate.js'de zaten rezerve edildi, burada sadece KALICI hatada
// jobLifecycle.markFailed üzerinden iade edilir.
// ---------------------------------------------------------------------

const { lyriaGenerate } = require("./lyriaProxy");
const { uploadAudioBufferToS3, getPresignedAudioUrl } = require("./audioStorage");
const {
  claimJob,
  markFailed,
  markReadyWithResult,
} = require("./jobLifecycle");

// 5xx ve 429 geçici, güvenlik filtresi reddi (400) ya da yetkilendirme
// hatası (401/403) kalıcı.
function isTransientLyriaError(status) {
  return status >= 500 || status === 429;
}

// Lyria'ya "sözleri şu dilde yaz" talimatını AÇIKÇA verebilmek için dil
// kodundan doğal dil ismine çeviri. Eşlemede olmayan bir kod gelirse
// talimat eklenmez, Lyria kendi haline bırakılır.
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
// doğal dilde bir prompt kurar. Lyria'nın kendi API'si "genre"/"mood"
// gibi ayrı alanlar KABUL ETMİYOR -- her şey tek bir metin promptu.
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

  if (!instrumental && lyricsLanguage && LANGUAGE_NAMES[lyricsLanguage]) {
    parts.push(`Write the lyrics in ${LANGUAGE_NAMES[lyricsLanguage]}.`);
  }

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
  for (const record of event.Records) {
    const { jobId } = JSON.parse(record.body);

    const job = await claimJob(jobId);
    if (!job) {
      console.log(`Job ${jobId} zaten işlenmiş/işlenmekte veya bulunamadı, atlanıyor.`);
      continue;
    }

    try {
      let result;
      try {
        result = await processLyriaJob(job);
      } catch (err) {
        if (err?.permanent) {
          console.error(`Job ${jobId} (lyria) kalıcı olarak başarısız:`, err.message);
          await markFailed(job, err.message);
          continue; // mesaj başarıyla "işlendi" sayılır, SQS'ten silinir
        }
        throw err; // geçici hata -> dış catch, SQS retry
      }

      // Gemini isteği başarılı oldu -- kredi zaten generate.js'de
      // rezerve edilmişti, burada TEKRAR düşülmüyor.
      await markReadyWithResult(jobId, result);
    } catch (err) {
      console.error(`Job ${jobId} işleme hatası:`, err);
      throw err; // SQS retry/DLQ mekanizmasını tetikle
    }
  }
};
