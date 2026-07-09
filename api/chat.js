// api/chat.js — Gemini 2.0 Flash chat proxy for DashboardStrauss

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en Vercel' });

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { message, history = [], systemPrompt = '' } = body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Falta el campo message' });
  // Límites anti-abuso: el endpoint es público (auth es client-side) y quema cuota Gemini
  if (message.length > 5000) return res.status(400).json({ error: 'message: máximo 5000 caracteres' });
  if (!Array.isArray(history) || history.length > 20) return res.status(400).json({ error: 'history: máximo 20 turnos' });
  if (typeof systemPrompt === 'string' && systemPrompt.length > 8000) return res.status(400).json({ error: 'systemPrompt demasiado largo' });

  // Build multi-turn contents array (last 10 turns max to control tokens)
  const recentHistory = history.slice(-10);
  const contents = [
    ...recentHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];

  // Tanda 1 #10 (2026-07-09): grounding con Google Search también en el chat (antes solo
  // Catalysts lo tenía) — Phoenix puede citar noticias REALES. Doble intento: con tools
  // primero; si falla (cuota/400), sin tools como siempre. maxDuration 20 en vercel.json.
  const call = async (useGrounding) => {
    const body = {
      contents,
      ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
      // 2048: gemini-2.5 consume parte del budget en thinking; 1024 truncaba
      // los JSON largos de la Tesis IA ("Unexpected end of JSON input")
      generationConfig: { maxOutputTokens: 2048, temperature: 0.6 }
    };
    if (useGrounding) body.tools = [{ google_search: {} }];
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(useGrounding ? 15000 : 8000),
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) { const t = await response.text(); const err = new Error('Gemini ' + response.status + ': ' + t.slice(0, 160)); err.status = response.status; throw err; }
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const reply = parts.map(p => p.text || '').join('').trim();
    if (!reply) throw new Error('sin texto');
    return reply;
  };

  try {
    try {
      const reply = await call(true);
      return res.status(200).json({ reply, grounded: true });
    } catch (e1) {
      const reply = await call(false);
      return res.status(200).json({ reply, grounded: false });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
