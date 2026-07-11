// api/capital.js — FASE 3 "dinero real" (2026-07-08, research playbook 10)
// Fuentes de flujo de capital REAL en UN endpoint (?src=finra|insiders|earnings|opt|ats|cot|stats)
// — un solo archivo por el límite de 12 serverless functions del plan Hobby de Vercel.
//   · finra:    short volume DIARIO por ticker (CDN público de FINRA Reg SHO, sin auth)
//   · insiders: compras/ventas de insiders 90d (SEC EDGAR Form 4, oficial, sin key)
//   · earnings: próxima fecha de earnings por ticker (Finnhub free tier — env FINNHUB_KEY)
//   · opt:      cadena de opciones agregada (CBOE delayed, sin auth) → GEX por strike,
//               muros call/put, gamma flip, max pain, P/C — proyecto Institucional F-I1
//   · ats:      dark pools por ticker (FINRA ATS weeklySummary, sin auth) — F-I3
//   · cot:      posicionamiento futuros CFTC 8 mercados (Socrata, sin key) — F-I4
//   · stats:    ownership institucional + short interest (stockanalysis) — F-I5
//   · alerts:   alerta Telegram si el precio está/entró en zona del snapshot — E6 (cron 17:00 UTC)

const SEC_UA = { 'User-Agent': 'DashBoardStrauss jssulopez@gmail.com' }; // SEC exige contacto; <10 req/s

// ── FINRA Reg SHO: ratio de venta corta del día (busca el último día hábil con archivo) ──
async function finraShort(tickers) {
  const t0 = Date.now();
  let lastErr = null;
  for (let d = 0; d < 8; d++) {
    if (Date.now() - t0 > 15000) throw new Error('FINRA lento — abortado a 15s' + (lastErr ? ' · último error: ' + lastErr : ''));
    const dt = new Date(Date.now() - d * 86400000);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    let r;
    try { r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd}.txt`, { signal: AbortSignal.timeout(6000) }); }
    catch (e) { lastErr = e.message; continue; }
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
  // Parsear los 6 Form 4 más recientes. Review 2026-07-09: parsear POR BLOQUE de transacción
  // (tres regex globales zipeadas por índice se desalineaban cuando una fila sin precio —
  // regalo código G, award A — acortaba px[] → buyUsd con precios de OTRA transacción).
  // Solo tabla non-derivative: las compras/ventas de mercado abierto viven ahí.
  let buys = 0, sells = 0, buyUsd = 0;
  const buyDates = []; // E3 (2026-07-11): fechas de filings con compras P → detección de CLUSTER
  const t0 = Date.now();
  for (const i of idx.slice(0, 6)) {
    if (Date.now() - t0 > 18000) break; // presupuesto: lejos del maxDuration 30 (SEC lento no nos mata)
    try {
      const acc = rec.accessionNumber[i].replace(/-/g, '');
      // primaryDocument suele venir como "xslF345X06/wk-form4_x.xml" (versión RENDERIZADA
      // por XSL → HTML sin <transactionCode>); el XML crudo es el basename (cazado en prod)
      const doc = rec.primaryDocument[i].split('/').pop();
      const x = await fetch(`https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${doc}`, { headers: SEC_UA, signal: AbortSignal.timeout(5000) });
      if (!x.ok) continue;
      const xml = await x.text();
      let hadBuy = false;
      for (const b of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
        const code = b[1].match(/<transactionCode>([A-Z])<\/transactionCode>/)?.[1];
        if (code === 'P') {
          buys++; hadBuy = true;
          const sh = +(b[1].match(/<transactionShares>\s*<value>([\d.]+)/)?.[1] || 0);
          const pr = +(b[1].match(/<transactionPricePerShare>\s*<value>([\d.]+)/)?.[1] || 0);
          buyUsd += sh * pr;
        } else if (code === 'S') sells++;
      }
      if (hadBuy && rec.filingDate[i]) buyDates.push(rec.filingDate[i]);
    } catch (e) { /* form ilegible → seguir */ }
  }
  return { ticker, form4_90d: idx.length, parsed: Math.min(idx.length, 6), buys, sells, buyUsd: Math.round(buyUsd), buyDates, last8K };
}

// ── F4 · TRACK RECORD: snapshots inmutables del embudo en el propio repo (GitHub API) ──
// Diseño para AUDITABILIDAD: un JSON por día en track/, first-write-wins (el primer escaneo
// del día queda grabado; los siguientes se ignoran — la historia no se reescribe), historial
// completo via git. '[vercel skip]' en el commit para no disparar un deploy por snapshot.
const GH_REPO = 'LeOgOlD708/DashBoardStrauss';
async function ghReq(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { const e = new Error('GITHUB_TOKEN no configurada — crear fine-grained token (solo Contents Read/Write de este repo) en github.com/settings/personal-access-tokens y agregarlo en Vercel'); e.code = 'NO_TOKEN'; throw e; }
  return fetch('https://api.github.com/repos/' + GH_REPO + path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'DashBoardStrauss', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(9000)
  });
}
async function trackSave(body) {
  const date = String(body?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date inválida');
  if (JSON.stringify(body).length > 60000) throw new Error('snapshot demasiado grande');
  const path = '/contents/track/' + date + '.json';
  const exists = await ghReq(path);
  if (exists.ok) return { skipped: true, reason: 'snapshot de ' + date + ' ya existe (first-write-wins)' };
  const content = Buffer.from(JSON.stringify(body, null, 1)).toString('base64');
  const put = await ghReq(path, { method: 'PUT', body: JSON.stringify({ message: 'track: snapshot ' + date + ' [vercel skip]', content }) });
  if (!put.ok) throw new Error('GitHub PUT ' + put.status + ': ' + (await put.text()).slice(0, 140));
  return { saved: true, date };
}
async function trackList() {
  const r = await ghReq('/contents/track');
  if (r.status === 404) return { dates: [] }; // carpeta aún no existe = cero snapshots
  if (!r.ok) throw new Error('GitHub list HTTP ' + r.status);
  const j = await r.json();
  return { dates: j.filter(f => f.name.endsWith('.json')).map(f => f.name.replace('.json', '')).sort() };
}
async function trackGet(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date inválida');
  const r = await ghReq('/contents/track/' + date + '.json');
  if (!r.ok) throw new Error('GitHub get HTTP ' + r.status);
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
}

// ── F5 · TELEGRAM: digest diario pre-apertura via Vercel Cron (bot gratis de @BotFather) ──
async function tgSend(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { const e = new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configuradas — crear bot con @BotFather en Telegram y agregar ambas env vars en Vercel'); e.code = 'NO_TG'; throw e; }
  const r = await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram API: ' + (j.description || r.status));
  return true;
}
async function quoteMini(sym) { // precio + chg1d server-side (mismo criterio penúltimo-cierre que api/yahoo)
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(7000) });
    const j = await r.json();
    const res0 = j?.chart?.result?.[0];
    const p = res0?.meta?.regularMarketPrice;
    if (p == null) return null;
    const closes = (res0?.indicators?.quote?.[0]?.close || []).filter(c => c > 0);
    const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
    return { p, chg: prev ? (p / prev - 1) * 100 : null };
  } catch (e) { return null; }
}
async function digest() {
  // v2 (pedido Angel 2026-07-09): el digest lee el último snapshot del track record y arma
  // el CONTEXTO COMPLETO del sistema — no solo cotizaciones.
  // Review 2026-07-10: los awaits secuenciales sumaban ~45s de peor caso (> maxDuration 30)
  // → GitHub+CBOE+CFTC lentos a la vez mataban la función antes del tgSend y el Telegram no
  // salía ese día. Ahora: TODO en paralelo con presupuesto duro por bloque — peor caso ~20s.
  const budget = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
  const [quotes, snapLast, instData] = await Promise.all([
    Promise.all(['SPY', '^VIX', 'GLD', 'DX-Y.NYB'].map(quoteMini)), // quoteMini ya trae timeout 7s
    budget((async () => {
      const l = await trackList();
      if (!l.dates?.length) return { empty: true };
      return { s: await trackGet(l.dates[l.dates.length - 1]) };
    })().catch(() => null), 12000),
    budget(Promise.all([optAgg('QQQ').catch(() => null), cotPositioning().catch(() => null)]), 12000)
  ]);
  const [spy, vix, gld, dxy] = quotes;
  const f = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const fecha = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' });
  const L = ['🌅 <b>Rebirth Capital</b> · ' + fecha];
  L.push('📊 SPY ' + (spy ? spy.p.toFixed(2) + ' (' + f(spy.chg) + ')' : '—')
    + ' · VIX ' + (vix ? vix.p.toFixed(1) : '—')
    + ' · GLD ' + (gld ? f(gld.chg) : '—')
    + ' · DXY ' + (dxy ? f(dxy.chg) : '—'));
  if (vix?.p >= 25) L.push('⚠️ <b>VIX ' + vix.p.toFixed(1) + ' — zona de stress: sizing reducido, solo setups A</b>');
  try {
    if (snapLast && !snapLast.empty && snapLast.s) {
      const s = snapLast.s;
      const reg = [];
      if (s.postura) reg.push('🧭 ' + s.postura);
      if (s.quad?.q) reg.push(s.quad.q.replace(/·\s*/, '') + (s.quad.conf != null ? ' (' + Math.round(s.quad.conf) + '%' + (s.quad.conf < 40 ? ' difuso' : '') + ')' : ''));
      if (s.nfci != null) reg.push('NFCI ' + Math.round(s.nfci) + '/100');
      if (s.gli) reg.push('GLI ' + s.gli);
      if (reg.length) L.push(reg.join(' · '));
      const secs = [...(s.sectores || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (secs.length >= 2) L.push('🏆 Líder: <b>' + secs[0].tk + ' ' + secs[0].score + '</b>/100 · 2º ' + secs[1].tk + ' ' + secs[1].score + (secs.length > 2 ? ' · cola: ' + secs[secs.length - 1].tk + ' ' + secs[secs.length - 1].score : ''));
      if (s.lideres?.[0]?.stocks?.length) {
        const L0 = s.lideres[0], pk = L0.picks || [];
        L.push(pk.length
          ? '🔎 <b>Picks en ' + L0.sector + '</b> (RS≥75+template+U/D): ' + pk.slice(0, 4).join(' · ')
          : '🔎 Dentro de ' + L0.sector + ': ' + L0.stocks.slice(0, 4).map(st => st.tk + ' RS' + st.rs).join(' · ') + ' (sin picks que pasen el filtro hoy)');
      }
      if (s.candidatas?.length) L.push('🎯 Embudo (' + s.date + '): ' + s.candidatas.length + ' candidatas · top: ' + s.candidatas.slice(0, 3).map(c => c.tk).join(', '));
    } else if (snapLast?.empty) {
      L.push('🧾 Sin snapshots aún — abrí el dashboard y escaneá candidatas para arrancar el registro del día.');
    }
  } catch (e) { /* sin GITHUB_TOKEN — el digest de mercado sale igual */ }
  // F-I5: línea institucional — solo agregados de MERCADO (si falla, el digest sale igual)
  try {
    const [q, cot] = instData || [null, null];
    const parts = [];
    if (q) parts.push('QQQ P/C ' + (q.pcVol ?? '—') + ' · GEX $' + q.gexTotalBn + 'bn (walls ' + q.putWall + '/' + q.callWall + (q.gammaFlip != null ? ' · flip ' + q.gammaFlip : '') + ')');
    if (cot?.mkts) {
      const nq = cot.mkts.find(m => m.code === '209742');
      if (nq && !nq.error) parts.push('COT NQ p' + nq.pctil3y + (nq.pctil3y >= 90 ? ' ⚠️ crowded long' : nq.pctil3y <= 10 ? ' ⚡ crowded short' : ''));
      const ext = cot.mkts.filter(m => !m.error && m.code !== '209742' && (m.pctil3y >= 90 || m.pctil3y <= 10));
      if (ext.length) parts.push('extremos COT: ' + ext.map(m => m.lbl.split(' ')[0] + ' p' + m.pctil3y).join(', '));
    }
    if (parts.length) L.push('🏛 ' + parts.join(' · '));
  } catch (e) { /* la línea institucional jamás rompe el digest */ }
  // E4 · Mapa de Entrada: zonas del top-3 (grabadas en el snapshot) vs precio ACTUAL —
  // el aviso "estás en zona" llega al teléfono sin abrir el dashboard
  try {
    const s2 = snapLast && !snapLast.empty ? snapLast.s : null;
    if (s2?.zonas?.length) {
      const zs = s2.zonas.slice(0, 3);
      const qz = await budget(Promise.all(zs.map(z => quoteMini(z.tk))), 8000);
      const partsZ = zs.map((z, i) => {
        const p = qz?.[i]?.p;
        if (!p) return z.tk + ' zona ' + z.lo + '–' + z.hi;
        const inZ = p >= z.lo && p <= z.hi;
        const dist = ((z.lo + z.hi) / 2 / p - 1) * 100;
        return inZ ? '<b>' + z.tk + ' 🎯 EN ZONA ' + z.lo + '–' + z.hi + '</b>' : z.tk + ' zona ' + z.lo + '–' + z.hi + ' (' + (dist >= 0 ? '+' : '') + dist.toFixed(1) + '%)';
      });
      L.push('🎯 Zonas de entrada (top-3 del embudo): ' + partsZ.join(' · '));
    }
  } catch (e) { /* las zonas jamás rompen el digest */ }
  L.push('<a href="https://dash-board-strauss.vercel.app/#act">Abrir dashboard → Activos</a>'); // #act = deep-link al tab del embudo (menos fricción digest→scan)
  await tgSend(L.join('\n'));
  return { sent: true, ts: new Date().toISOString() };
}

// ── F-I1 · CBOE delayed options: agregados institucionales por ticker ──
// El raw de SPY pesa ~6 MB (14k contratos) — se parsea AQUÍ y al cliente viajan ~8 KB.
// GEX convención dealer estándar (largos calls +, cortos puts −), $ por movimiento de 1%.
// Delayed 15 min — son niveles, no timing.
async function optAgg(tk) {
  let r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${tk}.json`, { signal: AbortSignal.timeout(12000) });
  if (r.status === 404) // índices llevan prefijo _ en CBOE (_SPX, _VIX); ETFs/acciones no
    r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/_${tk}.json`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('CBOE HTTP ' + r.status + ' para ' + tk + ' (¿ticker sin opciones listadas?)');
  const j = await r.json();
  const data = j.data || {};
  const spot = data.current_price;
  if (!(spot > 0)) throw new Error('sin current_price CBOE para ' + tk);
  const today = new Date().toISOString().slice(0, 10);
  const maxExp = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const reSym = /(\d{6})([CP])(\d{8})$/; // TICKER + YYMMDD + C/P + strike*1000
  const byStrike = new Map();
  let cVolT = 0, pVolT = 0, cOIT = 0, pOIT = 0, nearestExp = null, dexTotal = 0;
  const expiries = new Set(), nearRows = [];
  // E0 (2026-07-11): straddles ATM por expiración (strikes ±3% del spot) para expected move
  const atmByExp = new Map();
  for (const o of (data.options || [])) {
    const m = reSym.exec(o.option || '');
    if (!m) continue;
    const exp = '20' + m[1].slice(0, 2) + '-' + m[1].slice(2, 4) + '-' + m[1].slice(4, 6);
    if (exp < today || exp > maxExp) continue; // ventana ≤45 días
    const isCall = m[2] === 'C';
    const k = +m[3] / 1000;
    const oi = +o.open_interest || 0, vol = +o.volume || 0, gamma = +o.gamma || 0;
    // E0: delta viene NATIVO con signo (puts negativos — validado contra el raw 2026-07-11);
    // guard defensivo por si CBOE lo cambiara
    let delta = +o.delta || 0;
    if (!isCall && delta > 0) delta = -delta;
    expiries.add(exp);
    if (!nearestExp || exp < nearestExp) nearestExp = exp;
    if (isCall) { cVolT += vol; cOIT += oi; } else { pVolT += vol; pOIT += oi; } // P/C: toda la ventana
    if (exp === nearestExp) nearRows.push({ k, isCall, oi, exp });
    // E0 · DEX total (toda la ventana ≤45d): delta-dollars del open interest
    dexTotal += delta * oi * 100 * spot;
    // E0 · straddle ATM: guardar mids/IV de strikes ±3% por expiración (para EM)
    if (Math.abs(k - spot) / spot <= 0.03) {
      let em = atmByExp.get(exp);
      if (!em) { em = new Map(); atmByExp.set(exp, em); }
      let leg = em.get(k);
      if (!leg) { leg = {}; em.set(k, leg); }
      const mid = (+o.bid > 0 && +o.ask > 0) ? (+o.bid + +o.ask) / 2 : null;
      if (isCall) { leg.cMid = mid; leg.cIv = +o.iv || null; } else { leg.pMid = mid; leg.pIv = +o.iv || null; }
    }
    if (k < spot * 0.85 || k > spot * 1.15) continue; // GEX/DEX por strike: ±15% del spot
    let row = byStrike.get(k);
    if (!row) { row = { k, cOI: 0, pOI: 0, gex: 0, dex: 0 }; byStrike.set(k, row); }
    const gexUsd = gamma * oi * 100 * spot * spot * 0.01;
    row.dex += delta * oi * 100 * spot;
    if (isCall) { row.cOI += oi; row.gex += gexUsd; } else { row.pOI += oi; row.gex -= gexUsd; }
  }
  // E0 · Expected move: straddle ATM ×0.85 (precio de mercado) con fallback IV·spot·√(dte/365).
  // Horizontes: nearest (el más cercano) y weekly (4-10 días) — marco de swing, no 0DTE.
  const emOf = (exp) => {
    if (!exp) return null;
    const em = atmByExp.get(exp);
    if (!em) return null;
    let bestK = null, bestDist = Infinity;
    for (const k of em.keys()) {
      const l = em.get(k);
      if (l.cMid == null || l.pMid == null) continue; // straddle completo
      const d2 = Math.abs(k - spot);
      if (d2 < bestDist) { bestDist = d2; bestK = k; }
    }
    if (bestK == null) return null;
    const l = em.get(bestK);
    const dte = Math.max((new Date(exp + 'T16:00:00Z') - Date.now()) / 86400000, 0.25);
    const straddle = 0.85 * (l.cMid + l.pMid);
    const ivAtm = (l.cIv && l.pIv) ? (l.cIv + l.pIv) / 2 : (l.cIv || l.pIv || null);
    const emVal = straddle > 0 ? straddle : (ivAtm ? spot * ivAtm * Math.sqrt(dte / 365) : null);
    if (!emVal) return null;
    return { exp, dte: +dte.toFixed(1), em: +emVal.toFixed(2), pct: +(emVal / spot * 100).toFixed(2), ivAtm: ivAtm ? +ivAtm.toFixed(4) : null };
  };
  const expSorted = [...expiries].sort();
  const weeklyExp = expSorted.find(e => {
    const dte = (new Date(e) - new Date(today)) / 86400000;
    return dte >= 4 && dte <= 10;
  }) || expSorted.find(e => (new Date(e) - new Date(today)) / 86400000 > 2) || null;
  const emDaily = emOf(nearestExp);
  const emWeekly = weeklyExp && weeklyExp !== nearestExp ? emOf(weeklyExp) : null;
  const near = nearRows.filter(x => x.exp === nearestExp); // pudo acumular exps que "eran" nearest
  const strikes = [...byStrike.values()].sort((a, b) => a.k - b.k);
  if (!strikes.length) throw new Error('sin strikes ≤45d dentro de ±15% para ' + tk);
  let callWall = strikes[0], putWall = strikes[0], gexTotal = 0;
  for (const s of strikes) {
    gexTotal += s.gex;
    if (s.gex > callWall.gex) callWall = s;
    if (s.gex < putWall.gex) putWall = s;
  }
  let flip = null, cum = 0, prevCum = 0; // strike donde el GEX acumulado cruza a positivo
  for (const s of strikes) {
    prevCum = cum; cum += s.gex;
    if (prevCum < 0 && cum >= 0) { flip = s.k; break; }
  }
  let maxPain = null, best = Infinity; // expiración más cercana: argmin del payout a holders
  for (const K of [...new Set(near.map(x => x.k))].sort((a, b) => a - b)) {
    let pay = 0;
    for (const x of near) pay += x.isCall ? x.oi * Math.max(0, K - x.k) : x.oi * Math.max(0, x.k - K);
    if (pay < best) { best = pay; maxPain = K; }
  }
  return {
    tk, spot, updated: j.timestamp || null, nearestExp, expiries: expiries.size,
    pcVol: cVolT > 0 ? +(pVolT / cVolT).toFixed(2) : null,
    pcOI: cOIT > 0 ? +(pOIT / cOIT).toFixed(2) : null,
    gexTotalBn: +(gexTotal / 1e9).toFixed(2),
    dexTotalBn: +(dexTotal / 1e9).toFixed(2), // E0: delta-dollars netos (dealers "largos/cortos de delta")
    ivAtm: emWeekly?.ivAtm ?? emDaily?.ivAtm ?? null, // E0: IV ATM de referencia (semanal preferida)
    emDaily, emWeekly, // E0: expected move {exp, dte, em, pct, ivAtm}
    callWall: callWall.k, putWall: putWall.k, gammaFlip: flip, maxPain,
    strikes: strikes.map(s => ({ k: s.k, cOI: s.cOI, pOI: s.pOI, gex: +(s.gex / 1e6).toFixed(1), dex: +(s.dex / 1e6).toFixed(1) })) // gex/dex $M
  };
}

// ── F-I3 · FINRA ATS weeklySummary: dark pools por ticker (sin auth, validado en dev) ──
// summaryTypeCode: ATS_W_SMBL = total dark pools símbolo/semana · ATS_W_SMBL_FIRM = por venue
// · OTC_W_SMBL(_FIRM) = internalizadores non-ATS (Citadel/Virtu/...). Lag publicación:
// ~2 sem (Tier 1) a 4 sem (Tier 2/OTC) — el cliente SIEMPRE etiqueta la semana del dato.
async function atsWeekly(tickers) {
  const since = new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch('https://api.finra.org/data/group/otcMarket/name/weeklySummary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      limit: 8000,
      domainFilters: [{ fieldName: 'issueSymbolIdentifier', values: tickers }],
      dateRangeFilters: [{ fieldName: 'weekStartDate', startDate: since, endDate: today }]
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('FINRA ATS HTTP ' + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('FINRA ATS: respuesta no es lista');
  const data = {};
  const wkMap = {};
  for (const x of rows) {
    const tk = x.issueSymbolIdentifier;
    if (!tickers.includes(tk)) continue;
    const m = wkMap[tk] || (wkMap[tk] = {});
    const w = m[x.weekStartDate] || (m[x.weekStartDate] = { week: x.weekStartDate, ats: 0, atsTrades: 0, otc: 0 });
    if (x.summaryTypeCode === 'ATS_W_SMBL') { w.ats = +x.totalWeeklyShareQuantity || 0; w.atsTrades = +x.totalWeeklyTradeCount || 0; }
    else if (x.summaryTypeCode === 'OTC_W_SMBL') w.otc = +x.totalWeeklyShareQuantity || 0;
  }
  for (const tk of tickers) {
    const weeks = Object.values(wkMap[tk] || {}).sort((a, b) => a.week < b.week ? -1 : 1);
    if (!weeks.length) { data[tk] = { error: 'sin data ATS' }; continue; }
    const last = weeks[weeks.length - 1].week;
    const top = (code) => rows
      .filter(x => x.issueSymbolIdentifier === tk && x.summaryTypeCode === code && x.weekStartDate === last)
      .sort((a, b) => b.totalWeeklyShareQuantity - a.totalWeeklyShareQuantity).slice(0, 3)
      .map(x => ({ name: (x.marketParticipantName || x.MPID || '?').trim(), sh: +x.totalWeeklyShareQuantity || 0 }));
    data[tk] = { weeks, topATS: top('ATS_W_SMBL_FIRM'), topOTC: top('OTC_W_SMBL_FIRM') };
  }
  return { data, since };
}

// ── F-I4 · CFTC COT (Socrata, sin key): posicionamiento semanal en futuros ──
// Legacy Futures-Only. Códigos confirmados contra la API 2026-07-10 ($select distinct).
// Percentil 3 AÑOS del net de especuladores: >=90 crowded long / <=10 crowded short (contrarian).
const COT_MKTS = [
  { code: '13874A', lbl: 'ES · S&P 500' },
  { code: '209742', lbl: 'NQ · Nasdaq 100' },
  { code: '088691', lbl: 'GOLD' },
  { code: '098662', lbl: 'DXY · US Dollar Idx' },
  { code: '043602', lbl: '10Y · T-Note' },
  { code: '099741', lbl: 'EUR · Euro FX' },
  { code: '133741', lbl: 'BTC · CME' },
  { code: '1170E1', lbl: 'VIX · futuros' }
];
async function cotPositioning() {
  const since = new Date(Date.now() - 3.1 * 365 * 86400000).toISOString().slice(0, 10);
  const codes = COT_MKTS.map(m => "'" + m.code + "'").join(',');
  const url = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'
    + '?$select=cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all,open_interest_all'
    + '&$where=' + encodeURIComponent('cftc_contract_market_code in(' + codes + ") AND report_date_as_yyyy_mm_dd>='" + since + "'")
    + '&$order=report_date_as_yyyy_mm_dd&$limit=2500';
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('CFTC Socrata HTTP ' + r.status);
  const rows = await r.json();
  const byCode = {};
  for (const x of rows) (byCode[x.cftc_contract_market_code] || (byCode[x.cftc_contract_market_code] = [])).push(x);
  const out = [];
  for (const m of COT_MKTS) {
    const hist = (byCode[m.code] || []).map(x => ({
      d: x.report_date_as_yyyy_mm_dd.slice(0, 10),
      net: (+x.noncomm_positions_long_all || 0) - (+x.noncomm_positions_short_all || 0),
      netComm: (+x.comm_positions_long_all || 0) - (+x.comm_positions_short_all || 0),
      oi: +x.open_interest_all || 0
    }));
    if (hist.length < 30) { out.push({ ...m, error: 'hist insuficiente (' + hist.length + ')' }); continue; }
    const cur = hist[hist.length - 1], prev = hist[hist.length - 2];
    const rank = hist.filter(h => h.net <= cur.net).length / hist.length * 100;
    out.push({
      code: m.code, lbl: m.lbl, date: cur.d,
      net: cur.net, netComm: cur.netComm,
      netPctOI: cur.oi > 0 ? +(cur.net / cur.oi * 100).toFixed(1) : null,
      dWeek: cur.net - prev.net,
      pctil3y: +rank.toFixed(0),
      weeks: hist.length,
      spark: hist.slice(-26).map(h => h.net)
    });
  }
  return { mkts: out, updated: out.find(o => o.date)?.date || null };
}

// ── F-I5 · stockanalysis /statistics/: ownership institucional + short interest ──
// Misma infra de scraping tolerada que holdings.js/flows.js. La página incrusta un JSON
// limpio {id:"sharesInstitutions",title:"...",value:"69.07%"} — verificado 2026-07-10.
async function ownStats(tickers) {
  const data = {}, errors = [];
  const one = async (tk) => {
    const r = await fetch('https://stockanalysis.com/stocks/' + tk.toLowerCase() + '/statistics/', {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital-Dashboard/1.0)' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const grab = (id) => {
      const m = html.match(new RegExp('\\{id:"' + id + '",title:"[^"]+",value:"([^"]*)"'));
      if (!m || m[1] === 'n/a' || m[1] === '') return null;
      const v = parseFloat(m[1].replace(/[%,$]/g, ''));
      return isFinite(v) ? v : null;
    };
    const instOwn = grab('sharesInstitutions'), insiderOwn = grab('sharesInsiders');
    const shortFloat = grab('shortFloat'), daysToCover = grab('shortRatio');
    if (instOwn == null && shortFloat == null) throw new Error('parse vacío (¿cambió el HTML?)');
    // Sanity (patrón flows.js): porcentajes en rango
    if (instOwn != null && (instOwn < 0 || instOwn > 105)) throw new Error('instOwn fuera de rango: ' + instOwn);
    return { instOwn, insiderOwn, shortFloat, daysToCover };
  };
  for (let i = 0; i < tickers.length; i += 3) {
    await Promise.all(tickers.slice(i, i + 3).map(async tk => {
      try { data[tk] = await one(tk); } catch (e) { errors.push(tk + '=' + e.message); }
    }));
  }
  return { data, errors };
}

// ── CRYPTO · opciones BTC/ETH vía Deribit (API pública, sin auth) — mismo shape que optAgg ──
// Deribit no da griegas en book_summary → Black-Scholes desde mark_iv (r=0). 1 contrato = 1 moneda.
// Extras crypto en la misma respuesta: funding (Binance) + Fear&Greed (alternative.me).
const _CRYPTO_MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
function _phi(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
function _Phi(x) { // CDF normal, Abramowitz-Stegun (mismo enfoque que _phiCdf del frontend)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = _phi(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
async function optcAgg(cur) {
  if (!/^(BTC|ETH)$/.test(cur)) throw new Error('optc soporta BTC o ETH');
  const r = await fetch('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=' + cur + '&kind=option', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Deribit HTTP ' + r.status);
  const rows = (await r.json()).result || [];
  const S = rows.find(x => x.underlying_price > 0)?.underlying_price;
  if (!(S > 0)) throw new Error('Deribit sin underlying_price');
  const now = Date.now(), maxT = now + 45 * 86400000;
  const reI = new RegExp('^' + cur + '-(\\d{1,2})([A-Z]{3})(\\d{2})-(\\d+)-([CP])$');
  const byStrike = new Map(), atm = new Map(), exps = new Set(), nearRows = [];
  let cVol = 0, pVol = 0, cOIt = 0, pOIt = 0, dexTotal = 0, nearestExp = null;
  for (const o of rows) {
    const m = reI.exec(o.instrument_name);
    if (!m) continue;
    const exp = Date.UTC(2000 + +m[3], +_CRYPTO_MONTHS[m[2]] - 1, +m[1], 8);
    if (exp < now || exp > maxT) continue;
    const K = +m[4], isCall = m[5] === 'C';
    const oi = +o.open_interest || 0, vol = +o.volume || 0, iv = (+o.mark_iv || 0) / 100;
    exps.add(exp);
    if (!nearestExp || exp < nearestExp) nearestExp = exp;
    if (isCall) { cVol += vol; cOIt += oi; } else { pVol += vol; pOIt += oi; }
    if (exp === nearestExp) nearRows.push({ k: K, isCall, oi, exp });
    if (!(iv > 0)) continue;
    const T = Math.max((exp - now) / 86400000, 0.05) / 365;
    const d1 = (Math.log(S / K) + (iv * iv / 2) * T) / (iv * Math.sqrt(T));
    const gamma = _phi(d1) / (S * iv * Math.sqrt(T));
    const delta = isCall ? _Phi(d1) : _Phi(d1) - 1;
    dexTotal += delta * oi * S;
    if (Math.abs(K - S) / S <= 0.05) {
      let e = atm.get(exp); if (!e) { e = new Map(); atm.set(exp, e); }
      let leg = e.get(K); if (!leg) { leg = {}; e.set(K, leg); }
      if (isCall) leg.cIv = iv; else leg.pIv = iv;
    }
    if (K < S * 0.75 || K > S * 1.25) continue; // crypto se mueve más: ±25%
    let row = byStrike.get(K);
    if (!row) { row = { k: K, cOI: 0, pOI: 0, gex: 0, dex: 0 }; byStrike.set(K, row); }
    const gexUsd = gamma * oi * S * S * 0.01;
    row.dex += delta * oi * S;
    if (isCall) { row.cOI += oi; row.gex += gexUsd; } else { row.pOI += oi; row.gex -= gexUsd; }
  }
  const near = nearRows.filter(x => x.exp === nearestExp);
  const strikes = [...byStrike.values()].sort((a, b) => a.k - b.k);
  if (!strikes.length) throw new Error('sin strikes ≤45d para ' + cur);
  let callWall = strikes[0], putWall = strikes[0], gexTotal = 0;
  for (const s of strikes) { gexTotal += s.gex; if (s.gex > callWall.gex) callWall = s; if (s.gex < putWall.gex) putWall = s; }
  let flip = null, cum = 0, prevC = 0;
  for (const s of strikes) { prevC = cum; cum += s.gex; if (prevC < 0 && cum >= 0) { flip = s.k; break; } }
  let maxPain = null, best = Infinity;
  for (const K of [...new Set(near.map(x => x.k))].sort((a, b) => a - b)) {
    let pay = 0;
    for (const x of near) pay += x.isCall ? x.oi * Math.max(0, K - x.k) : x.oi * Math.max(0, x.k - K);
    if (pay < best) { best = pay; maxPain = K; }
  }
  const emOf2 = (exp) => {
    const e = atm.get(exp);
    if (!e) return null;
    let bk = null, bd = Infinity;
    for (const K of e.keys()) if (Math.abs(K - S) < bd) { bd = Math.abs(K - S); bk = K; }
    const leg = e.get(bk);
    const ivA = (leg.cIv && leg.pIv) ? (leg.cIv + leg.pIv) / 2 : (leg.cIv || leg.pIv || null);
    if (!ivA) return null;
    const dte = Math.max((exp - now) / 86400000, 0.25);
    const em = S * ivA * Math.sqrt(dte / 365);
    return { exp: new Date(exp).toISOString().slice(0, 10), dte: +dte.toFixed(1), em: +em.toFixed(2), pct: +(em / S * 100).toFixed(2), ivAtm: +ivA.toFixed(4) };
  };
  const expList = [...exps].sort((a, b) => a - b);
  const wk = expList.find(e => { const d2 = (e - now) / 86400000; return d2 >= 4 && d2 <= 10; }) || null;
  const emDaily = emOf2(nearestExp);
  const emWeekly = wk && wk !== nearestExp ? emOf2(wk) : null;
  // extras crypto (fallo tolerado). Funding: Binance bloquea IPs de EE.UU. (Vercel iad1)
  // → OKX como fuente primaria (accesible desde US, verificado), Binance de respaldo.
  const [frOkx, frBin, fg] = await Promise.all([
    fetch('https://www.okx.com/api/v5/public/funding-rate?instId=' + cur + '-USDT-SWAP', { signal: AbortSignal.timeout(6000) }).then(x => x.json()).catch(() => null),
    fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + cur + 'USDT', { signal: AbortSignal.timeout(5000) }).then(x => x.json()).catch(() => null),
    fetch('https://api.alternative.me/fng/', { signal: AbortSignal.timeout(6000) }).then(x => x.json()).catch(() => null)
  ]);
  const fundingRaw = frOkx?.data?.[0]?.fundingRate != null ? +frOkx.data[0].fundingRate
    : (frBin?.lastFundingRate != null ? +frBin.lastFundingRate : null);
  return {
    tk: cur, spot: S, updated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    nearestExp: new Date(nearestExp).toISOString().slice(0, 10), expiries: exps.size,
    pcVol: cVol > 0 ? +(pVol / cVol).toFixed(2) : null,
    pcOI: cOIt > 0 ? +(pOIt / cOIt).toFixed(2) : null,
    gexTotalBn: +(gexTotal / 1e9).toFixed(2), dexTotalBn: +(dexTotal / 1e9).toFixed(2),
    ivAtm: emWeekly?.ivAtm ?? emDaily?.ivAtm ?? null, emDaily, emWeekly,
    callWall: callWall.k, putWall: putWall.k, gammaFlip: flip, maxPain,
    strikes: strikes.map(s => ({ k: s.k, cOI: +s.cOI.toFixed(1), pOI: +s.pOI.toFixed(1), gex: +(s.gex / 1e6).toFixed(1), dex: +(s.dex / 1e6).toFixed(1) })),
    crypto: {
      funding: fundingRaw != null ? +(fundingRaw * 100).toFixed(4) : null, // % por 8h
      fearGreed: fg?.data?.[0] ? { v: +fg.data[0].value, txt: fg.data[0].value_classification } : null
    }
  };
}

// ── E6 · Alertas de ZONA por Telegram (cron mediodía, 2º y último cron del plan Hobby) ──
// Lee las zonas del último snapshot (top-3 del embudo) y avisa si el precio ESTÁ o ENTRÓ
// hoy en zona. Stateless: "entró hoy" = cierre previo FUERA (arriba) y precio actual dentro
// — sin archivo de estado. Si no hay nada que avisar, no manda nada (cero spam).
async function zoneAlerts() {
  const l = await trackList();
  if (!l.dates?.length) return { sent: false, reason: 'sin snapshots' };
  const s = await trackGet(l.dates[l.dates.length - 1]);
  const zonas = (s?.zonas || []).slice(0, 5);
  if (!zonas.length) return { sent: false, reason: 'el snapshot no tiene zonas aún' };
  const qs = await Promise.all(zonas.map(z => quoteMini(z.tk)));
  const hits = [];
  zonas.forEach((z, i) => {
    const q = qs[i];
    if (!q?.p) return;
    const inZone = q.p >= z.lo && q.p <= z.hi;
    if (!inZone) return;
    // prev close desde chg: prev = p / (1 + chg/100). "Entró hoy" si venía de ARRIBA de la banda
    const prev = (q.chg != null && q.chg > -100) ? q.p / (1 + q.chg / 100) : null; // guard chg=-100 (review)
    const entered = prev != null && prev > z.hi;
    hits.push('🎯 <b>' + z.tk + (entered ? ' ENTRÓ HOY' : ' EN ZONA') + '</b> ' + z.lo + '–' + z.hi
      + ' (precio ' + q.p.toFixed(2) + ') · score ' + z.score + ' · ' + (z.comp || '').split('+').slice(0, 3).join('+'));
  });
  if (!hits.length) return { sent: false, reason: 'ninguna zona activa', checked: zonas.length };
  await tgSend('⚡ <b>Alerta de zonas</b> · ' + new Date().toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' })
    + '\n' + hits.join('\n')
    + '\nZonas del embudo (snapshot ' + s.date + ') — contexto, no señal: tu price action decide el timing.'
    + '\n<a href="https://dash-board-strauss.vercel.app/#act">Abrir dashboard</a>');
  return { sent: true, hits: hits.length, ts: new Date().toISOString() };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const src = String(req.query.src || '');

  // F4 · track record + F5 · digest + F-I4 · COT (no requieren ?tickers=)
  try {
    if (src === 'cot') {
      const out = await cotPositioning();
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6h — publica viernes
      return res.status(200).json(out);
    }
    if (src === 'alerts') {
      // E6: mismo candado que digest — solo el cron de Vercel (o quien tenga el secret)
      const sec = process.env.CRON_SECRET;
      if (sec && req.headers.authorization !== 'Bearer ' + sec) return res.status(401).json({ error: 'no autorizado' });
      const out = await zoneAlerts();
      res.setHeader('Cache-Control', 'max-age=0, no-cache');
      return res.status(200).json(out);
    }
    if (src === 'digest') {
      // protegido: si CRON_SECRET está configurada, solo el cron de Vercel puede dispararlo
      const sec = process.env.CRON_SECRET;
      if (sec && req.headers.authorization !== 'Bearer ' + sec) return res.status(401).json({ error: 'no autorizado' });
      const out = await digest();
      res.setHeader('Cache-Control', 'max-age=0, no-cache');
      return res.status(200).json(out);
    }
    if (src === 'track') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'track es POST' });
      const out = await trackSave(req.body || {});
      res.setHeader('Cache-Control', 'max-age=0, no-cache');
      return res.status(200).json(out);
    }
    if (src === 'tracklist') {
      const out = await trackList();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json(out);
    }
    if (src === 'trackget') {
      const out = await trackGet(req.query.date);
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400'); // inmutable
      return res.status(200).json(out);
    }
  } catch (e) {
    return res.status(e.code === 'NO_TOKEN' || e.code === 'NO_TG' ? 200 : 502).json({ error: e.message, code: e.code || null });
  }

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
    if (src === 'opt') {
      // 1 ticker por llamada (raw grande + cache CDN por URL). Ticker sin opciones (CBOE
      // 403/404) NO es un error del sistema → 200 con {error} (patrón insiders, consola limpia)
      try {
        const out = await optAgg(tickers[0]);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=3600'); // 1h — muros se mueven lento
        return res.status(200).json(out);
      } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=3600'); // el "sin opciones" tampoco cambia en 1h
        return res.status(200).json({ error: e.message });
      }
    }
    if (src === 'ats') {
      // FINRA a veces se cae (504/500 visto 2026-07-10) → 200 con {error} sin cache
      // (consola limpia; el cliente degrada y se reintenta cuando FINRA vuelva)
      try {
        const out = await atsWeekly(tickers.slice(0, 10)); // 1 request FINRA para todos (domainFilters)
        res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=43200'); // 12h — dato semanal con lag
        return res.status(200).json(out);
      } catch (e) {
        res.setHeader('Cache-Control', 'max-age=0, no-cache');
        return res.status(200).json({ error: 'FINRA no disponible: ' + e.message });
      }
    }
    if (src === 'optc') {
      // crypto: mismo patrón 200-{error} que opt (ticker sin cadena Deribit = degradación limpia)
      try {
        const out = await optcAgg(tickers[0]);
        res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=900'); // 15 min — crypto 24/7
        return res.status(200).json(out);
      } catch (e) {
        res.setHeader('Cache-Control', 'max-age=0, no-cache');
        return res.status(200).json({ error: e.message });
      }
    }
    if (src === 'stats') {
      const out = await ownStats(tickers.slice(0, 5)); // scraping: pocos y con concurrency 3
      res.setHeader('Cache-Control', Object.keys(out.data).length ? 's-maxage=86400, stale-while-revalidate=43200' : 'max-age=0, no-cache'); // dato trimestral/quincenal
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'src debe ser finra | insiders | earnings | opt | ats | stats' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
