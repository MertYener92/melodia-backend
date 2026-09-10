const SUNO_BASE_URL = "https://api.sunoapi.org";
const SUNO_API_KEY = process.env.SUNO_API_KEY;

async function sunoFetch(path, options = {}) {
  const response = await fetch(`${SUNO_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUNO_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  return { ok: response.ok && data.code === 200, status: response.status, data };
}

module.exports = { sunoFetch };