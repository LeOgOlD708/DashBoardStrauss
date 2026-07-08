// api/holdings.js — Top holdings de ETFs scrapeados de stockanalysis.com (Fase A2, 2026-07-07)
// Regla "100% automático": reemplaza el hardcode trimestral sectorConstituents (que vencía
// y quedaba stale). stockanalysis publica los top-25 holdings gratis en HTML estático.
// Cache CDN 24h — los holdings cambian trimestralmente. Fallback en frontend: hardcode top-5.

const TIMEOUT_MS = 6000;
const CONCURRENCY = 4;
const TOP_N = 10;

async function fetchHoldings(etf) {
  const url = `https://stockanalysis.com/etf/${etf.toLowerCase()}/holdings/`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital-Dashboard/1.0)' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  // Los símbolos aparecen como links /stocks/nvda/ en el orden de la tabla (por peso desc).
  // La navegación del sitio también usa /stocks/xxx/ (screener, compare, industry) → blacklist.
  const NAV_WORDS = new Set(['SCREENER', 'COMPARE', 'INDUSTRY', 'LIST', 'RANKINGS', 'SECTOR', 'NEWS', 'ANALYSIS', 'CHART', 'QUOTE', 'COMPANY']);
  const seen = new Set();
  const out = [];
  const re = /href="\/stocks\/([a-z0-9.\-]{1,6})\/"/gi; // {1,6} coherente con el filtro de longitud de abajo
  let m;
  while ((m = re.exec(html)) !== null && out.length < TOP_N) {
    // Normalizar a formato Yahoo: mayúsculas, punto→guión (brk.b → BRK-B)
    const sym = m[1].toUpperCase().replace(/\./g, '-');
    if (NAV_WORDS.has(sym) || sym.length > 6) continue;
    if (!seen.has(sym)) { seen.add(sym); out.push(sym); }
  }
  if (!out.length) throw new Error('parse vacío (¿cambió el HTML?)');
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const raw = String(req.query.tickers || '');
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: 'Falta ?tickers=XLK,XLF' });
  if (tickers.length > 15) return res.status(400).json({ error: 'Máximo 15 ETFs por request' });
  if (tickers.some(t => !/^[A-Z]{2,6}$/.test(t))) return res.status(400).json({ error: 'Ticker inválido' });

  const holdings = {};
  const errors = [];
  // Lotes con concurrencia limitada (11 scrapes seriales serían lentos; 11 paralelos, agresivos)
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const chunk = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async etf => {
      try { holdings[etf] = await fetchHoldings(etf); }
      catch (e) { errors.push(`${etf}=${e.message}`); }
    }));
  }

  const okCount = Object.keys(holdings).length;
  // No cachear respuestas mayormente fallidas
  res.setHeader('Cache-Control', okCount >= tickers.length / 2
    ? 's-maxage=86400, stale-while-revalidate=43200'
    : 'max-age=0, no-cache');
  return res.status(200).json({ holdings, errors, fetched: new Date().toISOString() });
};
