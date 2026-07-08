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
  { date: '2026-07-14', name: 'CPI Jun',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Jun)' },
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
  // ── Agosto 2026 ─────────────────────────────
  // Fuentes: PFEI CY2026 (whitehouse.gov), BLS schedule, Fed FOMC calendar. Refresh 2026-07-07.
  { date: '2026-08-03', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Jul)' },
  { date: '2026-08-05', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Jul)' },
  { date: '2026-08-06', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-08-07', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Jul): NFP, UNRATE, AHE' },
  { date: '2026-08-12', name: 'CPI Jul',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Jul)' },
  { date: '2026-08-13', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-08-20', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-08-26', name: 'GDP Q2 second',      tag: 'growth',    impact: 'med',  desc: 'GDP, second estimate Q2 (BEA)' },
  { date: '2026-08-26', name: 'PCE Jul',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Jul (Fed preferred)' },
  { date: '2026-08-27', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  // ── Septiembre 2026 ─────────────────────────
  { date: '2026-09-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Ago)' },
  { date: '2026-09-03', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Ago)' },
  { date: '2026-09-03', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-09-04', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Ago): NFP, UNRATE, AHE' },
  { date: '2026-09-10', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-09-11', name: 'CPI Ago',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Ago)' },
  { date: '2026-09-16', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · SEP · Powell presser' },
  { date: '2026-09-17', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-09-24', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-09-30', name: 'PCE Ago',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Ago + Annual Update NEA (BEA)' },
  // ── Octubre 2026 ────────────────────────────
  { date: '2026-10-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Sep)' },
  { date: '2026-10-01', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-10-02', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Sep): NFP, UNRATE, AHE' },
  { date: '2026-10-05', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Sep)' },
  { date: '2026-10-08', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-10-14', name: 'CPI Sep',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Sep)' },
  { date: '2026-10-15', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-10-22', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-10-28', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · Powell presser' },
  { date: '2026-10-29', name: 'GDP Q3 advance',     tag: 'growth',    impact: 'high', desc: 'GDP, advance estimate Q3 (BEA)' },
  { date: '2026-10-29', name: 'PCE Sep',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Sep (Fed preferred)' },
  { date: '2026-10-29', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  // ── Noviembre 2026 ──────────────────────────
  { date: '2026-11-02', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Oct)' },
  { date: '2026-11-04', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Oct)' },
  { date: '2026-11-05', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-11-06', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Oct): NFP, UNRATE, AHE' },
  { date: '2026-11-10', name: 'CPI Oct',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Oct)' },
  { date: '2026-11-12', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-11-19', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-11-25', name: 'GDP Q3 second',      tag: 'growth',    impact: 'med',  desc: 'GDP, second estimate Q3 (BEA)' },
  { date: '2026-11-25', name: 'PCE Oct',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Oct (Fed preferred)' },
  { date: '2026-11-25', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Weekly Claims (adelantado por Thanksgiving)' },
  // ── Diciembre 2026 ──────────────────────────
  { date: '2026-12-01', name: 'ISM Mfg PMI',        tag: 'manuf',     impact: 'high', desc: 'ISM Manufacturing PMI (Nov)' },
  { date: '2026-12-03', name: 'ISM Services PMI',   tag: 'services',  impact: 'med',  desc: 'ISM Non-Manufacturing PMI (Nov)' },
  { date: '2026-12-03', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-12-04', name: 'NFP / Empleo',       tag: 'employ',    impact: 'high', desc: 'Employment Situation (Nov): NFP, UNRATE, AHE' },
  { date: '2026-12-09', name: 'FOMC Decision',      tag: 'fed',       impact: 'high', desc: 'FOMC Meeting · Rate Decision · SEP · Powell presser' },
  { date: '2026-12-10', name: 'CPI Nov',            tag: 'inflation', impact: 'high', desc: 'Consumer Price Index (Nov)' },
  { date: '2026-12-10', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-12-17', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Unemployment Insurance Weekly Claims' },
  { date: '2026-12-23', name: 'GDP Q3 third',       tag: 'growth',    impact: 'med',  desc: 'GDP, third estimate Q3 (BEA)' },
  { date: '2026-12-23', name: 'PCE Nov',            tag: 'inflation', impact: 'high', desc: 'PCE Price Index Nov (Fed preferred)' },
  { date: '2026-12-23', name: 'Initial Claims',     tag: 'employ',    impact: 'med',  desc: 'Weekly Claims (adelantado por Navidad)' },
];
const STATIC_EVENTS_UPDATED = '2026-07-07'; // refrescar trimestralmente (próximo: 2026-10-01)

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

  // ARQUITECTURA 2026-07-07 (v2): STATIC-PRIMERO, FRED COMO FAILSAFE POR TAG.
  // Verificado empíricamente: fred/release/dates con realtime window devuelve vintages
  // ("FOMC" el 7-9 jul cuando la reunión real es 28-29; "IP" 3 días seguidos siendo
  // mensual) y nombres que rompen el dedup ("CPI" vs "CPI Jun" → duplicado visible).
  // El STATIC curado trae fechas OFICIALES (PFEI/BLS/Fed) → manda. FRED solo cubre
  // tags sin cobertura static en la ventana (failsafe si el static queda stale).
  const staticInWindow = STATIC_EVENTS.filter(e => e.date >= todayStr && e.date <= futureStr);
  // Cobertura por tag: mira TODO el static futuro, no solo la ventana. Si el tag tiene
  // curación futura (ej. FOMC 29-jul con ventana hasta 21-jul), la ausencia en ventana
  // es CORRECTA (no hay evento próximo) — sin esto, FRED rellenaba con vintages falsos
  // (FOMC "7-8 jul" cuando la reunión real es 28-29).
  const staticTags = new Set(STATIC_EVENTS.filter(e => e.date >= todayStr).map(e => e.tag));
  const releasesToFetch = RELEASES.filter(r => !staticTags.has(r.tag));

  // Procesa releases en lotes de 6 (12 simultáneos disparaban throttling FRED)
  const CHUNK = 6;
  const chunks = [];
  for (let i = 0; i < releasesToFetch.length; i += CHUNK) chunks.push(releasesToFetch.slice(i, i + CHUNK));
  for (const [ci, chunk] of chunks.entries()) {
    if (ci > 0) await new Promise(r => setTimeout(r, 400));
    await Promise.all(chunk.map(async (rel) => {
    try {
      // FRED API: release_id va como QUERY PARAM, no en el path.
      // include_release_dates_with_no_data=true devuelve fechas futuras programadas.
      // sort_order=asc para tener primero las fechas más cercanas.
      // BUG FIX 2026-07-07 (definitivo): sin realtime_* explícitos, FRED release/dates
      // devuelve fechas desde el inicio del año/histórico — ni asc ni desc caían en la
      // ventana próxima y el calendario vivía 100% del static. Ventana explícita:
      const url = `${FRED_BASE}?release_id=${rel.id}&api_key=${apiKey}&file_type=json`
        + `&include_release_dates_with_no_data=true&sort_order=asc&limit=15`
        + `&realtime_start=${todayStr}&realtime_end=${futureStr}`;
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
      // Filtrar a la ventana hoy → +14 días. Máximo 2 por release (guard anti-ruido:
      // los vintages diarios de FRED inflan releases mensuales a 3+ fechas seguidas)
      const upcoming = dates
        .filter(d => d.date >= todayStr && d.date <= futureStr)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 2);
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
  }

  // Marcar source de los eventos FRED (solo tags SIN cobertura static — cero solapamiento)
  results.forEach(r => { r.source = 'fred'; });

  let staticAdded = 0;
  for (const ev of staticInWindow) {
    results.push({ ...ev, source: 'static' });
    staticAdded++;
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
