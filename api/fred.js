// api/fred.js — Vercel Serverless Function
// Calls FRED API server-side (no CORS issues, API key never exposed to browser)
//
// Strategy (post-fix HTTP 429):
// - In-memory cache (TTL 10 min) absorbe re-invocaciones intra-instancia y cold starts cercanos
// - Batched fetch en chunks de 10 series con 600ms gap → reduce burst de 31→10 simultáneos
// - Per-fetch timeout via AbortController (FETCH_TIMEOUT_MS)
// - Retry con linear backoff en 429 (rate limit), 5xx (upstream error) y network errors
// - Cache disabled cuando response contiene errores (avoid propagating bad state)

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FETCH_TIMEOUT_MS = 5500;          // 5.5s per individual fetch (buffer for Vercel 10s)
const MAX_RETRIES = 2;                  // 2 retries (3 attempts total)
const BACKOFF_SCHEDULE = [400, 800];    // ms before retry 1, retry 2
const CHUNK_SIZE = 10;                  // máx 10 series simultáneas hacia FRED
const CHUNK_GAP_MS = 600;               // delay entre chunks para no saturar el rate-limit
const CACHE_TTL_MS = 10 * 60 * 1000;    // 10 min

// Cache en memoria del proceso (persiste entre invocaciones de la misma instancia Vercel)
const memCache = new Map(); // key: `${seriesSorted}|${limit}` → { data, exp }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Single fetch with timeout + retry on 429/5xx/network errors
async function fetchSeries(s, apiKey, limit) {
  const url = `${FRED_BASE}?series_id=${s}&limit=${limit}&sort_order=desc&file_type=json&api_key=${apiKey}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      // 429 (rate limit) and 5xx (upstream error) → retry with backoff
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastErr = `HTTP ${response.status} attempt ${attempt + 1}`;
        if (attempt < MAX_RETRIES) {
          await sleep(BACKOFF_SCHEDULE[attempt] || 800);
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

      if (attempt < MAX_RETRIES) {
        await sleep(BACKOFF_SCHEDULE[attempt] || 800);
        continue;
      }
      return { error: lastErr, attempts: attempt + 1 };
    }
  }

  return { error: lastErr || 'unknown', attempts: MAX_RETRIES + 1 };
}

// Fetch en chunks de CHUNK_SIZE con gap entre chunks (anti rate-limit FRED)
async function fetchSeriesBatched(seriesList, apiKey, limit) {
  const results = {};
  for (let i = 0; i < seriesList.length; i += CHUNK_SIZE) {
    const chunk = seriesList.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(s => fetchSeries(s, apiKey, limit).then(r => [s, r]))
    );
    for (const [s, r] of chunkResults) results[s] = r;
    // Gap antes del próximo chunk (excepto último)
    if (i + CHUNK_SIZE < seriesList.length) await sleep(CHUNK_GAP_MS);
  }
  return results;
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
  const cacheKey = [...seriesList].sort().join(',') + '|' + limit;
  const tStart = Date.now();

  // Cache HIT: respuesta inmediata sin tocar FRED
  const cached = memCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    console.log(`[FRED] cache HIT · ${seriesList.length} series · ${Date.now() - tStart}ms`);
    return res.status(200).json(cached.data);
  }

  // Cache MISS: fetch con batching
  const results = await fetchSeriesBatched(seriesList, apiKey, limit);

  // Telemetría
  const ok = seriesList.filter(s => Array.isArray(results[s]));
  const empty = seriesList.filter(s => Array.isArray(results[s]) && results[s].length === 0);
  const failed = seriesList.filter(s => !Array.isArray(results[s]));
  const elapsed = Date.now() - tStart;
  console.log(`[FRED] cache MISS · ${seriesList.length} series in ${elapsed}ms · ok=${ok.length} empty=${empty.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('[FRED] failed:', failed.map(s => `${s}=${results[s]?.error || '?'}`).join(' · '));
  }

  // Solo cacheamos respuestas exitosas (no propagamos errores)
  if (failed.length === 0) {
    memCache.set(cacheKey, { data: results, exp: Date.now() + CACHE_TTL_MS });
  }

  res.setHeader('X-Cache', 'MISS');
  const cacheControl = failed.length > 0
    ? 'max-age=0, no-cache, no-store'
    : 's-maxage=3600, stale-while-revalidate=600';
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).json(results);
};
