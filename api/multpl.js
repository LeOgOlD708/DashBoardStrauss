// api/multpl.js — S&P 500 trailing P/E automático (scrape multpl.com)
// Reemplaza el refresh MENSUAL MANUAL de SPY_TRAILING_EY (regla "100% automático").
// Cache CDN 12h — el P/E trailing cambia despacio. Frontend cae al valor
// hardcoded si este endpoint falla (fallback documentado en index.html).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const r = await fetch('https://www.multpl.com/s-p-500-pe-ratio', {
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital-Dashboard/1.0)' }
    });
    if (!r.ok) throw new Error(`multpl HTTP ${r.status}`);
    const html = await r.text();

    // El valor vive en <div id="current">Current S&P 500 PE Ratio: 25.44 ...</div>
    const m = html.match(/Current S&P 500 PE Ratio[^0-9]*([\d]{1,3}\.[\d]{1,2})/i)
           || html.match(/id="current"[^>]*>[^0-9]*([\d]{1,3}\.[\d]{1,2})/i);
    if (!m) throw new Error('No se pudo parsear el P/E de multpl (¿cambió el HTML?)');

    const pe = parseFloat(m[1]);
    // Sanity: P/E trailing S&P histórico vive en ~5-45. Fuera de eso = parse roto.
    if (!(pe > 5 && pe < 60)) throw new Error(`P/E fuera de rango sano: ${pe}`);

    const ey = +(100 / pe).toFixed(2);
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    return res.status(200).json({ pe, ey, source: 'multpl.com', fetched: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
