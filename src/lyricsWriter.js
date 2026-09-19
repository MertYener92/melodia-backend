// YENİ (uzun söz açıklamaları, 3000 karaktere kadar): Suno'nun söz ucu
// (/api/v1/lyrics) en fazla 200 karakter kabul ediyor -- daha uzun
// açıklamalarda sözler burada Claude ile yazılıyor. lyrics.js görevi
// oluşturup bu fonksiyonu ASENKRON çağırıyor (API Gateway'in 29 sn
// sınırına takılmamak için); sonuç görev kaydına yazılıyor ve
// lyricsStatus.js onu Suno'nun cevabıyla AYNI formatta döndürüyor --
// uygulamanın söz bekleme akışı hiç değişmiyor.

const { Anthropic } = require("@anthropic-ai/sdk");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getLyricsTask, completeLyricsTask } = require("./lyricsTaskOwnership");

const secrets = new SecretsManagerClient({});
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_SECRET_ARN;
const LYRICS_MODEL_ID = process.env.LYRICS_MODEL_ID || "claude-opus-5";

// Suno custom mode'da söz (prompt) en fazla 5000 karakter; güvenli pay.
const MAX_LYRICS_CHARS = 4500;

const SYSTEM_PROMPT = `You write original song lyrics for an AI music app. The user describes the song they want; turn that description into complete, singable lyrics.

Write the lyrics and the title in the same language the description is written in (for example Turkish, English or Spanish). If the description explicitly asks for another language, use that language instead.

Use the details the user gives - story, names, places, feelings, imagery - and keep them recognisable in the lyrics. Aim for a song of about two to three minutes. Mark sections with English tags on their own lines, such as [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge] and [Outro]; the music engine uses these tags. The lyrics are sung as written, so include only lyric lines and section tags - no explanations, chord names or stage directions.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short song title, at most 60 characters." },
    lyrics: { type: "string", description: "Full lyrics with section tags." },
  },
  required: ["title", "lyrics"],
  additionalProperties: false,
};

let _client = null;

async function getClient() {
  if (_client) return _client;
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET_ARN }));
  let apiKey = SecretString;
  try {
    apiKey = JSON.parse(SecretString).ANTHROPIC_API_KEY || SecretString;
  } catch {
    // Düz metin olarak saklanmış anahtar.
  }
  _client = new Anthropic({ apiKey, maxRetries: 2 });
  return _client;
}

async function writeLyrics(description) {
  const client = await getClient();
  const response = await client.beta.messages.create({
    model: LYRICS_MODEL_ID,
    max_tokens: 16000,
    // Model güvenlik gerekçesiyle reddederse Anthropic isteği uygun bir
    // yedek modelde otomatik yeniden çalıştırır.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Song description:\n\n${description}` }],
  });

  if (response.stop_reason === "refusal") {
    console.warn("Söz yazımı reddedildi:", response.stop_details?.category ?? "bilinmiyor");
    throw new UserFacingError("Bu açıklama için söz yazılamadı. Açıklamayı değiştirip tekrar dene.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Söz yazımı yarıda kesildi (max_tokens).");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const parsed = JSON.parse(text);
  const lyrics = String(parsed.lyrics || "").trim().slice(0, MAX_LYRICS_CHARS);
  if (!lyrics) throw new Error("Boş söz döndü.");
  return { title: String(parsed.title || "").trim().slice(0, 80), lyrics };
}

class UserFacingError extends Error {}

exports.handler = async (event) => {
  const taskId = event?.taskId;
  if (!taskId) return;

  const task = await getLyricsTask(taskId);
  if (!task || task.status !== "PENDING" || !task.prompt) {
    console.warn(`Söz görevi bulunamadı ya da zaten işlenmiş: ${taskId}`);
    return;
  }

  try {
    const { title, lyrics } = await writeLyrics(task.prompt);
    await completeLyricsTask(taskId, { status: "SUCCESS", title, text: lyrics });
  } catch (err) {
    console.error(`Söz görevi ${taskId} başarısız:`, err);
    await completeLyricsTask(taskId, {
      status: "GENERATE_LYRICS_FAILED",
      errorMessage:
        err instanceof UserFacingError ? err.message : "Söz üretimi başarısız oldu. Lütfen tekrar dene.",
    });
  }
};
