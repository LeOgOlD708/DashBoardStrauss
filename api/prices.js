// api/prices.js — FMP Stable API (endpoints actualizados post-Agosto 2025)
const FMP     = 'https://financialmodelingprep.com/stable';
const TICKERS = ['GLD','GDX','XLE','XLV','XLP','XLU','SPY','QQQ','TLT','XLF','IWM','XLB'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FMP_API_KEY;
  if (!key) return res.status(500).json({
    error: 'FMP_API_KEY no configurada en Vercel → Settings → Environment Variables'
  });

  const yearStart = `${new Date().getFullYear()}-01-01`;
  const results   = {};

  // ── Paso 1: quotes en batch ──
  let quotes = [];
  try {
    // New stable batch endpoint
    const url = `${FMP}/batch-quote?symbols=${TICKERS.join(',')}&apikey=${key}`;
    const r   = await fetch(url);
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0,200)}`);
    const parsed = JSON.parse(body);
    // Stable API returns array or { data: [...] }
    quotes = Array.isArray(parsed) ? parsed : (parsed.data || []);
    if (!quotes.length) throw new Error('Sin datos: ' + body.slice(0,200));
  } catch(e) {
    // Fallback: try individual quote
    try {
      const r = await fetch(`${FMP}/quote?symbol=SPY&apikey=${key}`);
      const b = await r.text();
      throw new Error(`batch falló, test individual SPY: HTTP ${r.status} — ${b.slice(0,200)}`);
    } catch(e2) {
      return res.status(500).json({ error: e.message + ' | ' + e2.message });
    }
  }

  // ── Paso 2: histórico para YTD y 1M ──
  await Promise.all(TICKERS.map(async (ticker) => {
    const q = quotes.find(x => x.symbol === ticker);
    if (!q) return;
    const price = parseFloat(q.price);

    try {
      // New stable historical endpoint
      const r   = await fetch(`${FMP}/historical-price-eod/full?symbol=${ticker}&from=${yearStart}&apikey=${key}`);
      const d   = await r.json();
      // Response: { symbol, historical: [...] } or array
      const hist = (d.historical || d || []);
      const arr  = Array.isArray(hist) ? hist : [];

      // arr is newest→oldest
      const monthAgo = arr[21]?.close || arr[arr.length-1]?.close || price;
      const ytdOpen  = arr[arr.length-1]?.close || price;
      const sorted   = [...arr].reverse(); // oldest→newest for chart

      results[ticker] = {
        price: parseFloat(price.toFixed(2)),
        chg1d: parseFloat((q.changesPercentage || q.change_percentage || 0).toFixed(2)),
        chg1m: parseFloat(((price / monthAgo - 1) * 100).toFixed(1)),
        ytd:   parseFloat(((price / ytdOpen   - 1) * 100).toFixed(1)),
        hist:  sorted.slice(-52).map(h => parseFloat((h.close||0).toFixed(2))),
        dates: sorted.slice(-52).map(h => h.date),
      };
    } catch(e) {
      results[ticker] = {
        price: parseFloat(price.toFixed(2)),
        chg1d: parseFloat((q.changesPercentage || 0).toFixed(2)),
        chg1m: 0, ytd: 0, hist: [], dates: [],
      };
    }
  }));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(results);
};
