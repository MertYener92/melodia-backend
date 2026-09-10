const { sunoFetch } = require("./sunoProxy");

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    // Suno bu alanı zorunlu tutuyor; içeriğiyle ilgilenmiyoruz, sonucu
    // /lyrics-status ile polling yapıyoruz. URL'i gelen isteğin kendi
    // adresinden anlık hesaplıyoruz (döngüsel bağımlılık olmasın diye).
    const callBackUrl = `https://${event.headers.Host}/${event.requestContext.stage}/suno-callback`;

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