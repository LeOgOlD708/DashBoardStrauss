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

async function fetchTicker(ticker, range = '1y', interval = '1d') {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
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

  const yearAgo      = rows[0].close;
  const monthAgo     = rows[Math.max(0, rows.length - 22)].close;
  const fiveDaysAgo  = rows[Math.max(0, rows.length - 5)].close;
  const threeMonAgo  = rows[Math.max(0, rows.length - 66)].close;

  // Return up to 252 data points (1 year of daily data)
  const histFull = rows.slice(-252);

  return {
    price:  parseFloat(price.toFixed(2)),
    chg1d:  parseFloat(((price / prevClose    - 1) * 100).toFixed(2)),
    chg5d:  parseFloat(((price / fiveDaysAgo  - 1) * 100).toFixed(2)),
    chg1m:  parseFloat(((price / monthAgo     - 1) * 100).toFixed(1)),
    chg3m:  parseFloat(((price / threeMonAgo  - 1) * 100).toFixed(1)),
    ytd:    parseFloat(((price / yearAgo      - 1) * 100).toFixed(1)),
    hist:   histFull.map(r => parseFloat(r.close.toFixed(2))),
    dates:  histFull.map(r => r.date),
  };
}

async function fetchPriceOnly(ticker) {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return { error: 'Sin datos' };
  const meta      = result.meta;
  const price     = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  return {
    price:  parseFloat(price.toFixed(2)),
    chg1d:  parseFloat(((price / prevClose - 1) * 100).toFixed(2)),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tickers, range = '1y', priceOnly } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Falta ?tickers=' });

  const tickerList = tickers.split(',').map(t => decodeURIComponent(t.trim())).filter(Boolean);
  const results = {};

  // priceOnly=true → solo precio actual, cache 60s (para loop de 60s en frontend)
  if (priceOnly === 'true') {
    await Promise.all(
      tickerList.map(async (ticker) => {
        results[ticker] = await fetchPriceOnly(ticker);
      })
    );
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(results);
  }

  // interval automático según range
  const intervalMap = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d' };
  const interval = intervalMap[range] || '1d';

  await Promise.all(
    tickerList.map(async (ticker) => {
      results[ticker] = await fetchTicker(ticker, range, interval);
    })
  );

  // Cache: 1min para intraday, 5min para 5d, 15min para el resto
  const cacheTime = range === '1d' ? 60 : range === '5d' ? 300 : 900;
  res.setHeader('Cache-Control', `s-maxage=${cacheTime}, stale-while-revalidate=60`);
  return res.status(200).json(results);
};
