// api/gemini.js — Catalysts v2 del Opportunity Scanner (Gemini 2.5 Flash + Google Search grounding)
// v2 2026-07-07: (1) grounding con Google Search → catalysts de noticias REALES de los
// últimos 7 días (v1 alucinaba: el modelo no tenía acceso a internet y se le pedía "qué
// pasó esta semana"); (2) contexto rico: métricas vivas del scanner + titulares RSS del
// propio dashboard + eventos del calendario; (3) brief estructurado en 4 secciones.
// Fallback: si el grounding falla (cuota/400), reintenta SIN tools y lo marca en la respuesta.
// Aislado de /api/chat (Tab 01). Reusa GEMINI_API_KEY.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function buildPrompt({ ticker, sectorName, holdings, score, metrics, news, events }) {
  const holdingsTxt = holdings.length ? holdings.join(', ') : '(no provistos)';
  const m = metrics || {};
  const fmt = (v, suf = '%') => (typeof v === 'number' && isFinite(v)) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}${suf}` : 'n/d';
  const metricsTxt = [
    `1D ${fmt(m.chg1d)} · 1W ${fmt(m.chg1w)} · 1M ${fmt(m.chg1m)}`,
    `RS vs SPY (1M): ${fmt(m.momentumValue, ' pp')}`,
    `Volumen vs promedio 20d: ${typeof m.volRatio === 'number' ? m.volRatio.toFixed(2) + 'x' : 'n/d'}`,
    `Distancia a SMA50: ${fmt(m.distSma)} · a máximo 52w: ${fmt(m.dist52w)}`,
    `Score Opportunity Scanner: ${score != null ? score + '/100' : 'n/d'}`
  ].join('\n  ');
  const newsTxt = news.length ? news.map(n => `- ${n}`).join('\n') : '(sin titulares RSS disponibles)';
  const eventsTxt = events.length ? events.map(e => `- ${e}`).join('\n') : '(sin eventos en ventana)';

  return `Eres analista macro/sectorial institucional. Analiza el sector ${sectorName} (ETF ${ticker}, top holdings: ${holdingsTxt}).

DATOS DUROS DEL DASHBOARD (fuente de verdad para la sección 1 — NO los contradigas):
  ${metricsTxt}

TITULARES RSS DEL DASHBOARD (últimas 24-48h, pueden o no ser relevantes al sector):
${newsTxt}

EVENTOS MACRO PRÓXIMOS (calendario oficial del dashboard):
${eventsTxt}

USA LA BÚSQUEDA DE GOOGLE para encontrar qué movió a ${sectorName} y sus top holdings EN LOS ÚLTIMOS 7 DÍAS (earnings, guidance, datos económicos, regulación, M&A, flujos). Prioriza hechos con fecha y número verificables.

FORMATO EXIGIDO (texto plano, sin markdown de encabezados, en español, máximo ~1400 caracteres):
📊 MOVIMIENTO
2 líneas: qué hizo el sector esta semana usando los DATOS DUROS de arriba (números exactos).

📰 CATALYSTS · ÚLTIMOS 7 DÍAS
3 a 5 bullets "• " (≤160 caracteres c/u), cada uno con fecha o dato concreto de la búsqueda. Si un titular RSS del dashboard es relevante, úsalo y márcalo con [RSS].

👀 PRÓXIMOS 7 DÍAS
2-3 bullets "• ": eventos del calendario que afectan a este sector + fechas de earnings de sus holdings si las encuentras.

⚖️ LECTURA
1 línea: cómo cuadran los catalysts con el score del scanner (confirma o contradice).

Sin disclaimers, sin preámbulos, sin inventar: si la búsqueda no da resultados claros, di "sin catalysts claros identificados" en vez de especular.`;
}

async function callGemini(apiKey, prompt, useGrounding, disableThinking = true) {
  const generationConfig = { maxOutputTokens: 3000, temperature: 0.3 };
  // gemini-2.5 gasta el budget en "thinking" ANTES del texto → briefs truncados a
  // mitad de sección (verificado empírico: 234 chars de ~1400). thinkingBudget 0
  // dedica todo el budget al output.
  if (disableThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig
  };
  if (useGrounding) body.tools = [{ google_search: {} }];
  const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(useGrounding ? 20000 : 9000),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Gemini ${response.status}: ${errText.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini no generó texto');
  // Fuentes del grounding (si las hay) — para mostrar transparencia en el modal
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Set(chunks.map(c => c.web?.title || c.web?.uri).filter(Boolean))].slice(0, 5);
  return { text, sources };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en Vercel' });

  const { ticker, sectorName, holdings = [], score, metrics = {}, news = [], events = [] } = req.body || {};
  if (!ticker || !sectorName) {
    return res.status(400).json({ error: 'Faltan campos: ticker y sectorName son obligatorios' });
  }
  // Límites anti-abuso: endpoint público que quema cuota Gemini + grounding
  if (String(ticker).length > 10 || String(sectorName).length > 100) {
    return res.status(400).json({ error: 'ticker/sectorName exceden longitud permitida' });
  }
  if (!Array.isArray(holdings) || holdings.length > 20 || holdings.some(h => String(h).length > 12)) {
    return res.status(400).json({ error: 'holdings: máximo 20 items de 12 chars' });
  }
  if (!Array.isArray(news) || news.length > 12 || news.some(n => String(n).length > 200)) {
    return res.status(400).json({ error: 'news: máximo 12 titulares de 200 chars' });
  }
  if (!Array.isArray(events) || events.length > 8 || events.some(e => String(e).length > 100)) {
    return res.status(400).json({ error: 'events: máximo 8 items de 100 chars' });
  }
  if (metrics && typeof metrics !== 'object') return res.status(400).json({ error: 'metrics debe ser objeto' });

  const prompt = buildPrompt({
    ticker: String(ticker), sectorName: String(sectorName),
    holdings: holdings.map(String), score,
    metrics, news: news.map(String), events: events.map(String)
  });

  try {
    // Intento 1: grounding + sin thinking (catalysts reales, budget completo al texto)
    const { text, sources } = await callGemini(apiKey, prompt, true, true);
    return res.status(200).json({ reply: text, grounded: true, sources });
  } catch (e1) {
    try {
      // Intento 2: sin grounding, sin thinking
      const { text } = await callGemini(apiKey, prompt, false, true);
      return res.status(200).json({
        reply: text + '\n\n⚠ Generado SIN búsqueda web (grounding no disponible: ' + (e1.status || e1.message || 'error') + ') — los catalysts pueden no reflejar noticias reales.',
        grounded: false, sources: []
      });
    } catch (e2) {
      try {
        // Intento 3: config mínima (por si thinkingConfig no es aceptado por la API)
        const { text } = await callGemini(apiKey, prompt, false, false);
        return res.status(200).json({
          reply: text + '\n\n⚠ Generado SIN búsqueda web — los catalysts pueden no reflejar noticias reales.',
          grounded: false, sources: []
        });
      } catch (e3) {
        return res.status(502).json({ error: 'Gemini error: ' + (e3.message || 'desconocido') });
      }
    }
  }
};
