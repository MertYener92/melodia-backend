const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");

// Karaoke gösterimi için kelime bazlı zaman damgalı sözleri Suno'dan
// çeker. Kota harcamaz — zaten üretilmiş bir şarkının ek bir bilgisidir.
//
// DEĞİŞTİ (FINAL PRODUCTION HARDENING — madde 4): önceden bu dosya
// sunoProxy.js'i ATLAYIP ham bir fetch() kullanıyordu -- yani ne merkezi
// hesap-geneli rate limiter'dan ne de 429/5xx backoff'undan geçiyordu.
// Artık TÜM Suno çağrıları (bu dosya dahil) tek bir noktadan (sunoFetch)
// geçiyor.
exports.handler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "lyrics-timestamps", 15, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const body = JSON.parse(event.body || "{}");
    const { taskId, audioId } = body;

    if (!taskId || !audioId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "taskId ve audioId zorunludur." }),
      };
    }

    const { ok, status, data } = await sunoFetch("/api/v1/generate/get-timestamped-lyrics", {
      method: "POST",
      body: JSON.stringify({ taskId, audioId }),
    });

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Zaman damgalı sözler alınamadı." }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        alignedWords: data.data?.alignedWords || [],
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
