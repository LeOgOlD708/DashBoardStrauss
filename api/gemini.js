// api/gemini.js — Gemini 2.5 Flash proxy especializado para Catalysts del Opportunity Scanner
// Aislado de /api/chat (Tab 01 chat IA): prompt estructurado, temperatura baja, sin history.
// Reusa misma env var GEMINI_API_KEY.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en Vercel' });

  const { ticker, sectorName, holdings = [], score } = req.body || {};
  if (!ticker || !sectorName) {
    return res.status(400).json({ error: 'Faltan campos: ticker y sectorName son obligatorios' });
  }

  const holdingsTxt = Array.isArray(holdings) && holdings.length
    ? holdings.join(', ')
    : '(holdings no provistos)';
  const scoreTxt = score != null ? `${score}/100` : 'no disponible';

  const prompt = `Eres un analista macro/sectorial. Resume en MÁXIMO 3 bullets (cada uno ≤150 caracteres) qué catalysts movieron al sector ${sectorName} (${ticker}, top holdings: ${holdingsTxt}) EN LOS ÚLTIMOS 7 DÍAS.

Incluye cuando aplique: datos económicos, decisiones de bancos centrales, earnings sorpresa, M&A, geopolítica, flujos.

Sé específico (números, fechas, nombres). Sin disclaimers ni preámbulos. Idioma: español.

Score Opportunity Scanner actual: ${scoreTxt}. Explica qué eventos lo justifican.

Formato exigido: 3 líneas que comiencen con "• " y nada más.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 350, temperature: 0.3 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Gemini error: ' + errText });
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || 'Gemini no generó respuesta. Intenta de nuevo.';

    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
