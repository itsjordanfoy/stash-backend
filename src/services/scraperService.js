const axios = require('axios');
const cheerio = require('cheerio');
const ogs = require('open-graph-scraper');
const { logger } = require('../utils/logger');

// Multiple User-Agents to rotate through when a site blocks one
const USER_AGENTS = [
  // Desktop Chrome (primary — most widely accepted)
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Desktop Firefox
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  // Desktop Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  // Mobile Safari — many SPAs serve full SSR HTML to mobile UA for performance
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // Googlebot — most SPAs serve fully rendered HTML to crawlers for SEO
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
];

const TIMEOUT_MS = 12000;

/** Build realistic browser-like headers for a given User-Agent */
function browserHeaders(ua) {
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

// Maximum total time allowed across all UA retries for a single fetchPage call.
// Each individual request already has TIMEOUT_MS; this caps the whole retry loop.
const GLOBAL_FETCH_TIMEOUT_MS = 35000;

/**
 * Fetch a URL and return raw HTML + response headers.
 * Retries with different User-Agents if a 403 is returned.
 * A global deadline prevents the retry loop from running longer than GLOBAL_FETCH_TIMEOUT_MS.
 */
async function fetchPage(url) {
  const deadline = Date.now() + GLOBAL_FETCH_TIMEOUT_MS;

  for (let i = 0; i < USER_AGENTS.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.warn('fetchPage global timeout reached', { url, attempt: i });
      return null;
    }

    const ua = USER_AGENTS[i];
    try {
      const response = await axios.get(url, {
        headers: browserHeaders(ua),
        timeout: Math.min(TIMEOUT_MS, remaining),
        maxRedirects: 5,
        validateStatus: s => s < 500,
      });
      if (response.status === 403 || response.status === 429) {
        logger.debug(`fetchPage got ${response.status} with UA[${i}], retrying`, { url });
        continue;
      }
      if (response.status >= 400) {
        logger.warn('fetchPage non-OK status', { url, status: response.status });
        return null;
      }
      return { html: response.data, headers: response.headers, status: response.status };
    } catch (err) {
      logger.warn(`fetchPage failed (UA[${i}])`, { url, error: err.message });
      if (i === USER_AGENTS.length - 1) return null;
    }
  }
  return null;
}

/**
 * Extract OpenGraph and basic meta data from a URL.
 * Accepts optional pre-fetched HTML to avoid a second HTTP request.
 */
async function extractOpenGraph(url, prefetchedHtml = null) {
  try {
    // If we already have HTML use it directly; otherwise let ogs fetch (with our UA)
    const opts = prefetchedHtml
      ? { html: prefetchedHtml, url, timeout: TIMEOUT_MS }
      : { url, timeout: TIMEOUT_MS, fetchOptions: { headers: browserHeaders(USER_AGENTS[1]) } };
    const { result } = await ogs(opts);
    if (result.success) {
      return {
        title: result.ogTitle || result.twitterTitle,
        description: result.ogDescription || result.twitterDescription,
        image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url,
        site_name: result.ogSiteName,
        price: extractPriceFromOg(result),
        url: result.ogUrl || url,
      };
    }
    return null;
  } catch (err) {
    logger.debug('OG extraction failed', { url, error: err.message });
    return null;
  }
}

function extractPriceFromOg(ogResult) {
  const priceStr =
    ogResult['product:price:amount'] ||
    ogResult['og:price:amount'] ||
    ogResult.productPriceAmount;
  if (priceStr) {
    const num = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Parse product data from a product page using structured data + heuristics.
 */
function parseProductPage(html, url) {
  if (!html) return null;
  const $ = cheerio.load(html);

  // 1. Try JSON-LD structured data
  const jsonLdProduct = extractJsonLd($);
  if (jsonLdProduct) return jsonLdProduct;

  // 2. Heuristic extraction
  const imgs = extractImages($, url);
  return {
    name: extractTitle($),
    price: extractPrice($),
    currency: extractCurrency($, html),
    image_url: imgs[0] || null,
    images: imgs,
    description: extractDescription($),
    brand: extractBrand($),
  };
}

function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  let productData = null;
  const reviews = [];

  for (const script of scripts) {
    try {
      const data = JSON.parse($(script).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Extract Product schema
        if (!productData && (item['@type'] === 'Product' || item['@type']?.includes('Product'))) {
          const rawImgs = Array.isArray(item.image) ? item.image : (item.image ? [item.image] : []);
          const imgUrls = rawImgs.map(img => typeof img === 'string' ? img : img?.url || img?.contentUrl).filter(Boolean);
          productData = {
            name: item.name,
            brand: item.brand?.name || item.brand,
            description: item.description?.slice(0, 300),
            image_url: imgUrls[0] || null,
            images: imgUrls,
            price: extractJsonLdPrice(item),
            currency: extractJsonLdCurrency(item),
            sku: item.sku || item.mpn,
            gtin: item.gtin13 || item.gtin8 || item.gtin,
          };

          // Reviews embedded inside the Product schema
          const embeddedReviews = Array.isArray(item.review) ? item.review : (item.review ? [item.review] : []);
          for (const r of embeddedReviews) {
            const parsed = parseReviewItem(r);
            if (parsed) reviews.push(parsed);
          }
        }

        // Standalone Review schema objects
        if (item['@type'] === 'Review' || item['@type']?.includes('Review')) {
          const parsed = parseReviewItem(item);
          if (parsed) reviews.push(parsed);
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (!productData) return null;
  return { ...productData, reviews: reviews.slice(0, 5) };
}

function parseReviewItem(r) {
  const rating = r.reviewRating?.ratingValue
    ? parseFloat(r.reviewRating.ratingValue)
    : null;
  const text = r.reviewBody || r.description || null;
  const name = r.author?.name || r.author || null;
  if (!text && !rating) return null;
  return {
    reviewer_name: name,
    rating,
    title: r.name || null,
    text: text?.slice(0, 500) || null,
    date: r.datePublished || null,
    verified_purchase: false,
    images: [],
  };
}

function extractJsonLdPrice(item) {
  const offers = item.offers;
  if (!offers) return null;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  const price = offer?.price || offer?.lowPrice;
  return price ? parseFloat(price) : null;
}

function extractJsonLdCurrency(item) {
  const offers = item.offers;
  if (!offers) return 'GBP';
  const offer = Array.isArray(offers) ? offers[0] : offers;
  return offer?.priceCurrency || 'GBP';
}

function extractTitle($) {
  return (
    $('h1.product-title, h1.product__title, h1[itemprop="name"], h1').first().text().trim() ||
    $('title').text().split('|')[0].trim() ||
    null
  );
}

function extractPrice($) {
  const selectors = [
    '[itemprop="price"]',
    '.price__current',
    '.product-price',
    '.price',
    '[class*="price"]',
  ];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.attr('content') || el.text();
      const match = text.match(/[\d,]+\.?\d*/);
      if (match) return parseFloat(match[0].replace(',', ''));
    }
  }
  return null;
}

function extractCurrency($, html) {
  const meta = $('meta[itemprop="priceCurrency"]').attr('content');
  if (meta) return meta.toUpperCase();
  if (html.includes('£') || html.includes('GBP')) return 'GBP';
  if (html.includes('$') || html.includes('USD')) return 'USD';
  if (html.includes('€') || html.includes('EUR')) return 'EUR';
  return 'GBP';
}

function extractImages($, baseUrl) {
  const seen = new Set();
  const images = [];

  // Pick the highest-resolution URL from a srcset string
  function bestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null, bestW = 0;
    for (const part of srcset.split(',').map(s => s.trim()).filter(Boolean)) {
      const [url, descriptor] = part.split(/\s+/);
      if (!url) continue;
      const w = descriptor ? parseInt(descriptor) : 0;
      if (w > bestW || !best) { best = url; bestW = w; }
    }
    return best;
  }

  function add(url) {
    if (!url) return;
    try {
      let abs = url.startsWith('http') ? url : new URL(url, baseUrl).href;
      abs = abs.replace(/\{width\}/g, '800').replace(/\{height\}/g, '800');
      abs = abs.replace(/^http:\/\//i, 'https://');
      // Next.js image optimization: extract the real URL from /_next/image?url=...
      const nextImgMatch = abs.match(/\/_next\/image\?url=([^&]+)/);
      if (nextImgMatch) abs = decodeURIComponent(nextImgMatch[1]);
      if (!seen.has(abs) && !abs.includes('data:')) { seen.add(abs); images.push(abs); }
    } catch {}
  }

  // 1. JSON-LD product images (most reliable — often has full gallery)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product'))) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image];
          imgs.forEach(img => img && add(typeof img === 'string' ? img : img.url || img.contentUrl));
        }
      }
    } catch {}
  });

  // 2. Next.js __NEXT_DATA__ — embedded page props often contain product image arrays
  $('script#__NEXT_DATA__').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const json = JSON.stringify(data);
      // Extract any image-like URLs from the JSON blob
      const matches = json.match(/https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|avif)[^"]*/gi) || [];
      matches.forEach(u => {
        if (!u.includes('logo') && !u.includes('icon') && !u.includes('tracking')) add(u);
      });
    } catch {}
  });

  // 3. OG images
  $('meta[property="og:image"], meta[name="og:image"]').each((_, el) => add($(el).attr('content')));

  // 4. itemprop="image" and link[rel="image_src"]
  $('[itemprop="image"]').each((_, el) => add($(el).attr('content') || $(el).attr('src')));
  $('link[rel="image_src"]').each((_, el) => add($(el).attr('href')));

  // 5. Amazon data-a-dynamic-image (JSON object mapping url → [w, h])
  $('[data-a-dynamic-image]').each((_, el) => {
    try {
      const map = JSON.parse($(el).attr('data-a-dynamic-image'));
      // Pick the URL with the largest area
      const best = Object.entries(map).sort((a, b) => (b[1][0] * b[1][1]) - (a[1][0] * a[1][1]))[0];
      if (best) add(best[0]);
    } catch {}
  });

  // 6. Lightbox/zoom anchor hrefs (the <a> href is full-size, <img> inside is thumbnail)
  const lightboxSelectors = [
    'a[data-fancybox]', 'a[data-lightbox]', 'a[data-zoom-href]',
    'a.product-image-link', 'a[data-image]', 'a[href*="/products/"][href$=".jpg"]',
    'a[href*="/products/"][href$=".webp"]',
  ];
  lightboxSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const href = $(el).attr('href') || $(el).attr('data-zoom-href');
      if (href && /\.(jpg|jpeg|png|webp|avif)/i.test(href)) add(href);
    });
  });

  // 7. <picture> source srcsets (often highest-res option on modern sites)
  $('picture').each((_, picEl) => {
    $(picEl).find('source').each((_, src) => {
      const best = bestFromSrcset($(src).attr('srcset'));
      if (best) add(best);
    });
    // Also add the <img> fallback inside the <picture>
    const fallback = $(picEl).find('img').first();
    const src = fallback.attr('data-src') || fallback.attr('src');
    if (src) add(src);
  });

  // 8. Common product gallery selectors (Shopify, WooCommerce, Magento, generic)
  const gallerySelectors = [
    '.product__media img', '.product-images img', '.product-gallery img',
    '[data-product-media] img', '.product__photo img', '.product-image img',
    '.pdp-gallery img', '.product-detail__image img',
    '.product__media-item img', '.product-single__photo img',
    '[data-zoom-id] img', '.thumbnails img',
    '.woocommerce-product-gallery img', '.wp-post-image',
    'img[itemprop="image"]', '.gallery img', '[data-gallery] img',
  ];
  for (const sel of gallerySelectors) {
    $(sel).each((_, el) => {
      const src = $(el).attr('data-zoom-src')
        || $(el).attr('data-large-image')
        || $(el).attr('data-full-res')
        || bestFromSrcset($(el).attr('srcset'))
        || bestFromSrcset($(el).attr('data-srcset'))
        || $(el).attr('data-src')
        || $(el).attr('data-lazy-src')
        || $(el).attr('data-original')
        || $(el).attr('src');
      add(src);
    });
    if (images.length >= 8) break;
  }

  // 9. Any <img> with a product-like src pattern if still empty
  if (images.length === 0) {
    $('img').each((_, el) => {
      const src = $(el).attr('data-lazy-src') || $(el).attr('data-src')
        || $(el).attr('data-original') || $(el).attr('src');
      if (!src) return;
      const lower = src.toLowerCase();
      if (lower.includes('logo') || lower.includes('icon') || lower.includes('pixel')
        || lower.includes('tracking') || lower.endsWith('.svg') || lower.includes('1x1')) return;
      if (/_(?:small|thumb|50x|100x|150x)\b/.test(lower)) return;
      add(src);
    });
  }

  return images.slice(0, 12);
}

// Keep a single-image helper for backwards compatibility
function extractImage($, baseUrl) {
  return extractImages($, baseUrl)[0] || null;
}

function extractDescription($) {
  const og = $('meta[property="og:description"]').attr('content');
  if (og) return og.slice(0, 300);
  const meta = $('meta[name="description"]').attr('content');
  if (meta) return meta.slice(0, 300);
  return null;
}

function extractBrand($) {
  const meta = $('meta[property="og:brand"]').attr('content');
  if (meta) return meta;
  const itemprop = $('[itemprop="brand"] [itemprop="name"], [itemprop="brand"]').first();
  if (itemprop.length) return itemprop.text().trim() || itemprop.attr('content');
  return null;
}

/**
 * Detect what type of page/source a URL is from.
 */
function detectSourceType(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('instagram.com')) return 'instagram';
    if (hostname.includes('tiktok.com')) return 'tiktok';
    if (hostname.includes('pinterest.com') || hostname.includes('pinterest.co.uk')) return 'pinterest';
    return 'link';
  } catch {
    return 'link';
  }
}

/**
 * Attempt to extract a product price from a retailer page.
 * Returns { price, currency, in_stock } or null.
 */
async function scrapeRetailerPrice(productUrl) {
  try {
    const result = await fetchPage(productUrl);
    if (!result) return null;

    const $ = cheerio.load(result.html);
    const price = extractPrice($);
    const currency = extractCurrency($, result.html);

    // Basic in-stock detection
    const html = result.html.toLowerCase();
    const outOfStockSignals = ['out of stock', 'sold out', 'unavailable', 'out-of-stock'];
    const in_stock = !outOfStockSignals.some(s => html.includes(s));

    // Extract the page title for product-match verification
    const pageTitle = extractPageTitle($);

    return price ? { price, currency, in_stock, pageTitle } : null;
  } catch (err) {
    logger.warn('scrapeRetailerPrice failed', { productUrl, error: err.message });
    return null;
  }
}

/**
 * Extract the most reliable product title from a page.
 * Prefers JSON-LD product name, then <h1>, then <title>.
 */
function extractPageTitle($) {
  // JSON-LD product name (most reliable)
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    try {
      const data = JSON.parse($(script).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if ((item['@type'] === 'Product' || String(item['@type']).includes('Product')) && item.name) {
          return item.name;
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback: first <h1>
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;
  // Fallback: <title> (strip " | Retailer Name" suffix)
  const title = $('title').text().trim().split(/[|\-–]/)[0].trim();
  return title || null;
}

/**
 * Check whether a scraped page title represents the same product.
 *
 * Rules (in order):
 *  1. Model codes (alphanumeric tokens with both letters AND digits, 4+ chars) — ALL must
 *     appear in the page title. If any is missing → not the same product.
 *  2. No model code → keyword matching. The product name's significant words must appear
 *     in the title at ≥ 60 % rate AND the brand (if known) must appear at ≥ 50 %.
 */
function isSameProduct(productName, productBrand, pageTitle) {
  if (!pageTitle) return false;

  const norm = s => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titleNorm = norm(pageTitle);

  // --- 1. Model code matching ---
  // Any token containing BOTH letters and digits counts as a model code (e.g. Q3, M11,
  // SL2, RF540N4WFE, A18). Minimum length is 2 so short camera/product codes are caught.
  // ALL model codes must appear in the page title — if any is missing it's a different product.
  const modelCodes = (productName || '').match(/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{2,}\b/gi) || [];
  if (modelCodes.length > 0) {
    return modelCodes.every(code => titleNorm.includes(norm(code)));
  }

  // --- 2. Keyword matching (no model codes in the name, e.g. "Long Sleeve Rally Tee") ---
  // Strip common stop-words; every remaining significant word must appear in the title.
  const stopWords = new Set(['the', 'and', 'for', 'with', 'in', 'of', 'a', 'an', 'to', 'by', 'from']);
  const nameTokens = norm(productName || '').split(' ').filter(t => t.length >= 3 && !stopWords.has(t));
  if (nameTokens.length === 0) return true; // nothing to check

  // Require ALL name tokens to match — a partial brand-only match is not enough
  const allNameTokensMatch = nameTokens.every(t => titleNorm.includes(t));
  if (!allNameTokensMatch) return false;

  // Brand must also appear (at least half its tokens) to prevent same-name cross-brand matches
  if (productBrand) {
    const brandTokens = norm(productBrand).split(' ').filter(t => t.length >= 3);
    if (brandTokens.length > 0) {
      const brandMatchRatio = brandTokens.filter(t => titleNorm.includes(t)).length / brandTokens.length;
      if (brandMatchRatio < 0.5) return false;
    }
  }

  return true;
}

/**
 * Last-resort OG image fetch — cycles through all UAs including Googlebot.
 * Used when normal scraping + AI extraction both failed to find an image.
 */
async function fetchOGImage(url) {
  for (const ua of USER_AGENTS) {
    try {
      const result = await ogs({
        url,
        fetchOptions: { headers: { 'User-Agent': ua }, timeout: 8000 },
        onlyGetOpenGraphInfo: true,
      });
      const img = result?.result?.ogImage?.[0]?.url || result?.result?.twitterImage?.[0]?.url;
      if (img) {
        logger.debug('fetchOGImage fallback found image', { url, ua: ua.slice(0, 40) });
        return img.startsWith('http') ? img : new URL(img, url).href;
      }
    } catch {
      // try next UA
    }
  }
  return null;
}

/**
 * Try to fetch extra images from platform-specific JSON APIs.
 * Returns an array of absolute image URL strings, or [] if not applicable.
 *
 * Currently handles:
 *  - Squarespace: appending ?format=json returns full item.items[] with assetUrl
 */
async function fetchPlatformImages(url) {
  const headers = { ...browserHeaders(USER_AGENTS[0]), Accept: 'application/json, text/javascript, */*' };

  // Squarespace: ?format=json returns full item.items[] with assetUrl
  try {
    const r = await axios.get(url + (url.includes('?') ? '&' : '?') + 'format=json', {
      headers, timeout: TIMEOUT_MS, validateStatus: s => s < 500,
    });
    if (r.status === 200 && r.data?.item?.items) {
      return r.data.item.items
        .map(i => i.assetUrl).filter(Boolean)
        .map(u => u.replace(/^http:\/\//i, 'https://'));
    }
  } catch {}

  // Shopify: product_url + '.js' returns JSON with images[] array
  try {
    const shopifyUrl = url.replace(/\?.*$/, '').replace(/\/$/, '') + '.js';
    const r = await axios.get(shopifyUrl, {
      headers, timeout: TIMEOUT_MS, validateStatus: s => s < 500,
    });
    if (r.status === 200 && Array.isArray(r.data?.images)) {
      return r.data.images
        .map(img => typeof img === 'string' ? img : img?.src)
        .filter(Boolean)
        .map(u => u.replace(/^http:\/\//i, 'https://').replace(/\{width\}/g, '800'));
    }
  } catch {}

  return [];
}

/**
 * SCREENSHOT-API FALLBACK
 * ───────────────────────
 * Last-resort tool for URLs we can't scrape (bot-blocked, JS-rendered, etc.)
 * and can't identify from world knowledge. Uses ScreenshotOne to render the
 * page server-side and returns a base64 PNG the AI vision pipeline can read.
 *
 * Configure with SCREENSHOT_API_KEY (from screenshotone.com). If no key is
 * set, this function returns null immediately so the pipeline falls through
 * to the existing failure message.
 *
 * Docs: https://screenshotone.com/docs/
 */
async function captureScreenshot(url) {
  const apiKey = process.env.SCREENSHOT_API_KEY;
  if (!apiKey) {
    logger.debug('captureScreenshot skipped — no SCREENSHOT_API_KEY');
    return null;
  }

  try {
    const params = new URLSearchParams({
      access_key: apiKey,
      url,
      format: 'png',
      viewport_width: '1280',
      viewport_height: '1600',
      full_page: 'false',
      block_cookie_banners: 'true',
      block_ads: 'true',
      block_banners_by_heuristics: 'true',
      device_scale_factor: '1',
      image_quality: '80',
      cache: 'true',
      cache_ttl: '2592000', // 30 days — same page = same screenshot
      response_type: 'by_format',
      timeout: '30',
    });

    const apiUrl = `https://api.screenshotone.com/take?${params.toString()}`;
    logger.info('Capturing screenshot', { url });

    const r = await axios.get(apiUrl, {
      responseType: 'arraybuffer',
      timeout: 45000,
      validateStatus: s => s < 500,
    });

    if (r.status !== 200) {
      logger.warn('ScreenshotOne returned non-200', {
        url,
        status: r.status,
        body: Buffer.from(r.data).toString('utf8').slice(0, 200),
      });
      return null;
    }

    const base64 = Buffer.from(r.data).toString('base64');
    logger.info('Screenshot captured', { url, bytes: r.data.length });
    return { base64, mimeType: 'image/png' };
  } catch (err) {
    logger.warn('Screenshot capture failed', { url, error: err.message });
    return null;
  }
}

module.exports = {
  fetchPage,
  extractOpenGraph,
  parseProductPage,
  fetchOGImage,
  extractImages,
  fetchPlatformImages,
  detectSourceType,
  scrapeRetailerPrice,
  isSameProduct,
  captureScreenshot,
};
