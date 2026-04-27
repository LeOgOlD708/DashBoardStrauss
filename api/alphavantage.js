// api/alphavantage.js
// Proxy serverless para Alpha Vantage — Vercel Function
// Protege la API key y evita exponerla en el frontend

export default async function handler(req, res) {
  // Headers CORS para que el dashboard pueda llamarlo
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { function: func = 'SECTOR', symbol } = req.query;
  const apiKey = process.env.ALPHA_VANTAGE_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ALPHA_VANTAGE_KEY no configurada en Vercel' });
  }

  // Construir URL según la función solicitada
  let url = `https://www.alphavantage.co/query?function=${func}&apikey=${apiKey}`;
  if (symbol) url += `&symbol=${symbol}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Error en Alpha Vantage' });
    }

    const data = await response.json();

    // Detectar límite de API excedido
    if (data.Note || data.Information) {
      return res.status(429).json({
        error: 'Límite de Alpha Vantage excedido (25 llamadas/día)',
        detail: data.Note || data.Information
      });
    }

    // Cache de 6 horas — los datos sectoriales son diarios
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Error interno del proxy', detail: error.message });
  }
}
