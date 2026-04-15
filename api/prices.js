// api/prices.js — Vercel Serverless Function
// Precios de ETFs via Financial Modeling Prep (FMP)
// VIX/VVIX se obtienen desde el browser directamente (Yahoo Finance)

const FMP     = 'https://financialmodelingprep.com/api/v3';
const TICKERS = ['GLD','GDX','XLE','XLV','XLP','XLU','SPY','QQQ','TLT','XLF','IWM','XLB'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FMP_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'FMP_API_KEY no configurada. Agrégala en Vercel → Settings → Environment Variables.'
    });
  }

  const yearStart = `${new Date().getFullYear()}-01-01`;
  const results   = {};

  // ── Paso 1: Quotes en batch (1 llamada para todos los tickers) ──
  let quotes = [];
  try {
    const r = await fetch(`${FMP}/quote/${TICKERS.join(',')}?apikey=${key}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    quotes = await r.json();
    if (!Array.isArray(quotes)) throw new Error(JSON.stringify(quotes).slice(0, 200));
  } catch(e) {
    return res.status(500).json({ error: 'FMP quotes: ' + e.message });
  }

  // ── Paso 2: Histórico individual para YTD y 1M ──
  await Promise.all(TICKERS.map(async (ticker) => {
    const q = quotes.find(x => x.symbol === ticker);
    if (!q) return;

    const price = parseFloat(q.price);

    try {
      const r    = await fetch(`${FMP}/historical-price-full/${ticker}?from=${yearStart}&apikey=${key}`);
      const d    = await r.json();
      const hist = d.historical || []; // newest first

      const monthAgo = hist[21]?.close || hist[hist.length-1]?.close || price;
      const ytdOpen  = hist[hist.length-1]?.close || price;

      // hist is newest→oldest, reverse for chart (oldest→newest)
      const sorted = [...hist].reverse();

      results[ticker] = {
        price: parseFloat(price.toFixed(2)),
        chg1d: parseFloat((q.changesPercentage || 0).toFixed(2)),
        chg1m: parseFloat(((price / monthAgo - 1) * 100).toFixed(1)),
        ytd:   parseFloat(((price / ytdOpen   - 1) * 100).toFixed(1)),
        hist:  sorted.slice(-52).map(h => parseFloat((h.close || 0).toFixed(2))),
        dates: sorted.slice(-52).map(h => h.date),
      };
    } catch(e) {
      // Fallback: solo precio y 1-day del quote
      results[ticker] = {
        price: parseFloat(price.toFixed(2)),
        chg1d: parseFloat((q.changesPercentage || 0).toFixed(2)),
        chg1m: 0, ytd: 0, hist: [], dates: [],
      };
    }
  }));

  // Cache 30 min en Vercel edge — precios no cambian cada segundo
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(results);
};
