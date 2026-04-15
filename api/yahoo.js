// api/yahoo.js — Vercel Serverless Function
// Yahoo Finance v8 chart API con crumb authentication

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

// Module-level cache (reutilizado entre invocaciones calientes de Lambda)
let _crumb  = null;
let _cookie = null;
let _expiry = 0;

// ── Extrae Set-Cookie headers de una Response ──
function extractCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    // Node.js 18+ native fetch
    return response.headers.getSetCookie()
      .map(h => h.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }
  // Fallback: concatenated single header
  const raw = response.headers.get('set-cookie') || '';
  return raw
    .split(',')
    .map(h => h.trim().split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

// ── Obtiene crumb de Yahoo Finance ──
async function fetchCrumb() {
  if (_crumb && Date.now() < _expiry) {
    return { crumb: _crumb, cookie: _cookie };
  }

  const baseHeaders = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Intento 1 — crumb directo sin cookie (funciona desde algunas IPs)
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...baseHeaders, 'Accept': 'text/plain' },
    });
    if (r.ok) {
      const text = (await r.text()).trim();
      if (text && !text.startsWith('<') && text.length >= 3) {
        _crumb = text; _cookie = ''; _expiry = Date.now() + 50 * 60 * 1000;
        return { crumb: _crumb, cookie: _cookie };
      }
    }
  } catch (_) { /* continúa */ }

  // Intento 2 — obtener cookie de finance.yahoo.com, luego crumb
  const r1 = await fetch('https://finance.yahoo.com/', {
    headers: {
      ...baseHeaders,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const cookieStr = extractCookies(r1);
  if (!cookieStr) {
    throw new Error('finance.yahoo.com no devolvió cookies (posible bloqueo de IP)');
  }

  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      ...baseHeaders,
      'Accept': 'text/plain',
      'Cookie': cookieStr,
    },
  });

  if (!r2.ok) throw new Error(`getcrumb devolvió HTTP ${r2.status}`);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.startsWith('<') || crumb.length < 3) {
    throw new Error('Yahoo devolvió HTML en lugar del crumb (sesión inválida)');
  }

  _crumb = crumb; _cookie = cookieStr; _expiry = Date.now() + 50 * 60 * 1000;
  return { crumb: _crumb, cookie: _cookie };
}

// ── Obtiene datos OHLCV de un ticker ──
async function fetchTicker(ticker, crumb, cookie) {
  const encoded = encodeURIComponent(ticker);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
    `?interval=1d&range=1y&crumb=${encodeURIComponent(crumb)}`;

  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
  };
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const d = await res.json();
  const result = d.chart?.result?.[0];
  if (!result) return { error: d.chart?.error?.description || 'Sin datos' };

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

  return {
    price:  parseFloat(latest.toFixed(2)),
    chg1d:  parseFloat(((latest / prev     - 1) * 100).toFixed(2)),
    chg1m:  parseFloat(((latest / monthAgo - 1) * 100).toFixed(1)),
    ytd:    parseFloat(((latest / yearAgo  - 1) * 100).toFixed(1)),
    hist:   valid.slice(-52).map(p => parseFloat(p.v.toFixed(2))),
    dates:  valid.slice(-52).map(p => new Date(p.t * 1000).toISOString().slice(0, 10)),
  };
}

// ── Handler principal ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Falta ?tickers=' });

  const tickerList = tickers.split(',')
    .map(t => decodeURIComponent(t.trim()))
    .filter(Boolean);

  let crumb, cookie;
  try {
    ({ crumb, cookie } = await fetchCrumb());
  } catch (e) {
    return res.status(502).json({
      error: `Crumb Yahoo Finance: ${e.message}`,
    });
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

  // Si el crumb fue rechazado (todos 401), invalidar cache para próxima llamada
  const all401 = Object.values(results).every(v => v.error?.includes('401'));
  if (all401) { _crumb = null; _cookie = null; _expiry = 0; }

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(results);
};
