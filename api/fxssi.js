// api/fxssi.js — L3 Tab 11: sentimiento retail forex/oro AGREGADO multi-broker
// Fuente: fxssi.com/api/current-ratios (público sin auth, verificado 2026-07-19) —
// incluye Oanda/Myfxbook/IG/XM/Dukascopy con pesos oficiales del propio FXSSI.
// Reemplaza al positionBook de OANDA v20 (la cuenta demo nunca llegó). El endpoint
// no manda CORS → este proxy. Devuelve % long ponderado por símbolo + nº brokers.
// Cache CDN 10 min (la fuente refresca cada 10 min).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const r = await fetch('https://fxssi.com/api/current-ratios?rand=' + Math.random() + '&user_id=0', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RebirthCapital/1.0)' },
    });
    if (!r.ok) throw new Error('fxssi HTTP ' + r.status);
    const j = await r.json();
    const w = j.broker_weights || {}, bs = j.brokers || {}, acc = {};
    for (const bk in bs) {
      const wt = +w[bk] > 0 ? +w[bk] : 1;
      for (const sym in bs[bk]) {
        const v = parseFloat(bs[bk][sym]);
        if (!(v > 0) || v >= 100) continue;
        if (!acc[sym]) acc[sym] = { s: 0, k: 0, n: 0, vals: [] };
        acc[sym].s += v * wt; acc[sym].k += wt; acc[sym].n++; acc[sym].vals.push(v);
      }
    }
    const sym = {};
    for (const k in acc) {
      const a = acc[k], mean = a.s / a.k;
      const sd = a.vals.length > 1 ? Math.sqrt(a.vals.reduce((x, v) => x + (v - mean) * (v - mean), 0) / (a.vals.length - 1)) : 0;
      sym[k] = { long: +mean.toFixed(1), brokers: a.n, disp: +sd.toFixed(1) }; // disp = desacuerdo entre brokers
    }
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    return res.status(200).json({ t: Date.now(), sym });
  } catch (e) {
    return res.status(200).json({ error: String(e && e.message || e).slice(0, 140) });
  }
};
