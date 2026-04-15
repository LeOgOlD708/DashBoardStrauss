// api/yahoo.js — Vercel Serverless Function
// Fetches ETF + VIX prices from Yahoo Finance with crumb authentication

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Module-level crumb cache (reused across warm Lambda invocations)
let _crumb  = null;
let _cookie = null;
let _expiry = 0;

async function fetchCrumb() {
  if (_crumb && Date.now() < _expiry) {
    return { crumb: _crumb, cookie: _cookie };
  }

  // Step 1 — get Yahoo Finance session cookie
  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });

  // Collect all Set-Cookie values
  const rawCookies = r1.headers.get('set-cookie') || '';
  // We only need the A1/A3 value; grab the first token before any ";"
  const cookieLine = rawCookies.split(',').map(s => s.trim().split(';')[0]).join('; ');
  const cookie = cookieLine || '';

  // Step 2 — exchange cookie for crumb
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Cookie': cookie,
    },
  });

  if (!r2.ok) throw new Error(`getcrumb HTTP ${r2.status}`);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.startsWith('<')) throw new Error('crumb inválido — Yahoo devolvió HTML');

  _crumb  = crumb;
  _cookie = cookie;
  _expiry = Date.now() + 50 * 60 * 1000; // cache 50 min

  return { crumb, cookie };
}

async function fetchTicker(ticker, crumb, cookie) {
  const encoded = encodeURIComponent(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1y&crumb=${encodeURIComponent(crumb)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookie,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) return { error: `HTTP ${res.status}` };

  const d = await res.json();
  const result = d.chart?.result?.[0];
  if (!result) return { error: 'Sin datos' };

  const closes     = result.indicators.quote[0].close;
  const timestamps = result.timestamp;

  const valid = timestamps
    .map((t, i) => ({ t, v: closes[i] }))
    .filter(p => p.v != null && !isNaN(p.v));

  if (!valid.length) return { error: 'Serie vacía' };

  const latest   = valid[valid.length - 1].v;
  const prev     = valid[valid.length - 2]?.v || latest;
  const yearAgo  = valid[0].v;
  const monthAgo = valid[Math.max(0, valid.length - 22)]?.v || yearAgo;

  const hist52  = valid.slice(-52).map(p => parseFloat(p.v.toFixed(2)));
  const dates52 = valid.slice(-52).map(p =>
    new Date(p.t * 1000).toISOString().slice(0, 10)
  );

  return {
    price:  parseFloat(latest.toFixed(2)),
    chg1d:  parseFloat(((latest / prev     - 1) * 100).toFixed(2)),
    chg1m:  parseFloat(((latest / monthAgo - 1) * 100).toFixed(1)),
    ytd:    parseFloat(((latest / yearAgo  - 1) * 100).toFixed(1)),
    hist:   hist52,
    dates:  dates52,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Falta ?tickers=' });

  const tickerList = tickers.split(',').map(t => decodeURIComponent(t.trim())).filter(Boolean);

  let crumb, cookie;
  try {
    ({ crumb, cookie } = await fetchCrumb());
  } catch (e) {
    return res.status(502).json({ error: `No se pudo obtener crumb de Yahoo: ${e.message}` });
  }

  const results = {};
  await Promise.all(
    tickerList.map(async (ticker) => {
      try {
        results[ticker] = await fetchTicker(ticker, crumb, cookie);
      } catch (e) {
        results[ticker] = { error: e.message };
      }
    })
  );

  // If crumb was rejected (401 on all), clear cache so next request retries
  const allFailed = Object.values(results).every(v => v.error?.includes('401'));
  if (allFailed) { _crumb = null; _cookie = null; _expiry = 0; }

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(results);
};
