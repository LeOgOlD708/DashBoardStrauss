// api/news.js — Vercel Serverless Function
// Fetches and filters macro-relevant news from MarketWatch RSS

const FEEDS = [
  'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
  'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
];

const HIGH_IMPACT = ['federal reserve','rate hike','rate cut','iran','hormuz','repo crisis',
  'default','emergency','systemic','fed pivot','quantitative','bank failure'];

const MED_IMPACT  = ['inflation','treasury','oil price','crude','gold','pboc','recession',
  'yield curve','tariff','powell','fed funds','liquidity','gdp','jobs report'];

const MACRO_KEYWORDS = [...HIGH_IMPACT, ...MED_IMPACT,
  'fed','dxy','dollar index','spreads','credit','bonds','debt ceiling'];

function getImpact(text) {
  if (HIGH_IMPACT.some(k => text.includes(k))) return 'high';
  if (MED_IMPACT.some(k => text.includes(k)))  return 'med';
  return 'low';
}

function extractCdata(xml, tag) {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, 's'));
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 's'));
  return plainMatch ? plainMatch[1].trim() : '';
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const allItems = [];

  await Promise.allSettled(
    FEEDS.map(async (feedUrl) => {
      try {
        const response = await fetch(feedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml' }
        });

        if (!response.ok) return;

        const xml = await response.text();
        const itemBlocks = xml.split(/<item[\s>]/i).slice(1);

        for (const block of itemBlocks.slice(0, 12)) {
          const title   = decodeHtml(extractCdata(block, 'title'));
          const link    = extractCdata(block, 'link') || block.match(/<link>(.*?)<\/link>/s)?.[1] || '#';
          const pubDate = extractCdata(block, 'pubDate');
          const desc    = decodeHtml(extractCdata(block, 'description')).slice(0, 200);

          if (!title) continue;

          const text = (title + ' ' + desc).toLowerCase();
          const isMacro = MACRO_KEYWORDS.some(kw => text.includes(kw));

          if (isMacro) {
            allItems.push({
              title,
              link: link.trim(),
              pubDate,
              impact: getImpact(text),
              source: 'MarketWatch',
            });
          }
        }
      } catch (e) {
        console.warn('RSS feed error:', feedUrl, e.message);
      }
    })
  );

  // Deduplicate by title
  const seen = new Set();
  const unique = allItems.filter(item => {
    const key = item.title.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by impact
  const order = { high: 0, med: 1, low: 2 };
  unique.sort((a, b) => order[a.impact] - order[b.impact]);

  // Cache 15 minutes
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(unique.slice(0, 10));
};
