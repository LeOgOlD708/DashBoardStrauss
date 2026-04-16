// api/yahoo.js — Stooq.com proxy (libre, sin API key, sin bloqueo IP desde Vercel)
// Soporta ETFs (.us) y ^VIX. VVIX y VIX3M no disponibles en Stooq.

function toStooq(ticker) {
  if (ticker.startsWith('^')) return ticker.toLowerCase(); // ^VIX → ^vix
  return ticker.toLowerCase() + '.us';                     // GLD  → gld.us
}

async function fetchTicker(ticker) {
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const d1 = from.toISOString().slice(0, 10).replace(/-/g, '');

  const symbol = toStooq(ticker);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${d1}`;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const text  = await res.text();
  const lines = text.trim().split('\n');

  if (lines.length < 2 || !lines[0].toLowerCase().includes('close')) {
    return { error: 'Respuesta inesperada de Stooq' };
  }

  const rows = lines
    .slice(1)
    .map(l => { const p = l.split(','); return { date: p[0], close: parseFloat(p[4]) }; })
    .filter(r => r.date && !isNaN(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length < 2) return { error: 'Sin datos suficientes' };

  const latest   = rows[rows.length - 1].close;
  const prev     = rows[rows.length - 2].close;
  const yearAgo  = rows[0].close;
  const monthAgo = rows[Math.max(0, rows.length - 22)].close;

  return {
    price: parseFloat(latest.toFixed(2)),
    chg1d: parseFloat(((latest / prev     - 1) * 100).toFixed(2)),
    chg1m: parseFloat(((latest / monthAgo - 1) * 100).toFixed(1)),
    ytd:   parseFloat(((latest / yearAgo  - 1) * 100).toFixed(1)),
    hist:  rows.slice(-52).map(r => parseFloat(r.close.toFixed(2))),
    dates: rows.slice(-52).map(r => r.date),
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
      try { results[ticker] = await fetchTicker(ticker); }
      catch (e) { results[ticker] = { error: e.message }; }
    })
  );

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(results);
};
