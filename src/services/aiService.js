const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('../utils/logger');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-haiku-4-5';

/**
 * Strip markdown code fences and parse JSON.
 * Claude sometimes wraps output in ```json ... ``` despite being told not to.
 */
function parseJSON(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(stripped);
}

/**
 * Retry a Claude API call on 529 overloaded errors.
 * Uses exponential backoff: 2s, 4s, 8s.
 */
async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isOverloaded = err?.status === 529 ||
        err?.message?.includes('overloaded') ||
        err?.message?.includes('529');

      if (!isOverloaded || attempt === maxAttempts) {
        // Sanitise overloaded error message so users don't see raw JSON
        if (isOverloaded) {
          const friendly = new Error('Service temporarily busy. Please try again in a moment.');
          friendly.isOverloaded = true;
          throw friendly;
        }
        throw err;
      }

      const delayMs = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      logger.warn(`Claude API overloaded (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Analyse a URL (or HTML/OG data) and extract structured product information.
 */
async function extractProductFromUrl(url, htmlContent = null, ogData = null, categoryHint = null) {
  const context = [
    ogData ? `OpenGraph data: ${JSON.stringify(ogData)}` : null,
    htmlContent ? `Page HTML excerpt (first 8000 chars): ${htmlContent.slice(0, 8000)}` : null,
    `URL: ${url}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const categoryInstruction = categoryHint
    ? `\n\nIMPORTANT: The user has confirmed this is a "${categoryHint}". Set the category and item_type accordingly and make sure to extract all fields specific to this type (e.g. ingredients/steps/cook_time for recipes, tracklist/record_label for music, isbn/publisher/page_count for books, etc.).`
    : '';

  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 1024,

    system: `You are a universal content extraction specialist. Extract structured information from any web page — products, events, concerts, tickets, places, restaurants, movies, music, recipes, courses, podcasts, YouTube videos, TikTok videos, Instagram posts, video games, wine, articles, apps, or anything else worth saving. Always return valid JSON.`,
    messages: [
      {
        role: 'user',
        content: `Extract information from this web page and return a JSON object. Use the item_type that best fits:${categoryInstruction}
{
  "name": "SHORT name — max 50 chars, punchy and specific. For articles/blogs rewrite the headline into a concise memorable title (e.g. 'Victorian House Extension Masterclass' not the full article title). For social posts extract the actual subject (restaurant name, product, place). Never include the site name, author, username, or source platform in the name.",
  "item_type": "product" | "place" | "entertainment" | "event" | "general" | "course" | "podcast" | "youtube_video" | "video_game" | "wine" | "article" | "app",
  "brand": "brand or publisher (products/books only, else null)",
  "description": "brief description (max 200 chars)",
  "category": "category or genre",
  "price": number or null,
  "currency": "GBP" or "USD" etc,
  "image_url": "primary image URL",
  "retailer_name": "site or venue name",
  "address": "full address (places/events, else null)",
  "google_maps_url": "Google Maps URL if present, else null",
  "release_year": year as integer or null,
  "genre": "genre (entertainment/music, else null)",
  "artist_or_director": "artist, band, director, or creator name (else null)",
  "streaming_platforms": ["Netflix", "Spotify"] or null,
  "event_date": "ISO8601 datetime string or null",
  "event_venue": "venue name (events, else null)",
  "ticket_url": "direct ticket purchase URL or null",
  "ingredients": ["ingredient 1", "ingredient 2"] or null,
  "steps": ["step 1", "step 2"] or null,
  "cta_label": "primary action label e.g. 'Book Tickets', 'Watch Now', 'Listen', 'Get Directions' (else null)",
  "cta_url": "primary action URL (else null)",
  "isbn": "ISBN for books (else null)",
  "platform": "platform for games/apps/courses e.g. 'PlayStation 5', 'iOS', 'Udemy' (else null)",

  "runtime": "runtime in SHORT format ONLY e.g. '2h 15m', '45m', '1h 30m' — never spell out 'hours' or 'minutes' (movies/TV/YouTube/podcasts, else null)",
  "content_rating": "SHORT rating code only e.g. 'PG', '12A', 'R', 'U', 'PEGI 18', 'M' — max 10 chars (movies/TV/games, else null)",
  "cast_members": ["Actor Name", "Actor Name"] up to 6 main cast members (movies/TV only, else null),
  "trailer_url": "YouTube or Apple TV trailer URL if present on the page, else null",
  "imdb_score": "IMDb score SHORT format e.g. '8.3' or '8.3/10' — do NOT include vote counts (movies/TV only, else null)",
  "rotten_tomatoes_score": "Rotten Tomatoes critic score as integer 0-100 (movies/TV only, else null)",
  "awards": ["Award Name 1", "Award Name 2"] array of notable awards won e.g. "Academy Award Winner", "Palme d'Or", "Booker Prize", "Pulitzer Prize" (movies/TV/books only, else null),
  "streaming_links": {"Netflix": "https://...", "Disney+": "https://..."} object mapping streaming service name to direct URL (movies/TV only, else null),
  "cast_with_photos": [{"name": "Actor Name", "photo_url": "https://..."}] up to 6 main cast with photo URLs if visible on page (movies/TV only, else null),

  "page_count": number of pages as integer (books only, else null),
  "publisher": "publisher name (books only, else null)",
  "edition": "edition description e.g. 'Paperback', 'Hardcover', '2nd Edition' (books only, else null)",
  "goodreads_url": "Goodreads book page URL if present on the page, else null",
  "book_editions": [{"format": "Hardcover", "price": 24.99, "currency": "GBP"}] array of available editions/formats with prices (books only, else null),
  "book_awards": ["Booker Prize 2023", "Pulitzer Prize"] array of awards (books only, else null),

  "tracklist": ["Track Title 1", "Track Title 2"] array of track titles (music/albums only, else null),
  "record_label": "record label name (music only, else null)",
  "pressing_info": "pressing/edition details for vinyl e.g. 'Original UK pressing, 1973' (vinyl only, else null)",
  "condition": "condition description for second-hand items e.g. 'Mint', 'Very Good Plus', 'Good' (second-hand only, else null)",
  "tour_dates": [{"date": "2026-05-15", "venue": "O2 Arena", "city": "London", "ticket_url": "https://..."}] upcoming tour dates (music/artists only, else null),
  "spotify_url": "direct Spotify album/artist URL if present on page (music only, else null)",
  "apple_music_url": "direct Apple Music album/artist URL if present on page (music only, else null)",

  "specs": {"Key": "Value"} object of up to 8 important technical specifications (electronics/general products, else null),

  "latitude": numeric latitude (places only, else null),
  "longitude": numeric longitude (places only, else null),
  "opening_hours": {"Mon": "9am-5pm", "Tue": "9am-5pm"} object mapping day names to hours (places only, else null),
  "reservation_url": "OpenTable, Resy, or direct booking URL (places only, else null)",
  "price_range": 1, 2, 3, or 4 representing £/££/£££/££££ (places only, else null),
  "menu_url": "direct link to menu page (restaurants/cafes only, else null)",
  "phone": "phone number as string e.g. '+44 20 7946 0958' (places only, else null)",
  "rating": "average user/critic rating as decimal e.g. 4.2 (places only, else null)",
  "review_count": "number of reviews as integer e.g. 1842 (places only, else null)",

  "servings": number of servings as integer (recipes only, else null),
  "cook_time": "total cooking time as string e.g. '45 minutes', '1 hour 20 minutes' (recipes only, else null)",
  "weather_forecast": null,
  "nutrition": {"calories": 450, "protein": 22, "carbs": 38, "fat": 18} per-serving nutrition (recipes only, else null),
  "difficulty": "Easy" or "Medium" or "Hard" (recipes/courses only, else null),

  // COURSE (item_type: "course") — use platform for provider e.g. "Udemy", "Coursera"
  "course_instructor": "instructor name (courses only, else null)",
  "course_duration_hours": total hours as float e.g. 12.5 (courses only, else null),
  "course_modules_count": number of modules/sections as integer (courses only, else null),
  "certificate_available": true or false (courses only, else null),

  // PODCAST (item_type: "podcast") — use artist_or_director for host name(s)
  "podcast_network": "network or production company (podcasts only, else null)",
  "episode_count": total episodes as integer (podcasts only, else null),
  "latest_episode_title": "title of most recent episode (podcasts only, else null)",

  // YOUTUBE VIDEO (item_type: "youtube_video") — use artist_or_director for channel name, runtime for duration
  "channel_url": "full URL to YouTube channel (YouTube only, else null)",
  "view_count": view count as integer (YouTube/TikTok only, else null),
  "published_date": "ISO date YYYY-MM-DD (YouTube/TikTok/Instagram/articles, else null)",

  // TIKTOK VIDEO (item_type: "youtube_video") — treat like a video: use artist_or_director for creator @handle, description for caption, image_url for thumbnail, view_count for views
  // INSTAGRAM POST (item_type: "entertainment") — extract the ACTUAL SUBJECT as the name (e.g. restaurant name, product name, place name shown in the caption/image). Do NOT use the Instagram OG title format ("X on Instagram: 'caption...'"). Use artist_or_director for the creator's @handle, description for a clean 1-sentence caption summary, image_url for post image. If the post is clearly showcasing a specific purchasable product, use item_type: "product" instead. If it's about a place/restaurant, use item_type: "place" and fill in address/location fields if visible.

  // VIDEO GAME (item_type: "video_game") — use platform for primary platform, publisher for publisher, genre for genre, content_rating for ESRB/PEGI
  "game_platforms": ["PS5", "Xbox Series X", "PC"] array of all platforms (games only, else null),
  "metacritic_score": Metacritic score as integer 0-100 (games only, else null),
  "playtime_estimate": "estimated playtime e.g. '40-60 hours' (games only, else null)",
  "studio": "development studio name (games only, else null)",

  // WINE / SPIRITS (item_type: "wine") — use genre for type (red/white/rosé/whisky), release_year for vintage, brand for winery/producer
  "wine_region": "region or appellation e.g. 'Bordeaux', 'Napa Valley' (wine only, else null)",
  "grape_variety": "grape variety or main ingredient e.g. 'Cabernet Sauvignon' (wine only, else null)",
  "abv": ABV percentage as float e.g. 13.5 (wine only, else null),
  "tasting_notes": "tasting notes as a single string (wine only, else null)",
  "food_pairing": ["Lamb", "Hard cheese"] array of food pairing suggestions (wine only, else null),

  // ARTICLE / ESSAY (item_type: "article") — use artist_or_director for author, published_date for publish date
  "publication_name": "publication or website name (articles only, else null)",
  "read_time_minutes": estimated reading time in minutes as integer (articles only, else null),
  "word_count": approximate word count as integer (articles only, else null),
  "article_tags": ["Tech", "AI"] array of topic tags (articles only, else null),

  // APP (item_type: "app") — use brand for developer, platform for platform (iOS/Mac/Web/Android)
  "pricing_model": "free" or "paid" or "subscription" (apps only, else null),
  "app_store_url": "App Store or Google Play URL (apps only, else null)",

  // REVIEWS — extract up to 5 representative customer/critic reviews if visible on the page.
  // Include reviews with photos when image URLs are present in the HTML.
  "reviews": [
    {
      "reviewer_name": "display name or null",
      "rating": star rating as float 1.0-5.0 or null,
      "title": "review headline or null",
      "text": "review body text (max 300 chars) or null",
      "date": "ISO date YYYY-MM-DD or null",
      "verified_purchase": true or false,
      "images": ["https://...", "https://..."] or []
    }
  ] or null,
  "app_category": "App Store category e.g. 'Productivity' (apps only, else null)",
  "app_version": "current version string e.g. '3.2.1' (apps only, else null)",

  // DYNAMIC PAGE LAYOUT — only for item_type "general" when the item is truly novel and doesn't fit a standard category.
  // Groups entries from the "specs" object above into named, themed sections for display.
  // Each key in "keys" MUST be a key that exists in the "specs" object above.
  // Use 1-3 sections with 2-4 keys each. Choose SF Symbol names that clearly match the section theme.
  // For all other item types, set this to null.
  "display_config": {
    "sections": [
      {
        "title": "Section title e.g. 'At a Glance', 'Dimensions', 'Materials'",
        "icon": "SF Symbol name e.g. 'info.circle', 'ruler', 'square.grid.2x2'",
        "keys": ["Spec Key 1", "Spec Key 2"]
      }
    ]
  },

  "confidence": 0.0-1.0
}

Set confidence to 0.8 or higher for any clearly identifiable content — not just products. A concert, restaurant, film, recipe, course, podcast, video game, or article is just as valid as a product.
Return ONLY the JSON object, no markdown.

${context}`,
      },
    ],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '{}';

  try {
    return parseJSON(text);
  } catch {
    logger.warn('Failed to parse AI content extraction response', { text });
    return { confidence: 0 };
  }
}

/**
 * Analyse a screenshot (base64) and extract product information using vision.
 */
async function analyzeScreenshot(imageBase64, mimeType = 'image/png') {
  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 1024,

    system: `You are a universal content identification specialist with vision capabilities. Analyse screenshots to identify any kind of content — products, events, recipes, places, entertainment, courses, podcasts, videos, games, wine, articles, apps, and more.`,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: imageBase64 },
          },
          {
            type: 'text',
            text: `Analyse this screenshot and extract information. Return a JSON object:
{
  "name": "SHORT name — max 50 chars, punchy and specific. For articles rewrite the headline into a concise title. Never include the site name, author, or source platform.",
  "item_type": "product" | "place" | "entertainment" | "event" | "general" | "course" | "podcast" | "youtube_video" | "video_game" | "wine" | "article" | "app",
  "brand": "brand or publisher (products only, else null)",
  "description": "brief description",
  "category": "category or genre",
  "price": number or null,
  "currency": "GBP" or "USD" etc,
  "ocr_text": "all visible text extracted from image",
  "image_url": null,
  "address": "address if visible, else null",
  "release_year": year as integer or null,
  "genre": "genre if visible, else null",
  "artist_or_director": "artist, band, director, or creator if visible, else null",
  "streaming_platforms": ["platform"] or null,
  "event_date": "ISO8601 datetime or null",
  "event_venue": "venue name or null",
  "ticket_url": null,
  "ingredients": ["ingredient 1"] or null,
  "steps": ["step 1"] or null,
  "cta_label": "primary action label e.g. 'Book Tickets', 'Watch Now' or null",
  "cta_url": null,
  "isbn": "ISBN for books (else null)",
  "platform": "platform for games/apps/courses e.g. 'PlayStation 5', 'iOS', 'Udemy' (else null)",

  "runtime": "runtime SHORT format ONLY e.g. '2h 15m', '45m' — never spell out 'hours' or 'minutes' (movies/TV/YouTube/podcasts, else null)",
  "content_rating": "SHORT rating code only e.g. 'PG', '12A', 'R', 'PEGI 18', 'M' — max 10 chars (movies/TV/games, else null)",
  "cast_members": ["Actor Name"] up to 6 main cast members if visible (movies/TV only, else null),
  "trailer_url": null,
  "imdb_score": "IMDb score SHORT e.g. '8.3' or '8.3/10' — no vote counts (movies/TV only, else null)",
  "rotten_tomatoes_score": "Rotten Tomatoes critic score as integer 0-100 if visible (movies/TV only, else null)",
  "awards": ["Award Name 1"] array of notable awards won if visible (movies/TV/books only, else null),
  "streaming_links": null,
  "cast_with_photos": null,

  "page_count": number of pages as integer if visible (books only, else null),
  "publisher": "publisher name if visible (books only, else null)",
  "edition": "edition description if visible e.g. 'Paperback', 'Hardcover', '2nd Edition' (books only, else null)",
  "goodreads_url": null,
  "book_editions": [{"format": "Hardcover", "price": 24.99, "currency": "GBP"}] array of visible editions/formats with prices (books only, else null),
  "book_awards": ["Booker Prize 2023"] array of awards if visible (books only, else null),

  "tracklist": ["Track Title 1"] array of track titles if visible (music/albums only, else null),
  "record_label": "record label name if visible (music only, else null)",
  "pressing_info": "pressing/edition details if visible (vinyl only, else null)",
  "condition": "condition description if visible e.g. 'Mint', 'Very Good Plus', 'Good' (second-hand only, else null)",
  "tour_dates": null,
  "spotify_url": null,
  "apple_music_url": null,

  "specs": {"Key": "Value"} object of up to 8 visible technical specifications (electronics/general products, else null),

  "latitude": null,
  "longitude": null,
  "opening_hours": {"Mon": "9am-5pm"} object of visible opening hours (places only, else null),
  "reservation_url": null,
  "price_range": 1, 2, 3, or 4 representing £/££/£££/££££ if visible (places only, else null),
  "menu_url": null,

  "servings": number of servings as integer if visible (recipes only, else null),
  "cook_time": "total cooking time as string if visible e.g. '45 minutes' (recipes only, else null)",
  "weather_forecast": null,
  "nutrition": {"calories": 450, "protein": 22, "carbs": 38, "fat": 18} per-serving nutrition if visible (recipes only, else null),
  "difficulty": "Easy" or "Medium" or "Hard" if visible (recipes/courses only, else null),

  "course_instructor": "instructor name if visible (courses only, else null)",
  "course_duration_hours": hours as float if visible (courses only, else null),
  "course_modules_count": number of modules if visible (courses only, else null),
  "certificate_available": true or false if visible (courses only, else null),
  "podcast_network": "network name if visible (podcasts only, else null)",
  "episode_count": total episodes if visible (podcasts only, else null)",
  "latest_episode_title": "latest episode title if visible (podcasts only, else null)",
  "channel_url": null,
  "view_count": view count as integer if visible (YouTube only, else null),
  "published_date": "ISO date YYYY-MM-DD if visible (YouTube/articles, else null)",
  "game_platforms": ["PS5"] array of platforms if visible (games only, else null),
  "metacritic_score": score as integer if visible (games only, else null),
  "playtime_estimate": "playtime string if visible (games only, else null)",
  "studio": "studio name if visible (games only, else null)",
  "wine_region": "region if visible (wine only, else null)",
  "grape_variety": "grape/ingredient if visible (wine only, else null)",
  "abv": ABV as float if visible (wine only, else null),
  "tasting_notes": "tasting notes if visible (wine only, else null)",
  "food_pairing": ["food"] array if visible (wine only, else null),
  "publication_name": "publication name if visible (articles only, else null)",
  "read_time_minutes": read time in minutes if visible (articles only, else null),
  "word_count": word count if visible (articles only, else null),
  "article_tags": ["tag"] array if visible (articles only, else null),
  "pricing_model": "free" or "paid" or "subscription" if visible (apps only, else null),
  "app_store_url": null,
  "app_category": "category if visible (apps only, else null)",
  "app_version": "version if visible (apps only, else null)",

  "confidence": 0.0-1.0,
  "search_query": "search query to find this online"
}

Set confidence to 0.8 or higher for any clearly identifiable content.
Return ONLY the JSON object, no markdown.`,
          },
        ],
      },
    ],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '{}';

  try {
    return parseJSON(text);
  } catch {
    logger.warn('Failed to parse AI screenshot analysis response', { text });
    return { confidence: 0 };
  }
}

/**
 * Match extracted product data against a list of candidate products.
 * Returns the best match and a confidence score.
 */
async function matchProduct(extractedData, candidates) {
  if (!candidates || candidates.length === 0) {
    return { match: null, confidence: 0 };
  }

  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 512,

    system: `You are a product matching specialist. Determine which candidate product best matches the extracted product data.`,
    messages: [
      {
        role: 'user',
        content: `Given this extracted product data:
${JSON.stringify(extractedData, null, 2)}

Match it against these candidates (index 0-based):
${candidates.map((c, i) => `[${i}] ${JSON.stringify(c)}`).join('\n')}

Return a JSON object:
{
  "best_match_index": number or null,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Return ONLY the JSON object.`,
      },
    ],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '{}';

  try {
    const result = parseJSON(text);
    return {
      match:
        result.best_match_index !== null ? candidates[result.best_match_index] : null,
      confidence: result.confidence || 0,
      reasoning: result.reasoning,
    };
  } catch {
    return { match: null, confidence: 0 };
  }
}

/**
 * Generate alternative product suggestions for a given product.
 */
async function generateAlternatives(product) {
  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 1024,

    system: `You are a product recommendation specialist. Suggest alternative products based on the input product.`,
    messages: [
      {
        role: 'user',
        content: `For this product, suggest 5 alternative products a buyer might consider:
${JSON.stringify(product, null, 2)}

Return a JSON array of alternatives:
[
  {
    "name": "product name",
    "brand": "brand",
    "reason": "why: cheaper|similar|same_product_different_retailer|premium_upgrade",
    "estimated_price_range": "e.g. £50-£80",
    "search_query": "search query to find this online",
    "similarity_score": 0.0-1.0
  }
]

Return ONLY the JSON array, no markdown.`,
      },
    ],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '[]';

  try {
    return parseJSON(text);
  } catch {
    logger.warn('Failed to parse alternatives response', { text });
    return [];
  }
}

/**
 * Analyse a social media link (Instagram/TikTok/Pinterest) and suggest product matches.
 */
async function analyzeSocialLink(url, captionText = null, imageBase64 = null) {
  const contentParts = [
    { type: 'text', text: `Social media URL: ${url}` },
  ];

  if (captionText) {
    contentParts.push({ type: 'text', text: `Caption/description: ${captionText}` });
  }

  if (imageBase64) {
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
    });
  }

  contentParts.push({
    type: 'text',
    text: `Identify any products visible or mentioned in this social media content.
Return a JSON array of detected products:
[
  {
    "name": "product name",
    "brand": "brand if known",
    "category": "category",
    "confidence": 0.0-1.0,
    "search_query": "optimized search query to find this product online",
    "notes": "brief notes about what indicated this product"
  }
]

Return ONLY the JSON array, no markdown.`,
  });

  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 1024,

    system: `You are a social media product identification specialist. You identify products shown or mentioned in social media posts.`,
    messages: [{ role: 'user', content: contentParts }],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '[]';

  try {
    return parseJSON(text);
  } catch {
    logger.warn('Failed to parse social analysis response', { text });
    return [];
  }
}

/**
 * Normalise raw product data from multiple sources into a clean canonical record.
 */
async function normalizeProductData(rawDataArray) {
  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 1024,

    system: `You are a data normalisation specialist. Merge multiple product data records into one canonical product record.`,
    messages: [
      {
        role: 'user',
        content: `Merge these product data records into one canonical record:
${JSON.stringify(rawDataArray, null, 2)}

Return a single JSON object:
{
  "name": "canonical product name",
  "brand": "brand/manufacturer",
  "description": "best description (max 300 chars)",
  "category": "most accurate category",
  "image_url": "best image URL",
  "canonical_id": "brand:product-slug e.g. nike:air-max-90-white"
}

Return ONLY the JSON object.`,
      },
    ],
  }));
  const text = message.content.find(b => b.type === 'text')?.text || '{}';

  try {
    return parseJSON(text);
  } catch {
    logger.warn('Failed to parse normalization response', { text });
    return rawDataArray[0] || {};
  }
}

/**
 * Find retailer URLs for a product by scraping each retailer's search results page.
 * This approach avoids hallucinated URLs — we construct real search queries, scrape
 * the results, and extract the first genuine product link from each site.
 */
async function findRetailersForProduct(product) {
  const cheerio = require('cheerio');
  const { fetchPage } = require('./scraperService');

  const searchQuery = [product.brand, product.name].filter(Boolean).join(' ');
  const catAndName = ((product.category || '') + ' ' + (product.name || '')).toLowerCase();

  const isElectronics = /electron|tech|laptop|phone|tablet|headphone|earphone|audio|speaker|tv |camera|projector|fridge|freezer|appliance|monitor|console|gaming/.test(catAndName);
  const isFashion = /fashion|cloth|apparel|shoe|sneaker|tshirt|t-shirt|dress|jacket|shirt|hoodie|trouser|pants|polo|tee\b/.test(catAndName);

  // Retailer definitions: search URL + how to extract first product link from the results page
  const candidates = [];

  // Amazon UK — works for almost all categories
  candidates.push({
    name: 'Amazon UK',
    searchUrl: `https://www.amazon.co.uk/s?k=${encodeURIComponent(searchQuery)}`,
    extract($) {
      let found = null;
      $('a[href]').each((_, el) => {
        if (found) return;
        const href = $(el).attr('href') || '';
        const m = href.match(/\/dp\/([A-Z0-9]{10})/);
        if (m) found = `https://www.amazon.co.uk/dp/${m[1]}`;
      });
      return found;
    },
  });

  if (isElectronics || isFashion) {
    candidates.push({
      name: 'John Lewis',
      searchUrl: `https://www.johnlewis.com/search?search-term=${encodeURIComponent(searchQuery)}`,
      extract($) {
        let found = null;
        $('a[href]').each((_, el) => {
          if (found) return;
          let href = $(el).attr('href') || '';
          if (!href.startsWith('http')) href = 'https://www.johnlewis.com' + href;
          if (/johnlewis\.com\/[^?#"]+\/p\d+/.test(href)) found = href.split('?')[0];
        });
        return found;
      },
    });
  }

  if (isElectronics) {
    candidates.push({
      name: 'Currys',
      searchUrl: `https://www.currys.co.uk/search?q=${encodeURIComponent(searchQuery)}`,
      extract($) {
        let found = null;
        $('a[href]').each((_, el) => {
          if (found) return;
          let href = $(el).attr('href') || '';
          if (!href.startsWith('http')) href = 'https://www.currys.co.uk' + href;
          if (/currys\.co\.uk\/products\//.test(href)) found = href.split('?')[0];
        });
        return found;
      },
    });
  }

  if (isFashion) {
    candidates.push({
      name: 'ASOS',
      searchUrl: `https://www.asos.com/search/?q=${encodeURIComponent(searchQuery)}`,
      extract($) {
        let found = null;
        $('a[href]').each((_, el) => {
          if (found) return;
          let href = $(el).attr('href') || '';
          if (!href.startsWith('http')) href = 'https://www.asos.com' + href;
          if (/asos\.com\/[^?#]+\/prd\/\d+/.test(href)) found = href.split('?')[0];
        });
        return found;
      },
    });
  }

  // Search each retailer in parallel, collect only those that find a real URL
  const results = await Promise.allSettled(
    candidates.map(async retailer => {
      try {
        const page = await fetchPage(retailer.searchUrl);
        if (!page) return null;
        const $ = cheerio.load(page.html);
        const url = retailer.extract($);
        if (!url) return null;
        logger.debug('Found retailer URL via search', { retailer: retailer.name, url });
        return { retailer_name: retailer.name, url };
      } catch (err) {
        logger.debug('Retailer search failed', { retailer: retailer.name, error: err.message });
        return null;
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

/**
 * Generate a one-sentence description for a product when extraction returns nothing.
 * Used as a fallback so every saved item always has an about section.
 */
async function generateDescription({ name, brand, category, specs, item_type }) {
  if (!name) return null;

  const context = [
    name && `Name: ${name}`,
    brand && `Brand: ${brand}`,
    category && `Category: ${category}`,
    item_type && `Type: ${item_type}`,
    specs && Object.keys(specs).length > 0 && `Specs: ${Object.entries(specs).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
  ].filter(Boolean).join('\n');

  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 128,
    system: `You write concise, factual one-sentence product descriptions (max 150 characters). No marketing language. Just what it is.`,
    messages: [
      {
        role: 'user',
        content: `Write a one-sentence description for:\n${context}\n\nReturn ONLY the description string, nothing else.`,
      },
    ],
  }));

  const text = message.content.find(b => b.type === 'text')?.text?.trim() || null;
  return text && text.length > 0 ? text.slice(0, 200) : null;
}

/**
 * Generate 5 suggested questions a user might ask about a product.
 * Called once at import time; questions are stored on the product row.
 */
async function generateSuggestedQuestions(product) {
  const { name, brand, description, category, item_type, specs, genre, platform } = product;

  const context = [
    `Name: ${name}`,
    brand && `Brand: ${brand}`,
    category && `Category: ${category}`,
    item_type && `Type: ${item_type}`,
    genre && `Genre: ${genre}`,
    platform && `Platform: ${platform}`,
    description && `Description: ${description?.slice(0, 200)}`,
    specs && Object.keys(specs).length > 0 &&
      `Specs: ${Object.entries(specs).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
  ].filter(Boolean).join('\n');

  const message = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: `You generate short, casual questions that someone saving an item might genuinely want answered. Each question gets a relevant emoji prefix. Questions should be specific to this exact item — not generic. Return a JSON array of exactly 5 question strings. No markdown, no explanation.`,
    messages: [{
      role: 'user',
      content: `Generate 5 questions for this item:\n${context}\n\nReturn ONLY a JSON array of 5 strings, e.g. ["🎨 Is this available in other colours?", ...]`,
    }],
  }));

  const text = message.content.find(b => b.type === 'text')?.text || '[]';
  try {
    const questions = parseJSON(text);
    return Array.isArray(questions) ? questions.slice(0, 5) : [];
  } catch {
    return [];
  }
}

/**
 * Stream a casual AI answer about a product to a response object via SSE.
 * Writes `data: {"token":"..."}` lines; ends with `data: [DONE]`.
 */
async function streamProductAnswer(product, question, res) {
  const { name, brand, description, category, specs, reviews, rating, reviewCount } = product;

  const context = [
    `Product: ${name}`,
    brand && `Brand: ${brand}`,
    category && `Category: ${category}`,
    description && `Description: ${description?.slice(0, 300)}`,
    specs && Object.keys(specs).length > 0 &&
      `Specs: ${Object.entries(specs).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    rating && `Average rating: ${rating}/5${reviewCount ? ` (${reviewCount} reviews)` : ''}`,
    reviews?.length > 0 &&
      `Sample reviews: ${reviews.slice(0, 2).map(r => `"${r.text?.slice(0, 100)}"`).join('; ')}`,
  ].filter(Boolean).join('\n');

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 200,
    system: `You are a helpful, casual friend answering questions about a specific product the user has saved. Keep answers short (2–3 sentences), friendly, and based only on what you know about the product. Use the product context provided. Don't say "Based on the information provided" — just answer naturally.`,
    messages: [{
      role: 'user',
      content: `Product context:\n${context}\n\nQuestion: ${question}`,
    }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ token: event.delta.text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = {
  extractProductFromUrl,
  analyzeScreenshot,
  matchProduct,
  generateAlternatives,
  analyzeSocialLink,
  normalizeProductData,
  findRetailersForProduct,
  generateDescription,
  generateSuggestedQuestions,
  streamProductAnswer,
};
