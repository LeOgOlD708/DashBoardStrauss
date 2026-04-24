// api/chat.js — Gemini 2.0 Flash chat proxy for DashboardStrauss

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en Vercel' });

  const { message, history = [], systemPrompt = '' } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Falta el campo message' });

  // Build multi-turn contents array (last 10 turns max to control tokens)
  const recentHistory = history.slice(-10);
  const contents = [
    ...recentHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
          generationConfig: { maxOutputTokens: 1024, temperature: 0.6 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Gemini error: ' + errText });
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || 'El asistente no generó respuesta. Intenta de nuevo.';

    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
