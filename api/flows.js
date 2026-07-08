// api/flows.js — Shares Outstanding + AUM de ETFs (Fase C Pipeline de Capital, 2026-07-07)
// Los FLUJOS REALES de un ETF son creations/redemptions = Δ shares outstanding × precio.
// etfdb/etf.com bloquean scraping (403 Cloudflare) → computamos el flujo de primera mano:
// este endpoint scrapea sharesOut+AUM de stockanalysis.com (HTML estático, misma infra
// que api/holdings.js) y el frontend construye el historial muestreando 1 vez al día
// (localStorage). Cache CDN 12h.

const TIMEOUT_MS = 6000;
const CONCURRENCY = 4;

const MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

async function fetchEtfStats(etf) {
  const url = `https://stockanalysis.com/etf/${etf.toLowerCase()}/`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital-Dashboard/1.0)' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  // La página incrusta un JSON limpio: sharesOut:"650.31M" · aum:"$117.78B"
  // (la tabla HTML tiene clases CSS con dígitos entre label y valor → regex frágil)
  const so = html.match(/sharesOut:"([\d.,]+)\s*([KMBT])"/i);
  const au = html.match(/aum:"\$?([\d.,]+)\s*([KMBT])"/i);
  const parse = m => m ? parseFloat(m[1].replace(/,/g, '')) * (MULT[m[2].toUpperCase()] || 1) : null;
  const sharesOut = parse(so);
  const aum = parse(au);
  if (!sharesOut) throw new Error('parse sharesOut vacío (¿cambió el HTML?)');
  // Sanity: los sector SPDRs viven entre ~10M y ~2B shares
  if (sharesOut < 1e5 || sharesOut > 1e11) throw new Error(`sharesOut fuera de rango: ${sharesOut}`);
  return { sharesOut, aum };
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

  const data = {};
  const errors = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const chunk = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async etf => {
      try { data[etf] = await fetchEtfStats(etf); }
      catch (e) { errors.push(`${etf}=${e.message}`); }
    }));
  }

  const okCount = Object.keys(data).length;
  res.setHeader('Cache-Control', okCount >= tickers.length / 2
    ? 's-maxage=43200, stale-while-revalidate=21600'
    : 'max-age=0, no-cache');
  return res.status(200).json({ data, errors, fetched: new Date().toISOString() });
};
