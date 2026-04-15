// api/fred.js — Vercel Serverless Function
// Calls FRED API server-side (no CORS issues, API key never exposed to browser)

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'FRED_API_KEY no está configurada en las variables de entorno de Vercel.'
    });
  }

  const { series, limit = '14' } = req.query;
  if (!series) return res.status(400).json({ error: 'Falta el parámetro ?series=' });

  const seriesList = series.split(',').map(s => s.trim()).filter(Boolean);
  const results = {};

  // Parallel server-side fetches — no CORS, no proxy, no restrictions
  await Promise.all(
    seriesList.map(async (s) => {
      try {
        const url = `${FRED_BASE}?series_id=${s}&limit=${limit}&sort_order=desc&file_type=json&api_key=${apiKey}`;
        const response = await fetch(url);

        if (!response.ok) {
          results[s] = { error: `HTTP ${response.status}` };
          return;
        }

        const data = await response.json();

        if (data.error_code) {
          results[s] = { error: data.error_message || `Código ${data.error_code}` };
          return;
        }

        results[s] = (data.observations || [])
          .filter(o => o.value !== '.')
          .map(o => ({ date: o.date, value: parseFloat(o.value) }));

      } catch (e) {
        results[s] = { error: e.message };
      }
    })
  );

  // Cache 1 hour — FRED data is weekly/monthly/daily, doesn't need real-time
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(results);
};
