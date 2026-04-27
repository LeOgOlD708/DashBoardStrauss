// api/fred-calendar.js — Vercel Serverless Function
// Trae las próximas fechas de release de las series macro más relevantes desde FRED.
// FRED tiene un endpoint oficial /fred/release/dates por release_id (no por serie).
// Estrategia: hardcoded list de release_ids relevantes para macro USA.
// Para cada release, traemos las próximas fechas. Cliente filtra a 7-14 días.

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

  // Ordenar por fecha ascendente
  results.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`[FRED-Cal] ${RELEASES.length} releases en ${Date.now() - tStart}ms · ${results.length} eventos próximos · errores=${errors.length}`);
  if (errors.length) console.log('[FRED-Cal] errores:', errors.join(' · '));

  // No cachear si hay errores o si results está vacío con errores
  const cacheControl = errors.length > 0
    ? 'max-age=0, no-cache, no-store'
    : 's-maxage=14400, stale-while-revalidate=3600'; // 4h cache cuando todo OK
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).json({ events: results, today: todayStr, errors: errors.length ? errors : undefined });
};
