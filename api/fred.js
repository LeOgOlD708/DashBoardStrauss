// api/fred.js — Vercel Serverless Function
// Calls FRED API server-side (no CORS issues, API key never exposed to browser)
//
// Strategy:
// - Batches series in groups of BATCH_SIZE (sequential batches, parallel within batch)
//   to avoid hitting FRED's rate limit with 27 simultaneous requests.
// - Per-fetch timeout via AbortController (FETCH_TIMEOUT_MS).
// - Retry with exponential backoff on 429 (rate limit) and network errors.
// - Detailed logging visible in Vercel function logs.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const BATCH_SIZE = 6;             // 6 series per batch (4-5 batches for 27 series)
const FETCH_TIMEOUT_MS = 7000;    // 7s per individual fetch
const MAX_RETRIES = 2;            // up to 2 retries (3 attempts total) on 429/network
const BACKOFF_BASE_MS = 600;      // 600ms, 1.2s

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

  // Process in sequential batches; within each batch, requests run in parallel
  for (let i = 0; i < seriesList.length; i += BATCH_SIZE) {
    const batch = seriesList.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(s => fetchSeries(s, apiKey, limit).then(r => [s, r]))
    );
    for (const [s, r] of batchResults) results[s] = r;
  }

  // Summary log: which series succeeded vs failed
  const ok      = seriesList.filter(s => Array.isArray(results[s]));
  const empty   = seriesList.filter(s => Array.isArray(results[s]) && results[s].length === 0);
  const failed  = seriesList.filter(s => !Array.isArray(results[s]));
  console.log(`[FRED] ${seriesList.length} series in ${Date.now() - tStart}ms · ok=${ok.length} empty=${empty.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('[FRED] failed:', failed.map(s => `${s}=${results[s]?.error || '?'}`).join(' · '));
  }

  // Cache 1 hour — FRED data is weekly/monthly/daily, doesn't need real-time
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(results);
};
