const { sunoFetch } = require("./sunoProxy");
const { checkRateLimit, rateLimitResponse } = require("./rateLimit");
const { isLyricsTaskOwner } = require("./lyricsTaskOwnership");

exports.handler = async (event) => {
  try {
    // HIZ SINIRI — status.js ile aynı mantık: bu da bir polling uç noktası,
    // dakikada 60 istek normal kullanımı hiç etkilemez.
    const userId = event.requestContext.authorizer.claims.sub;
    const rl = await checkRateLimit(userId, "lyrics-status", 60, 60);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const taskId = event.queryStringParameters?.taskId;
    if (!taskId) {
      return { statusCode: 400, body: JSON.stringify({ error: "taskId gerekli." }) };
    }

    // GÜVENLİK (SORUN 2754): sadece görevi başlatan kullanıcı sorgulayabilir.
    if (!(await isLyricsTaskOwner(taskId, userId))) {
      return { statusCode: 404, body: JSON.stringify({ error: "task_not_found" }) };
    }

    const { ok, status, data } = await sunoFetch(
      `/api/v1/lyrics/record-info?taskId=${encodeURIComponent(taskId)}`
    );

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Söz durumu sorgulanamadı." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(data.data) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};