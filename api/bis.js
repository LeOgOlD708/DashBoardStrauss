// api/bis.js — BIS Global Liquidity Indicators (dataset WS_GLI) — GLI v3 (2026-07-08)
// LA PATA REAL DEL EURODÓLAR/CROSS-BORDER que ningún proxy gratuito cubría:
// "International claims on non-banks (worldwide)" — crecimiento YoY % COMPUTADO POR EL
// PROPIO BIS (unit 771). Trimestral, rezago ~1 trimestre. Es la fuente que CrossBorder
// Capital usa como insumo de su GLI. API pública, sin key. Cache CDN 24h.
// Calibración empírica 15 años (2026-07-08): min −2.5 · mediana 4.1 · max 11.0.

// Tanda 2e (2026-07-09): ?serie= parametrizada con ALLOWLIST — claves VERIFICADAS contra la
// API real (USD EMEs +6.2 / EUR EMEs +11.6 / JPY EMEs +2.5 / USD global +8.5 al validar).
const SERIES = {
  xb:      { key: 'Q.TO1.5J.N.B.I.A.771',  name: 'International claims on non-banks (worldwide) · YoY %' },
  usd_eme: { key: 'Q.USD.4T.N.A.I.B.771',  name: 'Crédito USD a no-bancos en EMEs · YoY %' },
  eur_eme: { key: 'Q.EUR.4T.N.A.I.B.771',  name: 'Crédito EUR a no-bancos en EMEs · YoY %' },
  jpy_eme: { key: 'Q.JPY.4T.N.A.I.B.771',  name: 'Crédito JPY a no-bancos en EMEs · YoY %' },
  usd_gl:  { key: 'Q.USD.3P.N.A.I.B.771',  name: 'Crédito USD a no-bancos fuera de USA · YoY %' },
};

// 2026-Q1 → 2026-03-31 (fecha fin de trimestre, formato FRED-compatible)
const Q_END = { 1: '-03-31', 2: '-06-30', 3: '-09-30', 4: '-12-31' };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sel = SERIES[String(req.query.serie || 'xb')] || SERIES.xb;
  const BIS_URL = `https://stats.bis.org/api/v1/data/WS_GLI/${sel.key}/all?lastNObservations=60&format=csv`;

  try {
    const r = await fetch(BIS_URL, {
      signal: AbortSignal.timeout(9000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital-Dashboard/1.0)', 'Accept': 'text/csv' }
    });
    if (!r.ok) throw new Error(`BIS HTTP ${r.status}`);
    const csv = await r.text();

    const obs = [];
    for (const line of csv.split('\n')) {
      // El título de ESTA serie no tiene comas → split simple es seguro; igualmente
      // validamos con regex la celda de período y valor.
      const m = line.match(/,(\d{4})-Q([1-4]),(-?\d+(?:\.\d+)?),/);
      if (!m) continue;
      const value = parseFloat(m[3]);
      // Sanity: crecimiento YoY de crédito cross-border vive en ±40% (histórico ±12%)
      if (!isFinite(value) || Math.abs(value) > 40) continue;
      obs.push({ date: m[1] + Q_END[m[2]], value });
    }
    if (obs.length < 8) throw new Error(`parse insuficiente (${obs.length} obs) — ¿cambió el CSV del BIS?`);
    obs.sort((a, b) => b.date.localeCompare(a.date)); // DESC, formato FRED

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');
    return res.status(200).json({
      series: obs,
      name: sel.name,
      source: 'BIS WS_GLI ' + sel.key,
      fetched: new Date().toISOString()
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
