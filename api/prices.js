// api/prices.js — FMP Stable API
// Llamadas individuales paralelas (más confiable que batch)

const FMP     = 'https://financialmodelingprep.com/stable';
const TICKERS = ['GLD','GDX','XLE','XLV','XLP','XLU','SPY','QQQ','TLT','XLF','IWM','XLB'];

async function getQuote(ticker, key) {
  const r = await fetch(`${FMP}/quote?symbol=${ticker}&apikey=${key}`);
  if (!r.ok) throw new Error(`${ticker}: HTTP ${r.status}`);
  const d = await r.json();
  // Stable API returns array
  const q = Array.isArray(d) ? d[0] : d;
  if (!q || !q.price) throw new Error(`${ticker}: sin datos`);
  return q;
}

async function getHistory(ticker, key, from) {
  const r = await fetch(`${FMP}/historical-price-eod/full?symbol=${ticker}&from=${from}&apikey=${key}`);
  if (!r.ok) return [];
  const d = await r.json();
  return d.historical || [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FMP_API_KEY;
  if (!key) return res.status(500).json({ error: 'FMP_API_KEY no configurada en Vercel' });

  const from = `${new Date().getFullYear()}-01-01`;
  const results = {};

  await Promise.all(TICKERS.map(async (ticker) => {
    try {
      const [q, hist] = await Promise.all([
        getQuote(ticker, key),
        getHistory(ticker, key, from),
      ]);

      const price    = parseFloat(q.price);
      // hist: newest first → index 0 = today, index 21 = ~1 month ago
      const monthAgo = hist[21]?.close  || hist[hist.length - 1]?.close || price;
      const ytdOpen  = hist[hist.length - 1]?.close || price;
      const sorted   = [...hist].reverse(); // oldest→newest for chart

      results[ticker] = {
        price: parseFloat(price.toFixed(2)),
        chg1d: parseFloat((q.changePercentage || 0).toFixed(2)),  // stable uses changePercentage
        chg1m: parseFloat(((price / monthAgo - 1) * 100).toFixed(1)),
        ytd:   parseFloat(((price / ytdOpen   - 1) * 100).toFixed(1)),
        hist:  sorted.slice(-52).map(h => parseFloat((h.close || 0).toFixed(2))),
        dates: sorted.slice(-52).map(h => h.date),
      };
    } catch(e) {
      console.error(ticker, e.message);
      results[ticker] = { error: e.message };
    }
  }));

  const ok = Object.values(results).filter(v => !v.error).length;
  if (ok === 0) return res.status(500).json({ error: 'Sin datos. Verifica FMP_API_KEY.', details: results });

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(results);
};
