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
  // Guard (P3 2026-07-08): sin precio, price.toFixed() lanzaba dentro del Promise.all
  // del handler → 500 para TODOS los tickers del batch por un solo ticker malo.
  if (price == null || isNaN(price)) return { error: 'Sin regularMarketPrice' };
  // BUG FIX 2026-07-07: chartPreviousClose con range=1y es el cierre PREVIO AL RANGO
  // (hace ~1 año), NO el de ayer. chg1d salía como cambio anual (+19% en vez de -1%).
  // El cierre previo real se deriva del penúltimo cierre del histórico (ver abajo).

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];
  const volumes    = result.indicators?.quote?.[0]?.volume || [];
  // VP H/L (2026-07-12, research Dalton/TV): high/low por barra — SOLO se expone en intradía
  // (60d/5m) para el volume profile verdadero; en daily engordaría el payload sin uso
  const highsRaw = result.indicators?.quote?.[0]?.high || [];
  const lowsRaw  = result.indicators?.quote?.[0]?.low || [];

  const rows = timestamps
    .map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().slice(0, 10),
      close:  closes[i],
      volume: volumes[i],
      high:   highsRaw[i],
      low:    lowsRaw[i],
    }))
    .filter(r => r.close != null && !isNaN(r.close) && r.close > 0);

  if (rows.length < 2) return { error: 'Datos insuficientes' };

  // Cierre del día hábil previo = penúltima barra del histórico (la última barra es
  // la sesión actual/más reciente, cuyo close coincide con regularMarketPrice).
  const prevClose = rows[rows.length - 2].close;

  const monthAgo     = rows[Math.max(0, rows.length - 22)].close;
  const fiveDaysAgo  = rows[Math.max(0, rows.length - 5)].close;
  const threeMonAgo  = rows[Math.max(0, rows.length - 66)].close;
  // True YTD: last close of previous calendar year
  const jan1 = `${new Date().getFullYear()}-01-01`;
  const preYearRows = rows.filter(r => r.date < jan1);
  const ytdBase = preYearRows.length > 0 ? preYearRows[preYearRows.length - 1].close : rows[0].close;

  // Cap del histórico: 1 año diario por default; 3y diario (756) para el deep-dive de
  // analyze (α/β estables); 10y mensual (~120) para estacionalidad — Tanda 2 (2026-07-09);
  // 60d/5m (~4700 barras) para volume profile intradía — F-I2 (2026-07-10)
  const cap = range === '60d' ? 5000 : range === '3y' ? 756 : 252;
  const histFull = rows.slice(-cap);

  // ── Volumen — para Opportunity Scanner (Tab 02) ──
  // regularMarketVolume: volumen del día actual (último de la serie)
  // averageVolume: media de los últimos 20 días hábiles
  // fiftyDayAverage: media simple del precio últimos 50 días (setup técnico)
  const last20Vols = rows.slice(-20).map(r => r.volume).filter(v => v != null && !isNaN(v) && v > 0);
  const averageVolume = last20Vols.length > 0
    ? Math.round(last20Vols.reduce((a, b) => a + b, 0) / last20Vols.length)
    : null;
  const lastRow = rows[rows.length - 1];
  const regularMarketVolume = (lastRow.volume != null && !isNaN(lastRow.volume)) ? lastRow.volume : null;

  const last50Closes = rows.slice(-50).map(r => r.close);
  const fiftyDayAverage = last50Closes.length > 0
    ? parseFloat((last50Closes.reduce((a, b) => a + b, 0) / last50Closes.length).toFixed(2))
    : null;

  // Review 2026-07-09: con interval=1mo los offsets 5/22/66/20 son MESES, no días —
  // los campos de ventana corta serían basura silenciosa. Solo hist/dates son válidos.
  const daily = interval === '1d';
  // F-I2: en intradía (5m/30m) el rango no cruza el año previo → ytdBase sería el inicio
  // del rango y el "ytd" saldría como retorno del rango — basura silenciosa. Null.
  const intraday = interval === '5m' || interval === '30m';
  return {
    price:  parseFloat(price.toFixed(2)),
    chg1d:  daily ? parseFloat(((price / prevClose    - 1) * 100).toFixed(2)) : null,
    chg5d:  daily ? parseFloat(((price / fiveDaysAgo  - 1) * 100).toFixed(2)) : null,
    chg1m:  daily ? parseFloat(((price / monthAgo     - 1) * 100).toFixed(1)) : null,
    chg3m:  daily ? parseFloat(((price / threeMonAgo  - 1) * 100).toFixed(1)) : null,
    ytd:    intraday ? null : parseFloat(((price / ytdBase       - 1) * 100).toFixed(1)),
    hist:   histFull.map(r => parseFloat(r.close.toFixed(2))),
    dates:  histFull.map(r => r.date),
    // Fase A Pipeline de Capital 2026-07-07: serie diaria de volúmenes (alineada con hist)
    // para U/D Volume Ratio 50d y A/D proxy 13w — huella institucional computada client-side
    vols:   histFull.map(r => (r.volume != null && !isNaN(r.volume)) ? r.volume : null),
    // VP H/L: rangos reales por barra intradía → perfil de volumen VERDADERO (no aproximación por close)
    ...(intraday ? {
      his: histFull.map(r => (r.high != null && !isNaN(r.high)) ? parseFloat(r.high.toFixed(2)) : null),
      los: histFull.map(r => (r.low != null && !isNaN(r.low)) ? parseFloat(r.low.toFixed(2)) : null)
    } : {}),
    // Campos nuevos para Opportunity Scanner — additivos, no rompen callers existentes
    regularMarketVolume: daily ? regularMarketVolume : null,
    averageVolume: daily ? averageVolume : null,
    fiftyDayAverage: daily ? fiftyDayAverage : null,
    regularMarketChangePercent: daily ? parseFloat(((price / prevClose - 1) * 100).toFixed(2)) : null,
    regularMarketPrice: parseFloat(price.toFixed(2)),
  };
}

async function fetchPriceOnly(ticker) {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return { error: 'Sin datos' };
  const meta  = result.meta;
  const price = meta.regularMarketPrice;
  if (price == null || isNaN(price)) return { error: 'Sin regularMarketPrice' }; // guard P3
  // BUG FIX 2026-07-07: chartPreviousClose con range=5d es el cierre previo AL RANGO
  // (~6 días hábiles atrás), no el de ayer. Derivar del penúltimo cierre real.
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null && !isNaN(c) && c > 0);
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose ?? price);
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
        // try/catch por ticker (P3): una excepción no controlada rechazaba el
        // Promise.all completo → 500 para todo el batch por un ticker malo
        try { results[ticker] = await fetchPriceOnly(ticker); }
        catch (e) { results[ticker] = { error: e.message || 'fetch failed' }; }
      })
    );
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(results);
  }

  // interval automático según range · 10y mensual (2026-07-08): para el heatmap de estacionalidad
  // · 60d/5m (2026-07-10 F-I2): volume profile intradía (Yahoo permite 5m hasta 60 días)
  const intervalMap = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '3y': '1d', '10y': '1mo', '60d': '5m' };
  const interval = intervalMap[range] || '1d';

  await Promise.all(
    tickerList.map(async (ticker) => {
      try { results[ticker] = await fetchTicker(ticker, range, interval); }
      catch (e) { results[ticker] = { error: e.message || 'fetch failed' }; }
    })
  );

  // Cache: 1min para intraday, 5min para 5d, 24h para 10y mensual, 15min para el resto
  const cacheTime = range === '1d' ? 60 : range === '5d' ? 300 : range === '10y' ? 86400 : range === '3y' ? 21600 : 900;
  res.setHeader('Cache-Control', `s-maxage=${cacheTime}, stale-while-revalidate=60`);
  return res.status(200).json(results);
};
