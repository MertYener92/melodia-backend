const { sunoFetch } = require("./sunoProxy");

exports.handler = async (event) => {
  try {
    const taskId = event.queryStringParameters?.taskId;
    if (!taskId) {
      return { statusCode: 400, body: JSON.stringify({ error: "taskId gerekli." }) };
    }

    const { ok, status, data } = await sunoFetch(
      `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`
    );

    if (!ok) {
      return {
        statusCode: status === 200 ? 502 : status,
        body: JSON.stringify({ error: data.msg || "Durum sorgulanamadı." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(data.data) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};