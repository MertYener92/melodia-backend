const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { recordLyricsTaskOwner } = require("./lyricsTaskOwnership");

const SUNO_CALLBACK_SECRET = process.env.SUNO_CALLBACK_SECRET;

exports.handler = async (event) => {
  try {
    // HIZ SINIRI — bir kullanıcı dakikada en fazla 10 söz üretim isteği başlatabilir.
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "lyrics", 10, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const body = JSON.parse(event.body || "{}");
    // Suno bu alanı zorunlu tutuyor; içeriğiyle ilgilenmiyoruz, sonucu
    // /lyrics-status ile polling yapıyoruz. URL'i gelen isteğin kendi
    // adresinden anlık hesaplıyoruz (döngüsel bağımlılık olmasın diye).
    // DÜZELTME (SORUN 2754): secret eklendi -- önceden eksikti, Suno'nun söz
    // callback'leri sunoCallback.js'te 401 alıyordu.
    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback?key=${encodeURIComponent(SUNO_CALLBACK_SECRET)}`;

    const { ok, status, data } = await sunoFetch("/api/v1/lyrics", {
      method: "POST",
      body: JSON.stringify({
        prompt: body.prompt,
        callBackUrl,
      }),
    });

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Söz üretimi başlatılamadı." }),
      };
    }

    // Görevi kimin başlattığını kaydet -- /lyrics-status sadece sahibine cevap verir.
    await recordLyricsTaskOwner(data.data.taskId, userId);

    return {
      statusCode: 200,
      body: JSON.stringify({ taskId: data.data.taskId }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};