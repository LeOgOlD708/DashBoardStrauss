// api/capital.js — FASE 3 "dinero real" (2026-07-08, research playbook 10)
// Tres fuentes de flujo de capital REAL en UN endpoint (?src=finra|insiders|earnings)
// — un solo archivo por el límite de 12 serverless functions del plan Hobby de Vercel.
//   · finra:    short volume DIARIO por ticker (CDN público de FINRA Reg SHO, sin auth)
//   · insiders: compras/ventas de insiders 90d (SEC EDGAR Form 4, oficial, sin key)
//   · earnings: próxima fecha de earnings por ticker (Finnhub free tier — env FINNHUB_KEY)

const SEC_UA = { 'User-Agent': 'DashBoardStrauss jssulopez@gmail.com' }; // SEC exige contacto; <10 req/s

// ── FINRA Reg SHO: ratio de venta corta del día (busca el último día hábil con archivo) ──
async function finraShort(tickers) {
  for (let d = 0; d < 8; d++) {
    const dt = new Date(Date.now() - d * 86400000);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    let r;
    try { r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd}.txt`, { signal: AbortSignal.timeout(8000) }); }
    catch (e) { continue; }
    if (!r.ok) continue;
    const txt = await r.text();
    const want = new Set(tickers);
    const data = {};
    for (const line of txt.split('\n')) {
      const p = line.split('|');
      if (p.length < 5 || !want.has(p[1])) continue;
      const sv = +p[2], tv = +p[4];
      if (tv > 0) data[p[1]] = { date: p[0], shortVol: sv, totalVol: tv, ratio: +((sv / tv) * 100).toFixed(1) };
    }
    return { data, file: ymd };
  }
  throw new Error('sin archivo FINRA disponible en 8 días');
}

// ── SEC Form 4: compras (P) vs ventas (S) de insiders en 90 días ──
let _cikMap = null; // cache de módulo (persiste entre invocaciones de la instancia)
async function cikFor(ticker) {
  if (!_cikMap) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('SEC tickers HTTP ' + r.status);
    const j = await r.json();
    _cikMap = {};
    Object.values(j).forEach(o => { _cikMap[o.ticker] = String(o.cik_str).padStart(10, '0'); });
  }
  return _cikMap[ticker] || null;
}
async function insiders(ticker) {
  const cik = await cikFor(ticker);
  if (!cik) return { error: 'sin CIK para ' + ticker };
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_UA, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('SEC submissions HTTP ' + r.status);
  const j = await r.json();
  const rec = j.filings?.recent || {};
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const idx = [];
  let last8K = null; // tanda 1 #6: el mismo JSON trae TODOS los filings — 8-K gratis
  (rec.form || []).forEach((f, i) => {
    if (f === '4' && rec.filingDate[i] >= since) idx.push(i);
    if (f === '8-K' && (!last8K || rec.filingDate[i] > last8K)) last8K = rec.filingDate[i];
  });
  // Parsear los 6 Form 4 más recientes (transactionCode P=compra abierta, S=venta)
  let buys = 0, sells = 0, buyUsd = 0;
  for (const i of idx.slice(0, 6)) {
    try {
      const acc = rec.accessionNumber[i].replace(/-/g, '');
      // primaryDocument suele venir como "xslF345X06/wk-form4_x.xml" (versión RENDERIZADA
      // por XSL → HTML sin <transactionCode>); el XML crudo es el basename (cazado en prod)
      const doc = rec.primaryDocument[i].split('/').pop();
      const x = await fetch(`https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${doc}`, { headers: SEC_UA, signal: AbortSignal.timeout(7000) });
      if (!x.ok) continue;
      const xml = await x.text();
      const codes = [...xml.matchAll(/<transactionCode>([A-Z])<\/transactionCode>/g)].map(m => m[1]);
      const shares = [...xml.matchAll(/<transactionShares>\s*<value>([\d.]+)/g)].map(m => +m[1]);
      const px = [...xml.matchAll(/<transactionPricePerShare>\s*<value>([\d.]+)/g)].map(m => +m[1]);
      codes.forEach((c, k) => {
        if (c === 'P') { buys++; buyUsd += (shares[k] || 0) * (px[k] || 0); }
        else if (c === 'S') sells++;
      });
    } catch (e) { /* form ilegible → seguir */ }
  }
  return { ticker, form4_90d: idx.length, parsed: Math.min(idx.length, 6), buys, sells, buyUsd: Math.round(buyUsd), last8K };
}

// ── Finnhub: próxima fecha de earnings (free tier, 60 req/min) ──
async function earnings(tickers) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return { error: 'FINNHUB_KEY no configurada — crear key GRATIS en finnhub.io/register y agregarla como env var en Vercel' };
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
  const j = await r.json();
  const want = new Set(tickers);
  const data = {};
  (j.earningsCalendar || []).forEach(e => {
    if (want.has(e.symbol) && (!data[e.symbol] || e.date < data[e.symbol].date)) data[e.symbol] = { date: e.date, hour: e.hour || '' };
  });
  return { data, from, to };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const src = String(req.query.src || '');
  const tickers = String(req.query.tickers || '').split(',').map(t => t.trim().toUpperCase())
    .filter(t => /^[A-Z0-9.\-]{1,7}$/.test(t)).slice(0, 25);
  if (!tickers.length) return res.status(400).json({ error: 'Falta ?tickers=' });

  try {
    if (src === 'finra') {
      const out = await finraShort(tickers);
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6h — archivo diario
      return res.status(200).json(out);
    }
    if (src === 'insiders') {
      const out = await insiders(tickers[0]); // 1 ticker por llamada (SEC <10 req/s + cache CDN por URL)
      res.setHeader('Cache-Control', out.error ? 'max-age=0, no-cache' : 's-maxage=43200, stale-while-revalidate=43200'); // 12h
      return res.status(200).json(out);
    }
    if (src === 'earnings') {
      const out = await earnings(tickers);
      res.setHeader('Cache-Control', out.error ? 'max-age=0, no-cache' : 's-maxage=43200, stale-while-revalidate=21600'); // 12h
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'src debe ser finra | insiders | earnings' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
