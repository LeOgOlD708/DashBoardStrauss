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

// Circuit breaker WAF (2026-07-11: Akamai escaló — bloquea API Y fredgraph desde IPs Vercel
// por ráfagas; el score Howell quedó en 0). Un 403 abre el circuito 10 min: las series
// siguientes van directo al fallback sin quemar 3 intentos × 5.5s cada una.
let wafUntil = 0;

// ── LAST-GOOD en el propio repo (misma infra que track/): la última lectura completa
// se guarda en fredcache/<hash>.json y se sirve cuando FRED bloquea — el dashboard
// degrada a "dato de hace N horas" en vez de a score 0. Lectura vía raw (público, sin token).
const GH_REPO2 = 'LeOgOlD708/DashBoardStrauss';
function keyHash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }
async function ghReadLastGood(hash) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO2}/main/fredcache/${hash}.json`, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'DashBoardStrauss' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function ghWriteLastGood(hash, payload) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  try {
    const url = `https://api.github.com/repos/${GH_REPO2}/contents/fredcache/${hash}.json`;
    const H = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'DashBoardStrauss' };
    const cur = await fetch(url, { headers: H, signal: AbortSignal.timeout(4000) });
    let sha;
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try { // throttle: si el last-good existente tiene <6h, no commitear otro
        const prev = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
        if (prev?.ts && Date.now() - prev.ts < 6 * 3600000) return;
      } catch (e) {}
    }
    await fetch(url, {
      method: 'PUT', headers: H, signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ message: 'fredcache: last-good ' + hash + ' [vercel skip]', content: Buffer.from(JSON.stringify(payload)).toString('base64'), ...(sha ? { sha } : {}) })
    });
    console.log(`[FRED] last-good ${hash} guardado en el repo`);
  } catch (e) { /* best-effort */ }
}

// UA de navegador: el WAF de FRED (Akamai) devolvió 403 a requests desde IPs Vercel
// (visto 2026-07-10, TODAS las series; key inválida da 400 → no era la key)
const FRED_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'application/json' };

// Fallback anti-WAF: fredgraph.csv (endpoint público del graficador, sin key, host distinto).
// CSV ascendente "DATE,SERIE" → mismo shape desc que la API oficial.
async function fredgraphFallback(s, limit) {
  for (let att = 0; att < 2; att++) { // 2026-07-11: el WAF también golpea fredgraph a ráfagas — reintentar 1×
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s}`, { signal: controller.signal, headers: { ...FRED_HEADERS, Accept: 'text/csv' } });
      clearTimeout(timeoutId);
      if (!r.ok) { if (att === 0) { await sleep(500); continue; } return null; }
      const lines = (await r.text()).trim().split('\n').slice(1); // header DATE,SERIE
      const obs = [];
      for (const ln of lines) {
        const c = ln.indexOf(',');
        if (c < 0) continue;
        const v = ln.slice(c + 1).trim();
        if (v === '.' || v === '') continue;
        const n = parseFloat(v);
        if (isFinite(n)) obs.push({ date: ln.slice(0, c), value: n });
      }
      if (!obs.length) return null;
      console.log(`[FRED] ${s}: rescatada vía fredgraph.csv (${obs.length} obs)`);
      return obs.slice(-limit).reverse(); // desc, como la API
    } catch (e) {
      clearTimeout(timeoutId);
      if (att === 0) { await sleep(500); continue; }
      return null;
    }
  }
  return null;
}

// Single fetch with timeout + retry on 403(WAF)/429/5xx/network errors
async function fetchSeries(s, apiKey, limit) {
  const url = `${FRED_BASE}?series_id=${s}&limit=${limit}&sort_order=desc&file_type=json&api_key=${apiKey}`;
  let lastErr = null;

  // Circuit breaker: si el WAF ya bloqueó hace <10 min, no quemar 3 intentos contra la API —
  // directo al fallback (y si también falla, el handler intentará el last-good del repo)
  if (Date.now() < wafUntil) {
    const rescued = await fredgraphFallback(s, limit);
    if (rescued) return rescued;
    return { error: 'WAF 403 (circuito abierto)', attempts: 0 };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal, headers: FRED_HEADERS });
      clearTimeout(timeoutId);

      // 403 (WAF Akamai vs IP datacenter), 429 (rate limit) y 5xx → retry with backoff
      if (response.status === 403 || response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (response.status === 403) wafUntil = Date.now() + 10 * 60 * 1000; // abre el circuito para el resto de la invocación/instancia
        lastErr = `HTTP ${response.status} attempt ${attempt + 1}`;
        if (attempt < MAX_RETRIES) {
          await sleep(BACKOFF_SCHEDULE[attempt] || 800);
          continue;
        }
        const rescued = await fredgraphFallback(s, limit);
        if (rescued) return rescued;
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

  const { series } = req.query;
  if (!series) return res.status(400).json({ error: 'Falta el parámetro ?series=' });
  // limit numérico acotado 1-200 (si llega basura → default 52 en vez del error opaco de FRED)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 52, 1), 200);

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
  let empty = seriesList.filter(s => Array.isArray(results[s]) && results[s].length === 0);
  let failed = seriesList.filter(s => !Array.isArray(results[s]));
  const elapsed = Date.now() - tStart;
  console.log(`[FRED] cache MISS · ${seriesList.length} series in ${elapsed}ms · ok=${ok.length} empty=${empty.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('[FRED] failed:', failed.map(s => `${s}=${results[s]?.error || '?'}`).join(' · '));
  }

  // LAST-GOOD (2026-07-11): si el WAF tumbó series, rescatar la última lectura completa
  // guardada en el repo — dato de hace horas > score en 0. Marcado con X-Fred-Stale.
  const hash = keyHash(cacheKey);
  let rescuedStale = 0;
  if (failed.length || empty.length) {
    const gc = await ghReadLastGood(hash);
    if (gc?.data) {
      for (const s of [...failed, ...empty]) {
        if (Array.isArray(gc.data[s]) && gc.data[s].length) { results[s] = gc.data[s]; rescuedStale++; }
      }
      if (rescuedStale) {
        res.setHeader('X-Fred-Stale', String(gc.ts || ''));
        console.log(`[FRED] ${rescuedStale} series rescatadas del last-good del repo (ts ${gc.ts ? new Date(gc.ts).toISOString() : '?'})`);
        empty = seriesList.filter(s => Array.isArray(results[s]) && results[s].length === 0);
        failed = seriesList.filter(s => !Array.isArray(results[s]));
      }
    }
  }

  // Solo cacheamos respuestas COMPLETAS (fix 2026-07-08: una serie vacía por hiccup
  // de FRED quedaba cacheada 1h en CDN → score parcial pegajoso hasta expirar; visto
  // en vivo con WRBWFRBL=[] → score 2.0/8 "Reservas caídas" servido desde cache)
  const incomplete = failed.length + empty.length;
  if (incomplete === 0 && !rescuedStale) {
    memCache.set(cacheKey, { data: results, exp: Date.now() + CACHE_TTL_MS });
    await ghWriteLastGood(hash, { ts: Date.now(), key: cacheKey, data: results }); // throttled 6h internamente
  }

  res.setHeader('X-Cache', 'MISS');
  const cacheControl = incomplete > 0
    ? 'max-age=0, no-cache, no-store'
    : rescuedStale
      ? 's-maxage=300, stale-while-revalidate=600' // completo pero con series stale — reintentar pronto
      : 's-maxage=3600, stale-while-revalidate=600';
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).json(results);
};
