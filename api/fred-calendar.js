// api/fred-calendar.js — Vercel Serverless Function
// Devuelve los próximos eventos macro USA combinando dos fuentes:
//   1) FRED API /fred/release/dates — fechas oficiales programadas (alta confianza)
//   2) STATIC_EVENTS — fallback hardcoded con fechas estimadas trimestralmente
//      para releases que FRED no programa con anticipación o no expone.
// Cliente filtra a ventana de 7 días. Endpoint sirve hasta +14 días para buffer.

const FRED_BASE = 'https://api.stlouisfed.org/fred/release/dates';

// Releases más vigilados por traders macro (release_id de FRED).
// Verificable en https://fred.stlouisfed.org/releases/
const RELEASES = [
  { id: 10,  name: 'CPI',           tag: 'inflation', impact: 'high',  desc: 'Consumer Price Index' },
  { id: 21,  name: 'PCE',           tag: 'inflation', impact: 'high',  desc: 'Personal Consumption Expenditures (Fed preferred)' },
  { id: 50,  name: 'NFP / Empleo',  tag: 'employ',    impact: 'high',  desc: 'Employment Situation (NFP, UNRATE)' },
  { id: 14,  name: 'PIB Real',      tag: 'growth',    impact: 'high',  desc: 'Gross Domestic Product' },
  { id: 101, name: 'FOMC Decision', tag: 'fed',       impact: 'high',  desc: 'FOMC Meeting / Rate Decision' },
  { id: 17,  name: 'Initial Claims',tag: 'employ',    impact: 'med',   desc: 'Unemployment Insurance Weekly Claims' },
  { id: 8,   name: 'Retail Sales',  tag: 'consumer',  impact: 'med',   desc: 'Advance Retail Sales' },
  { id: 18,  name: 'Industrial Prod',tag: 'growth',   impact: 'med',   desc: 'Industrial Production' },
  { id: 9,   name: 'Housing Starts',tag: 'housing',   impact: 'med',   desc: 'New Residential Construction' },
  { id: 178, name: 'ISM Mfg PMI',   tag: 'manuf',     impact: 'high',  desc: 'ISM Manufacturing PMI' },
  { id: 53,  name: 'Consumer Sent', tag: 'consumer',  impact: 'med',   desc: 'University of Michigan Consumer Sentiment' },
  { id: 13,  name: 'JOLTS',         tag: 'employ',    impact: 'med',   desc: 'Job Openings & Labor Turnover Survey' },
];

// ─── STATIC EVENTS — calendario hardcoded de releases USA ──────────────────────
// Cubre Q2-Q3 2026 (apr-jul). Refrescar trimestralmente revisando:
//   · BLS schedule:        https://www.bls.gov/schedule/news_release/
//   · ISM release dates:   https://www.ismworld.org/supply-management-news-and-reports/reports/
//   · FOMC calendar:       https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
//   · BEA schedule:        https://www.bea.gov/news/schedule
// Solo se usan si FRED no devuelve la fecha (dedup por date+name).
const STATIC_EVENTS = [
  // ── Mayo 2026 ──────────────────────────────
  { date: '2026-04-29', name: 'GDP Q1 advance',     tag: 'growth',    impact: 'high', desc: 'GDP, advance estimate Q1 (BEA)' },
  { date: '2026-04-30', name: 'PCE Mar',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Mar (Fed preferred)' },
  { date: '2026-04-30', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-05-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Apr)' },
  { date: '2026-05-05', name: 'JOLTS Mar',          tag: 'employ',    impact: 'med',  desc: 'Job Openings & Labor Turnover (Mar)' },
  { date: '2026-05-05', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Apr)' },
  { date: '2026-05-06', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · Powell presser' },
  { date: '2026-05-07', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-05-13', name: 'CPI Apr',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Apr)' },
  { date: '2026-05-14', name: 'PPI Apr',            tag: 'inflation', impact: 'med',  desc: 'Producer Price Index (Apr)' },
  { date: '2026-05-14', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-05-15', name: 'Retail Sales Apr',   tag: 'consumer',  impact: 'med',  desc: 'Advance Monthly Sales for Retail (Apr)' },
  { date: '2026-05-15', name: 'IP Apr',             tag: 'growth',    impact: 'med',  desc: 'Industrial Production (Apr)' },
  { date: '2026-05-19', name: 'Housing Starts Apr', tag: 'housing',   impact: 'med',  desc: 'New Residential Construction (Apr)' },
  { date: '2026-05-21', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-05-22', name: 'U-Mich May Final',   tag: 'consumer',  impact: 'med',  desc: 'U-Mich Consumer Sentiment (May Final)' },
  { date: '2026-05-28', name: 'GDP Q1 second',      tag: 'growth',    impact: 'high', desc: 'GDP, second estimate Q1 (BEA)' },
  { date: '2026-05-28', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-05-29', name: 'PCE Apr',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Apr (Fed preferred)' },
  // ── Junio 2026 ─────────────────────────────
  { date: '2026-06-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (May)' },
  { date: '2026-06-03', name: 'JOLTS Apr',          tag: 'employ',    impact: 'med',  desc: 'Job Openings & Labor Turnover (Apr)' },
  { date: '2026-06-03', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (May)' },
  { date: '2026-06-04', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-06-05', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (May): NFP, UNRATE, AHE' },
  { date: '2026-06-10', name: 'CPI May',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (May)' },
  { date: '2026-06-11', name: 'PPI May',            tag: 'inflation', impact: 'med',  desc: 'Producer Price Index (May)' },
  { date: '2026-06-11', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-06-12', name: 'U-Mich Jun Prelim',  tag: 'consumer',  impact: 'med',  desc: 'U-Mich Consumer Sentiment (Jun Prelim)' },
  { date: '2026-06-16', name: 'Retail Sales May',   tag: 'consumer',  impact: 'med',  desc: 'Advance Monthly Sales for Retail (May)' },
  { date: '2026-06-17', name: 'IP May',             tag: 'growth',    impact: 'med',  desc: 'Industrial Production (May)' },
  { date: '2026-06-17', name: 'Housing Starts May', tag: 'housing',   impact: 'med',  desc: 'New Residential Construction (May)' },
  { date: '2026-06-17', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · SEP · Powell presser' },
  { date: '2026-06-18', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-06-25', name: 'GDP Q1 final',       tag: 'growth',    impact: 'med',  desc: 'GDP, third estimate Q1 (BEA)' },
  { date: '2026-06-25', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-06-26', name: 'PCE May',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index May (Fed preferred)' },
  { date: '2026-06-27', name: 'U-Mich Jun Final',   tag: 'consumer',  impact: 'med',  desc: 'U-Mich Consumer Sentiment (Jun Final)' },
  // ── Julio 2026 ─────────────────────────────
  { date: '2026-07-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Jun)' },
  { date: '2026-07-02', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-07-03', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Jun): NFP, UNRATE, AHE' },
  { date: '2026-07-07', name: 'JOLTS May',          tag: 'employ',    impact: 'med',  desc: 'Job Openings & Labor Turnover (May)' },
  { date: '2026-07-07', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Jun)' },
  { date: '2026-07-09', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-07-15', name: 'CPI Jun',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Jun)' },
  { date: '2026-07-16', name: 'PPI Jun',            tag: 'inflation', impact: 'med',  desc: 'Producer Price Index (Jun)' },
  { date: '2026-07-16', name: 'Retail Sales Jun',   tag: 'consumer',  impact: 'med',  desc: 'Advance Monthly Sales for Retail (Jun)' },
  { date: '2026-07-16', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-07-17', name: 'IP Jun',             tag: 'growth',    impact: 'med',  desc: 'Industrial Production (Jun)' },
  { date: '2026-07-17', name: 'Housing Starts Jun', tag: 'housing',   impact: 'med',  desc: 'New Residential Construction (Jun)' },
  { date: '2026-07-23', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-07-29', name: 'GDP Q2 advance',     tag: 'growth',    impact: 'high', desc: 'GDP, advance estimate Q2 (BEA)' },
  { date: '2026-07-29', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · Powell presser' },
  { date: '2026-07-30', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-07-31', name: 'PCE Jun',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Jun (Fed preferred)' },
];
const STATIC_EVENTS_UPDATED = '2026-04-27'; // refrescar trimestralmente

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FRED_API_KEY no configurada en Vercel.' });
  }

  // Ventana: hoy → +14 días (cliente filtra los próximos 7)
  const today = new Date();
  const future = new Date();
  future.setDate(today.getDate() + 14);
  const fmtDate = d => d.toISOString().slice(0, 10);
  const todayStr  = fmtDate(today);
  const futureStr = fmtDate(future);

  const results = [];
  const tStart = Date.now();
  const errors = [];

  // Procesa todos los releases en paralelo (12 releases, OK en límite FRED)
  await Promise.all(RELEASES.map(async (rel) => {
    try {
      // FRED API: release_id va como QUERY PARAM, no en el path.
      // include_release_dates_with_no_data=true devuelve fechas futuras programadas.
      // sort_order=asc para tener primero las fechas más cercanas.
      const url = `${FRED_BASE}?release_id=${rel.id}&api_key=${apiKey}&file_type=json`
        + `&include_release_dates_with_no_data=true&sort_order=desc&limit=8`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) {
        errors.push(`${rel.name}=HTTP ${response.status}`);
        console.warn(`[FRED-Cal] release ${rel.id} (${rel.name}) HTTP ${response.status}`);
        return;
      }
      const data = await response.json();
      if (data.error_code) {
        errors.push(`${rel.name}=${data.error_code}`);
        console.warn(`[FRED-Cal] release ${rel.id} error: ${data.error_message}`);
        return;
      }
      const dates = data.release_dates || [];
      // Filtrar a la ventana hoy → +14 días, quedarnos con las próximas
      const upcoming = dates
        .filter(d => d.date >= todayStr && d.date <= futureStr)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 3);
      upcoming.forEach(d => {
        results.push({
          date: d.date,
          name: rel.name,
          tag: rel.tag,
          impact: rel.impact,
          desc: rel.desc,
          releaseId: rel.id
        });
      });
    } catch (e) {
      errors.push(`${rel.name}=${e.message}`);
      console.warn(`[FRED-Cal] release ${rel.id} (${rel.name}) error: ${e.message}`);
    }
  }));

  // Marcar source de los eventos FRED
  results.forEach(r => { r.source = 'fred'; });

  // Merge con STATIC_EVENTS — solo agregar los que NO están ya en FRED.
  // Dedup por (date + name normalizado) — si FRED ya lo trajo, prevalece.
  const fredKeys = new Set(results.map(r => `${r.date}|${r.name.toLowerCase().trim()}`));
  const staticInWindow = STATIC_EVENTS.filter(e =>
    e.date >= todayStr && e.date <= futureStr
  );
  let staticAdded = 0;
  for (const ev of staticInWindow) {
    const key = `${ev.date}|${ev.name.toLowerCase().trim()}`;
    if (!fredKeys.has(key)) {
      results.push({ ...ev, source: 'static' });
      staticAdded++;
    }
  }

  // Ordenar por fecha ascendente
  results.sort((a, b) => a.date.localeCompare(b.date));

  const fromFred = results.filter(r => r.source === 'fred').length;
  console.log(`[FRED-Cal] ${RELEASES.length} releases FRED en ${Date.now() - tStart}ms · ${fromFred} de FRED · ${staticAdded} de static · ${results.length} totales · errores=${errors.length}`);
  if (errors.length) console.log('[FRED-Cal] errores:', errors.join(' · '));

  // Cache 4h si todo OK (incluye el caso de FRED con errores pero static cubriendo)
  // No cachear si todo falló y no hay events
  const cacheControl = (errors.length > 0 && results.length === 0)
    ? 'max-age=0, no-cache, no-store'
    : 's-maxage=14400, stale-while-revalidate=3600';
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).json({
    events: results,
    today: todayStr,
    sources: { fred: fromFred, static: staticAdded },
    static_updated: STATIC_EVENTS_UPDATED,
    errors: errors.length ? errors : undefined
  });
};
