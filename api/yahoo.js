// api/yahoo.js — Yahoo Finance v8 chart API (server-side proxy)
// Requiere headers de browser para evitar bloqueo de Yahoo

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com',
  'Origin': 'https://finance.yahoo.com',
};

async function fetchTicker(ticker) {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: YF_HEADERS });

  if (!res.ok) return { error: `HTTP ${res.status}` };

  const json = await res.json();
  if (json?.chart?.error) return { error: json.chart.error.description || 'Error Yahoo' };

  const result = json?.chart?.result?.[0];
  if (!result) return { error: 'Sin datos' };

  const meta      = result.meta;
  const price     = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];

  const rows = timestamps
    .map((ts, i) => ({
      date:  new Date(ts * 1000).toISOString().slice(0, 10),
      close: closes[i],
    }))
    .filter(r => r.close != null && !isNaN(r.close) && r.close > 0);

  if (rows.length < 2) return { error: 'Datos insuficientes' };

  const yearAgo  = rows[0].close;
  const monthAgo = rows[Math.max(0, rows.length - 22)].close;
  const hist52   = rows.slice(-52);

  return {
    price: parseFloat(price.toFixed(2)),
    chg1d: parseFloat(((price / prevClose - 1) * 100).toFixed(2)),
    chg1m: parseFloat(((price / monthAgo  - 1) * 100).toFixed(1)),
    ytd:   parseFloat(((price / yearAgo   - 1) * 100).toFixed(1)),
    hist:  hist52.map(r => parseFloat(r.close.toFixed(2))),
    dates: hist52.map(r => r.date),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Falta ?tickers=' });

  const tickerList = tickers.split(',').map(t => decodeURIComponent(t.trim())).filter(Boolean);
  const results = {};

  await Promise.all(
    tickerList.map(async (ticker) => {
      results[ticker] = await fetchTicker(ticker);
    })
  );

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(results);
};
