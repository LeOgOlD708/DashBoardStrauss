// api/yahoo.js — Vercel Serverless Function
// Fetches ETF prices from Yahoo Finance server-side

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Falta el parámetro ?tickers=' });

  const tickerList = tickers.split(',').map(t => t.trim()).filter(Boolean);
  const results = {};

  await Promise.all(
    tickerList.map(async (ticker) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&includePrePost=false`;

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          }
        });

        if (!response.ok) {
          results[ticker] = { error: `HTTP ${response.status}` };
          return;
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result) {
          results[ticker] = { error: 'Sin datos de Yahoo Finance' };
          return;
        }

        const closes     = result.indicators.quote[0].close;
        const timestamps = result.timestamp;

        const valid = timestamps
          .map((t, i) => ({ t, v: closes[i] }))
          .filter(p => p.v != null && !isNaN(p.v));

        if (!valid.length) {
          results[ticker] = { error: 'Serie vacía' };
          return;
        }

        const latest   = valid[valid.length - 1].v;
        const prev     = valid[valid.length - 2]?.v || latest;
        const yearAgo  = valid[0].v;
        const monthAgo = valid[Math.max(0, valid.length - 22)]?.v || yearAgo;

        // Last 52 weeks for chart
        const hist52 = valid.slice(-52).map(p => parseFloat(p.v.toFixed(2)));
        const dates52 = valid.slice(-52).map(p =>
          new Date(p.t * 1000).toISOString().slice(0, 10)
        );

        results[ticker] = {
          price:  parseFloat(latest.toFixed(2)),
          chg1d:  parseFloat(((latest / prev - 1) * 100).toFixed(2)),
          chg1m:  parseFloat(((latest / monthAgo - 1) * 100).toFixed(1)),
          ytd:    parseFloat(((latest / yearAgo - 1) * 100).toFixed(1)),
          hist:   hist52,
          dates:  dates52,
        };

      } catch (e) {
        results[ticker] = { error: e.message };
      }
    })
  );

  // Cache 15 minutes — prices update during market hours
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(results);
};
