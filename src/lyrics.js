const crypto = require("crypto");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { recordLyricsTaskOwner, CLAUDE_TASK_PREFIX } = require("./lyricsTaskOwnership");

const lambda = new LambdaClient({});
const SUNO_CALLBACK_SECRET = process.env.SUNO_CALLBACK_SECRET;
const LYRICS_WRITER_FUNCTION_NAME = process.env.LYRICS_WRITER_FUNCTION_NAME;

// Suno'nun söz ucu (/api/v1/lyrics) en fazla 200 karakter kabul ediyor.
const SUNO_LYRICS_PROMPT_MAX = 200;
// Uygulamadaki açıklama alanlarının sınırı.
const MAX_PROMPT_CHARS = 3000;

// YENİ (uzun açıklamalar): 200 karakteri aşan açıklamalarda sözler Claude
// ile arka planda yazılır (lyricsWriter.js). Görev ID'si CLAUDE_TASK_PREFIX
// ile başlar; /lyrics-status sonucu Suno'nun formatında döndürür.
async function startClaudeLyricsTask(userId, prompt) {
  const taskId = `${CLAUDE_TASK_PREFIX}${crypto.randomUUID()}`;
  await recordLyricsTaskOwner(taskId, userId, { status: "PENDING", prompt });
  await lambda.send(
    new InvokeCommand({
      FunctionName: LYRICS_WRITER_FUNCTION_NAME,
      InvocationType: "Event", // asenkron -- API Gateway'in 29 sn sınırı dışında çalışır
      Payload: Buffer.from(JSON.stringify({ taskId })),
    })
  );
  return taskId;
}

exports.handler = async (event) => {
  try {
    // HIZ SINIRI — bir kullanıcı dakikada en fazla 10 söz üretim isteği başlatabilir.
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "lyrics", 10, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const body = JSON.parse(event.body || "{}");
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
    if (!prompt) {
      return { statusCode: 400, body: JSON.stringify({ error: "Şarkı açıklaması boş olamaz." }) };
    }

    if (prompt.length > SUNO_LYRICS_PROMPT_MAX) {
      const taskId = await startClaudeLyricsTask(userId, prompt);
      return { statusCode: 200, body: JSON.stringify({ taskId }) };
    }

    // Suno bu alanı zorunlu tutuyor; içeriğiyle ilgilenmiyoruz, sonucu
    // /lyrics-status ile polling yapıyoruz. URL'i gelen isteğin kendi
    // adresinden anlık hesaplıyoruz (döngüsel bağımlılık olmasın diye).
    // DÜZELTME (SORUN 2754): secret eklendi -- önceden eksikti, Suno'nun söz
    // callback'leri sunoCallback.js'te 401 alıyordu.
    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback?key=${encodeURIComponent(SUNO_CALLBACK_SECRET)}`;

    const { ok, status, data } = await sunoFetch("/api/v1/lyrics", {
      method: "POST",
      body: JSON.stringify({
        prompt,
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
      body: JSON.stringify({ error: "Söz üretimi başlatılamadı." }),
    };
  }
};
