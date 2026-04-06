require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });
const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const headers = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function firstProductUrl(label, searchUrl, linkPattern, baseUrl) {
  try {
    const res = await axios.get(searchUrl, { headers, timeout: 8000, maxRedirects: 3 });
    const $ = cheerio.load(res.data);
    const seen = new Set();
    const links = [];
    $('a[href]').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href.startsWith('http')) href = baseUrl + href;
      if (linkPattern.test(href) && !seen.has(href)) { seen.add(href); links.push(href); }
    });
    console.log(label + ':', res.status, links[0] || 'no match');
  } catch (e) { console.log(label + ': ERROR', e.message); }
}

(async () => {
  const query = 'Bang Olufsen BeoGrace';
  await firstProductUrl('Amazon', `https://www.amazon.co.uk/s?k=${encodeURIComponent(query)}`, /amazon\.co\.uk.*\/dp\/[A-Z0-9]{10}/, 'https://www.amazon.co.uk');
  await firstProductUrl('JohnLewis', `https://www.johnlewis.com/search?search-term=${encodeURIComponent(query)}`, /johnlewis\.com\/[^"]+\/p\d+/, 'https://www.johnlewis.com');
  process.exit(0);
})();
