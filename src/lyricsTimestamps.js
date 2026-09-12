const { checkRateLimit, rateLimitResponse } = require("./rateLimit");

const SUNO_API_KEY = process.env.SUNO_API_KEY;
const SUNO_BASE_URL = "https://api.sunoapi.org";

// Karaoke gösterimi için kelime bazlı zaman damgalı sözleri Suno'dan
// çeker. Kota harcamaz — zaten üretilmiş bir şarkının ek bir bilgisidir.
exports.handler = async (event) => {
  try {
    // HIZ SINIRI — jeton harcamıyor ama yine de Suno'ya gerçek istek atıyor.
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

    const sunoResponse = await fetch(
      `${SUNO_BASE_URL}/api/v1/generate/get-timestamped-lyrics`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUNO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ taskId, audioId }),
        signal: AbortSignal.timeout(20000),
      }
    );

    const sunoData = await sunoResponse.json();

    if (!sunoResponse.ok || sunoData.code !== 200) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: sunoData.msg || "Zaman damgalı sözler alınamadı.",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        alignedWords: sunoData.data?.alignedWords || [],
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