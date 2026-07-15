// api/news.js — Multi-source RSS aggregator with category detection

const FEEDS = [
  // Macro / Breaking
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',      cat: 'macro' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',     cat: 'macro' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',cat: 'macro'},
  // Equities / Markets
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', cat: 'equities' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147',  cat: 'macro' },
  // Crypto
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', cat: 'crypto' },
  { url: 'https://cointelegraph.com/rss', cat: 'crypto' },
  // Forex / FX
  { url: 'https://rss.fxstreet.com/news', cat: 'forex' },
];

const CATEGORY_OVERRIDES = {
  geopolitics: ['iran','hormuz','war','military','sanction','geopolit','conflict','israel','russia','ukraine','china','taiwan','north korea','opec','coup','nato'],
  energy:      ['oil','crude','wti','brent','energy','opec','pipeline','gas price','natural gas','petroleum','refinery'],
  macro:       ['federal reserve','fed ','rate hike','rate cut','repo crisis','default','systemic','quantitative','bank failure','recession','gdp','treasury','inflation','yield','liquidity','fomc','powell','balance sheet','debt ceiling','tga','sofr','reserves'],
  forex:       ['dxy','dollar index','eurusd','eur/usd','gbpusd','usd/jpy','yuan','renminbi','cny','peso','currency','forex','fx ','exchange rate','yen','emerging market'],
  daytrading:  ['intraday','day trading','scalp','breakout','technical analysis','support resistance','chart pattern','momentum','vwap'],
  swingtrading:['swing trade','weekly','position trade','trend following','etf rotation','sector rotation','relative strength'],
  crypto:      ['bitcoin','btc','ethereum','eth','crypto','blockchain','defi','nft','altcoin','solana','digital asset','stablecoin','coinbase','binance'],
};

// Sectores afectados (etiquetas en español para el panel de la Terminal) — keyword match
// sobre title+desc en minúsculas. Un titular puede tocar hasta 2 sectores.
const SECTOR_MAP = {
  'tecnologia':      ['apple','microsoft','google','alphabet','meta ','amazon','tech stock','software','cloud','artificial intelligence',' ai ','openai','anthropic','big tech','saas'],
  'semiconductores': ['nvidia','amd','intel','semiconductor','chip','tsmc','asml','micron','qualcomm','broadcom','foundry'],
  'energia':         ['oil','crude','wti','brent','opec','natural gas','exxon','chevron','pipeline','refinery','petroleum','energy price'],
  'financiero':      ['bank','jpmorgan','goldman','citigroup','wells fargo','morgan stanley','lending','insurance','credit card','brokerage','private credit'],
  'salud':           ['pharma','drug','fda','biotech','healthcare','pfizer','moderna','merck','eli lilly','novo nordisk','medicare','vaccine'],
  'consumo':         ['retail','consumer','walmart','target','costco','starbucks','nike','mcdonald','amazon prime','e-commerce','holiday sales'],
  'industriales':    ['boeing','airline','manufacturing','factory','industrial','caterpillar','defense','lockheed','shipping','freight','tariff'],
  'autos':           ['tesla','ford','general motors','rivian','electric vehicle',' ev ','automaker','car sales'],
  'inmobiliario':    ['housing','real estate','mortgage','reit','home sales','homebuilder','commercial property'],
  'cripto':          ['bitcoin','btc','ethereum','eth','crypto','blockchain','defi','altcoin','solana','stablecoin','coinbase','binance','digital asset'],
  'divisas':         ['dollar index','dxy','eurusd','eur/usd','gbpusd','usd/jpy','yen','yuan','renminbi','currency','forex','exchange rate','peso','emerging market'],
  'metales':         ['gold','silver','copper','platinum','mining','precious metal'],
  'indices/macro':   ['federal reserve','fed ','fomc','powell','cpi','inflation','treasury','yield','gdp','jobs report','nfp','payrolls','recession','s&p','nasdaq','dow jones','futures','vix','rate hike','rate cut'],
};

function getSectors(text) {
  const hits = [];
  for (const [sec, keywords] of Object.entries(SECTOR_MAP)) {
    if (keywords.some(k => text.includes(k))) hits.push(sec);
    if (hits.length >= 2) break;
  }
  return hits;
}

const HIGH_IMPACT = ['federal reserve','rate hike','rate cut','iran','hormuz','repo crisis',
  'default','emergency','systemic','fed pivot','quantitative','bank failure','fomc',
  'liquidity crisis','credit event','systemic risk','war','military strike'];

const MED_IMPACT = ['inflation','treasury','oil price','crude','gold','pboc','recession',
  'yield curve','tariff','powell','fed funds','liquidity','gdp','jobs report','cpi','nfp'];

const MACRO_KEYWORDS = [...HIGH_IMPACT, ...MED_IMPACT,
  'fed','dxy','dollar','spreads','credit','bonds','debt','bitcoin','crypto',
  'breakout','swing','etf','nasdaq','s&p','futures','volatility','vix','sector'];

function getImpact(text) {
  if (HIGH_IMPACT.some(k => text.includes(k))) return 'high';
  if (MED_IMPACT.some(k => text.includes(k)))  return 'med';
  return 'low';
}

function getCategory(text, feedCat) {
  for (const [cat, keywords] of Object.entries(CATEGORY_OVERRIDES)) {
    if (keywords.some(k => text.includes(k))) return cat;
  }
  return feedCat;
}

function extractCdata(xml, tag) {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, 's'));
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 's'));
  return plainMatch ? plainMatch[1].trim() : '';
}

function extractLink(block) {
  // Try CDATA link first
  // FIX 2026-07-08: el regex tenía doble escape (\\[ en un regex literal = backslash literal)
  // → nunca matcheaba y ~10 de 37 noticias quedaban con link '#'
  const cd = block.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/s);
  if (cd) return cd[1].trim();
  // Atom-style link
  const atom = block.match(/<link[^>]+href=["']([^"']+)["']/);
  if (atom) return atom[1].trim();
  // Plain text link
  const plain = block.match(/<link>(https?:\/\/[^<]+)<\/link>/s);
  if (plain) return plain[1].trim();
  return '#';
}

function decodeHtml(str) {
  // Decode COMPLETO (fix 2026-07-08): entities numéricas (&#x2019;) y &apos; quedaban
  // sin decodificar; el frontend ahora escapa innerHTML → se veían literales.
  // Orden: strip tags → numéricas → nombradas → &amp; al final (estándar).
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; } })
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function getSource(feedUrl) {
  if (feedUrl.includes('dowjones'))    return 'MarketWatch';
  if (feedUrl.includes('cnbc'))        return 'CNBC';
  if (feedUrl.includes('coindesk'))    return 'CoinDesk';
  if (feedUrl.includes('cointelegraph')) return 'CoinTelegraph';
  if (feedUrl.includes('fxstreet'))    return 'FXStreet';
  return 'News';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const allItems = [];

  await Promise.allSettled(
    FEEDS.map(async ({ url: feedUrl, cat: feedCat }) => {
      try {
        const response = await fetch(feedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MacroBot/1.0)',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) { console.warn('RSS feed error:', feedUrl, response.status); return; }

        const xml = await response.text();
        const itemBlocks = xml.split(/<item[\s>]/i).slice(1);

        for (const block of itemBlocks.slice(0, 10)) {
          const title   = decodeHtml(extractCdata(block, 'title'));
          const link    = extractLink(block);
          const pubDate = extractCdata(block, 'pubDate');
          const desc    = decodeHtml(extractCdata(block, 'description')).slice(0, 300);

          if (!title) continue;

          const text = (title + ' ' + desc).toLowerCase();
          const isMacro = MACRO_KEYWORDS.some(kw => text.includes(kw));
          if (!isMacro && feedCat !== 'crypto' && feedCat !== 'forex') continue;

          allItems.push({
            title,
            link: link.trim(),
            pubDate,
            impact:   getImpact(text),
            category: getCategory(text, feedCat),
            sectors:  getSectors(text), // clave aditiva — tab 07 la ignora, la Terminal la pinta
            source:   getSource(feedUrl),
          });
        }
      } catch (e) {
        console.warn('RSS feed error:', feedUrl, e.message);
      }
    })
  );

  // Deduplicate by title prefix
  const seen = new Set();
  const unique = allItems.filter(item => {
    const key = item.title.slice(0, 55).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: high impact first; dentro del mismo grado, lo más reciente arriba
  const order = { high: 0, med: 1, low: 2 };
  unique.sort((a, b) => (order[a.impact] - order[b.impact]) || (new Date(b.pubDate || 0) - new Date(a.pubDate || 0)));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=180');
  return res.status(200).json(unique.slice(0, 48));
};
