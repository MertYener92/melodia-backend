const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Kullanıcının gerçek çalışan testinde doğrulanmış istek şekli:
// POST /v1beta/interactions, header x-goog-api-key, body
// {model:"lyria-3.5", input:"...", response_format:{type:"audio"}}.
// Yanıt tek seferde (senkron) geliyor -- Suno'nun aksine "taskId ile
// sonra sorgula" diye bir akış YOK, sonuç bu çağrının içinde tam olarak
// dönüyor (bkz. processLyriaJob'da nasıl kullanıldığı).
async function lyriaGenerate(prompt) {
  const response = await fetch(`${GEMINI_BASE_URL}/interactions`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "lyria-3.5",
      input: prompt,
      response_format: { type: "audio" },
    }),
    // Tam şarkı üretimi Suno'dan da uzun sürebilir (dakikalar); worker'ın
    // kendi Lambda timeout'u zaten bunu sınırlıyor, burada sadece ağın
    // sonsuza kadar asılı kalmasını önlüyoruz.
    signal: AbortSignal.timeout(120000),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data) {
    return { ok: false, status: response.status, data };
  }

  // steps[] içinde model_output adımlarının content[] dizisinde
  // type==="audio" olan bloğu bul (kullanıcının PowerShell testinde
  // doğrulanan yapı: steps -> content -> {type:"audio", data, mime_type}).
  let audioBase64 = null;
  let mimeType = "audio/mpeg";
  const lyricsParts = [];

  for (const step of data.steps || []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content || []) {
      if (block.type === "audio" && block.data) {
        audioBase64 = block.data; // en son audio bloğu kazanır (Suno callback'i gibi)
        mimeType = block.mime_type || mimeType;
      } else if (block.type === "text" && block.text) {
        lyricsParts.push(block.text);
      }
    }
  }

  if (!audioBase64) {
    return { ok: false, status: 502, data: { message: "Yanıtta ses verisi bulunamadı." } };
  }

  return {
    ok: true,
    status: 200,
    audioBase64,
    mimeType,
    lyrics: lyricsParts.join("\n").trim(),
  };
}

module.exports = { lyriaGenerate };