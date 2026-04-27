// api/fred.js — Vercel Serverless Function
// Calls FRED API server-side (no CORS issues, API key never exposed to browser)
//
// Strategy:
// - All series fetched in parallel (Promise.all). FRED rate limit is 120/min,
//   30 simultaneous requests are well within. Sequential batches were timing out
//   the Vercel 10s serverless limit when many series were requested.
// - Per-fetch timeout via AbortController (FETCH_TIMEOUT_MS).
// - Retry with exponential backoff on 429 (rate limit) and network errors.
// - Cache disabled when response contains errors (avoid propagating bad state).
// - Detailed logging visible in Vercel function logs.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FETCH_TIMEOUT_MS = 5500;    // 5.5s per individual fetch (buffer for Vercel 10s)
const MAX_RETRIES = 1;            // 1 retry (2 attempts total) — keep total under Vercel timeout
const BACKOFF_BASE_MS = 400;      // 400ms backoff

// Single fetch with timeout + retry on 429/network errors
async function fetchSeries(s, apiKey, limit) {
  const url = `${FRED_BASE}?series_id=${s}&limit=${limit}&sort_order=desc&file_type=json&api_key=${apiKey}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      // 429 → retry with backoff
      if (response.status === 429) {
        lastErr = `HTTP 429 (rate limit) attempt ${attempt + 1}`;
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * Math.pow(2, attempt)));
          continue;
        }
        return { error: lastErr, attempts: attempt + 1 };
      }

      if (!response.ok) {
        return { error: `HTTP ${response.status}`, attempts: attempt + 1 };
      }

      const data = await response.json();

      if (data.error_code) {
        return { error: data.error_message || `Código ${data.error_code}`, attempts: attempt + 1 };
      }

      const obs = (data.observations || [])
        .filter(o => o.value !== '.')
        .map(o => ({ date: o.date, value: parseFloat(o.value) }));

      // Telemetry: total observations FRED returned (some may have been filtered as ".")
      const rawCount = (data.observations || []).length;
      if (rawCount === 0) {
        console.warn(`[FRED] ${s}: 0 observations returned by FRED`);
      } else if (obs.length === 0) {
        console.warn(`[FRED] ${s}: ${rawCount} obs but all were "." (no data)`);
      }

      return obs;

    } catch (e) {
      clearTimeout(timeoutId);
      lastErr = e.name === 'AbortError'
        ? `timeout after ${FETCH_TIMEOUT_MS}ms (attempt ${attempt + 1})`
        : `${e.message} (attempt ${attempt + 1})`;

      // Retry on network/timeout errors
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * Math.pow(2, attempt)));
        continue;
      }
      return { error: lastErr, attempts: attempt + 1 };
    }
  }

  return { error: lastErr || 'unknown', attempts: MAX_RETRIES + 1 };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'FRED_API_KEY no está configurada en las variables de entorno de Vercel.'
    });
  }

  const { series, limit = '52' } = req.query;
  if (!series) return res.status(400).json({ error: 'Falta el parámetro ?series=' });

  const seriesList = series.split(',').map(s => s.trim()).filter(Boolean);
  const results = {};
  const tStart = Date.now();

  // All series in parallel — FRED rate limit (120/min) holds; faster than batching.
  const allResults = await Promise.all(
    seriesList.map(s => fetchSeries(s, apiKey, limit).then(r => [s, r]))
  );
  for (const [s, r] of allResults) results[s] = r;

  // Summary log: which series succeeded vs failed
  const ok      = seriesList.filter(s => Array.isArray(results[s]));
  const empty   = seriesList.filter(s => Array.isArray(results[s]) && results[s].length === 0);
  const failed  = seriesList.filter(s => !Array.isArray(results[s]));
  console.log(`[FRED] ${seriesList.length} series in ${Date.now() - tStart}ms · ok=${ok.length} empty=${empty.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('[FRED] failed:', failed.map(s => `${s}=${results[s]?.error || '?'}`).join(' · '));
  }

  // Don't cache responses with errors — avoid propagating broken state to all clients.
  // Healthy responses cache 1h (FRED data is weekly/monthly/daily, not real-time).
  const cacheControl = failed.length > 0
    ? 'max-age=0, no-cache, no-store'
    : 's-maxage=3600, stale-while-revalidate=600';
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).json(results);
};
