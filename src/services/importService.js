const { query, transaction } = require('../database/db');
const aiService = require('./aiService');
const scraperService = require('./scraperService');
const { getPresignedUrl, uploadProductImages } = require('./storageService');
const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { enrichEntertainment } = require('./omdbService');

const CONFIDENCE_THRESHOLD = 0.75;
const FREE_IMPORT_LIMIT = 5;

// Social media hosts that block server-side scraping.
// These are handled with a dedicated fallback path so they never fail.
const SOCIAL_HOSTS = ['instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'pinterest.com', 'pinterest.co.uk', 'threads.net'];

function isSocialUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some(h => host.includes(h));
  } catch { return false; }
}

/**
 * Build a minimal but valid item from a social media URL when scraping fails.
 * Guarantees we always produce something the user can save.
 */
function buildSocialFallback(sourceUrl) {
  try {
    const { hostname, pathname } = new URL(sourceUrl);
    const host = hostname.toLowerCase();
    const pathParts = pathname.split('/').filter(Boolean);

    // Extract @username from path when it's the first segment (not a route keyword)
    const ROUTE_KEYWORDS = new Set(['reel', 'reels', 'p', 'watch', 'video', 'status', 'pin', 'i']);
    const rawUsername = pathParts[0] && !ROUTE_KEYWORDS.has(pathParts[0]) ? pathParts[0] : null;
    const username = rawUsername ? `@${rawUsername}` : null;

    if (host.includes('instagram.com')) {
      const isReel = pathname.includes('/reel');
      return {
        name: username ? `${username} on Instagram` : isReel ? 'Instagram Reel' : 'Instagram Post',
        item_type: 'entertainment',
        description: isReel ? 'Instagram Reel' : 'Instagram Post',
        category: 'Social Media',
        artist_or_director: username,
        cta_label: 'View on Instagram',
        cta_url: sourceUrl,
        confidence: 0.8,
      };
    }
    if (host.includes('tiktok.com')) {
      return {
        name: username ? `${username} on TikTok` : 'TikTok Video',
        item_type: 'entertainment',
        description: 'TikTok Video',
        category: 'Social Media',
        artist_or_director: username,
        cta_label: 'Watch on TikTok',
        cta_url: sourceUrl,
        confidence: 0.8,
      };
    }
    if (host.includes('twitter.com') || host.includes('x.com')) {
      return {
        name: username ? `${username} on X` : 'Post on X',
        item_type: 'entertainment',
        description: 'Post on X (formerly Twitter)',
        category: 'Social Media',
        artist_or_director: username,
        cta_label: 'View on X',
        cta_url: sourceUrl,
        confidence: 0.8,
      };
    }
    if (host.includes('threads.net')) {
      return {
        name: username ? `${username} on Threads` : 'Threads Post',
        item_type: 'entertainment',
        description: 'Post on Threads',
        category: 'Social Media',
        artist_or_director: username,
        cta_label: 'View on Threads',
        cta_url: sourceUrl,
        confidence: 0.8,
      };
    }
    if (host.includes('pinterest.com')) {
      return {
        name: 'Pinterest Pin',
        item_type: 'general',
        description: 'Saved from Pinterest',
        category: 'Social Media',
        cta_label: 'View on Pinterest',
        cta_url: sourceUrl,
        confidence: 0.8,
      };
    }
    return {
      name: 'Social Media Post',
      item_type: 'entertainment',
      category: 'Social Media',
      cta_label: 'View Post',
      cta_url: sourceUrl,
      confidence: 0.8,
    };
  } catch {
    return { name: 'Social Media Post', item_type: 'entertainment', category: 'Social Media', confidence: 0.8 };
  }
}

/**
 * Detect item type from URL domain/path before calling AI,
 * so we can pass a category hint for better extraction.
 */
function classifyUrlCategory(url) {
  if (!url) return null;
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    const path = pathname.toLowerCase();

    if (['udemy.com','coursera.org','skillshare.com','masterclass.com',
         'pluralsight.com','domestika.org','linkedin.com'].some(d => host.includes(d)) &&
        (host !== 'linkedin.com' || path.includes('/learning'))) return 'Course';

    if ((host.includes('youtube.com') && path.includes('/watch')) ||
        host.includes('youtu.be')) return 'YouTube Video';

    if (host.includes('tiktok.com')) return 'TikTok Video';
    if (host.includes('instagram.com')) return 'Instagram Post';

    if (host.includes('podcasts.apple.com') ||
        (host.includes('spotify.com') && path.includes('/show'))) return 'Podcast';

    if (['store.steampowered.com','store.playstation.com','xbox.com',
         'nintendo.com','epicgames.com'].some(d => host.includes(d))) return 'Video Game';
    if (host.includes('metacritic.com') && path.includes('/game')) return 'Video Game';

    if (['vivino.com','wine-searcher.com','thewhiskyexchange.com',
         'masterofmalt.com','decanter.com'].some(d => host.includes(d))) return 'Wine/Spirits';

    if (host.includes('apps.apple.com') || host.includes('play.google.com')) return 'App';

    if (['medium.com','substack.com'].some(d => host.includes(d))) return 'Article';
    if (['/blog/','/article/','/post/','/story/','/news/'].some(p => path.includes(p))) return 'Article';

    return null;
  } catch {
    return null;
  }
}

/**
 * Main import orchestrator. Creates an import_queue entry and begins processing.
 * Returns { importId, status, product?, suggestions? }
 */
async function startImport({ userId, sourceType, sourceUrl, screenshotKey, rawText }) {
  // Create queue entry
  const queueResult = await query(
    `INSERT INTO import_queue (user_id, source_type, source_url, screenshot_key, raw_text, status)
     VALUES ($1, $2, $3, $4, $5, 'processing')
     RETURNING id`,
    [userId, sourceType, sourceUrl || null, screenshotKey || null, rawText || null]
  );
  const importId = queueResult.rows[0].id;

  // Process async — don't await
  processImport(importId, { userId, sourceType, sourceUrl, screenshotKey, rawText }).catch(err => {
    logger.error('Import processing failed', { importId, error: err.message });
    markFailed(importId, err.message).catch(() => {});
  });

  return { importId, status: 'processing' };
}

async function processImport(importId, { userId, sourceType, sourceUrl, screenshotKey, rawText }) {
  try {
    let extractedData = null;

    if (sourceType === 'screenshot' && rawText) {
      // rawText contains base64 image data
      extractedData = await aiService.analyzeScreenshot(rawText);
      // Use the uploaded screenshot itself as the product image if AI didn't find one
      if (!extractedData.image_url && screenshotKey) {
        extractedData.image_url = await getPresignedUrl(screenshotKey, 604800).catch(() => null);
      }
    } else if (sourceType === 'social') {
      const socialProducts = await aiService.analyzeSocialLink(sourceUrl);
      if (socialProducts.length > 0) {
        // Take highest confidence suggestion
        extractedData = socialProducts.sort((a, b) => b.confidence - a.confidence)[0];
      } else {
        // Fall back to full scraping pipeline instead of hard-failing
        const pageResult = await scraperService.fetchPage(sourceUrl);
        const ogData = await scraperService.extractOpenGraph(sourceUrl, pageResult?.html || null);
        const urlCategory = classifyUrlCategory(sourceUrl);
        extractedData = await aiService.extractProductFromUrl(sourceUrl, pageResult?.html, ogData, urlCategory);
      }
    } else if (isSocialUrl(sourceUrl)) {
      // Social media URLs (Instagram, TikTok, Twitter, Pinterest) block server-side scraping.
      // Try OG extraction directly — public posts usually expose OG tags.
      // If that fails, build a guaranteed minimal item from the URL structure.
      const urlCategory = classifyUrlCategory(sourceUrl);
      const ogData = await scraperService.extractOpenGraph(sourceUrl, null).catch(() => null);

      if (ogData && (ogData.title || ogData.image)) {
        // OG worked — use AI to enrich, but always floor confidence at 0.8
        const aiResult = await aiService.extractProductFromUrl(sourceUrl, null, ogData, urlCategory).catch(() => null);
        if (aiResult && aiResult.confidence >= 0.4) {
          extractedData = aiResult;
        } else {
          // AI couldn't help — use OG data directly
          extractedData = buildSocialFallback(sourceUrl);
          if (ogData.title) extractedData.name = ogData.title;
          if (ogData.description) extractedData.description = ogData.description;
          if (ogData.image) extractedData.image_url = ogData.image;
        }
        // Guarantee confidence — the user deliberately shared this link
        extractedData.confidence = Math.max(extractedData.confidence || 0, 0.8);
        if (ogData.image && !extractedData.image_url) extractedData.image_url = ogData.image;
      } else {
        // OG failed — use URL structure to build a minimal but valid item
        extractedData = buildSocialFallback(sourceUrl);
      }
    } else {
      // link import — fetch page first, then extract OG from same HTML (avoids double request)
      const pageResult = await scraperService.fetchPage(sourceUrl);
      const ogData = await scraperService.extractOpenGraph(sourceUrl, pageResult?.html || null);

      const htmlData = pageResult
        ? scraperService.parseProductPage(pageResult.html, sourceUrl)
        : null;

      // Merge OG + HTML data
      const rawPageData = {
        ...(htmlData || {}),
        ...(ogData
          ? {
              name: ogData.title || htmlData?.name,
              image_url: ogData.image || htmlData?.image_url,
              description: ogData.description || htmlData?.description,
              retailer_name: ogData.site_name,
              price: ogData.price || htmlData?.price,
            }
          : {}),
      };

      // Use AI to extract and enrich (with URL-based category hint if detectable)
      const urlCategory = classifyUrlCategory(sourceUrl);
      extractedData = await aiService.extractProductFromUrl(
        sourceUrl,
        pageResult?.html,
        ogData,
        urlCategory
      );

      // Merge AI result with scraped data
      // Reviews: prefer AI-extracted (richer text), fall back to JSON-LD scraped
      const mergedReviews = (() => {
        const aiRevs = Array.isArray(extractedData.reviews) ? extractedData.reviews : [];
        const scrapedRevs = Array.isArray(rawPageData.reviews) ? rawPageData.reviews : [];
        const combined = aiRevs.length > 0 ? aiRevs : scrapedRevs;
        return combined.slice(0, 5);
      })();

      extractedData = {
        ...rawPageData,
        ...extractedData,
        price: extractedData.price || rawPageData.price,
        image_url: extractedData.image_url || rawPageData.image_url,
        images: [
          ...new Set([
            ...(Array.isArray(extractedData.images) ? extractedData.images : []),
            ...(Array.isArray(rawPageData.images) ? rawPageData.images : []),
            ...(extractedData.image_url ? [extractedData.image_url] : []),
            ...(rawPageData.image_url ? [rawPageData.image_url] : []),
          ])
        ].filter(Boolean).slice(0, 8),
        reviews: mergedReviews.length > 0 ? mergedReviews : null,
      };

      // Ensure all image URLs are absolute, HTTPS, and clean
      const normalizeImageUrl = (img) => {
        if (!img) return null;
        try {
          let abs = img.startsWith('http') ? img : new URL(img, sourceUrl).href;
          abs = abs.replace(/\{width\}/g, '800').replace(/\{height\}/g, '800');
          abs = abs.replace(/^http:\/\//i, 'https://');
          return abs;
        } catch { return null; }
      };

      extractedData.images = (extractedData.images || []).map(normalizeImageUrl).filter(Boolean);

      if (extractedData.image_url && !extractedData.image_url.startsWith('http')) {
        try {
          extractedData.image_url = new URL(extractedData.image_url, sourceUrl).href;
        } catch {
          extractedData.image_url = null;
        }
      }
      extractedData.image_url = normalizeImageUrl(extractedData.image_url);

      // Make sure image_url is the first entry in images
      if (extractedData.image_url && !extractedData.images.includes(extractedData.image_url)) {
        extractedData.images = [extractedData.image_url, ...extractedData.images];
      }
      if (!extractedData.image_url && extractedData.images.length > 0) {
        extractedData.image_url = extractedData.images[0];
      }

      // Try platform-specific APIs for extra images (e.g. Squarespace ?format=json)
      const platformImages = await scraperService.fetchPlatformImages(sourceUrl).catch(() => []);
      if (platformImages.length > 0) {
        const existing = new Set(extractedData.images || []);
        const fresh = platformImages.filter(u => !existing.has(u));
        extractedData.images = [...(extractedData.images || []), ...fresh].slice(0, 12);
        if (!extractedData.image_url) extractedData.image_url = platformImages[0];
      }

      // Last resort — if still no image, retry OG extraction cycling through all UAs
      if (!extractedData.image_url && sourceUrl) {
        logger.debug('No image found after extraction, trying OG fallback', { sourceUrl });
        const fallbackImg = await scraperService.fetchOGImage(sourceUrl).catch(() => null);
        if (fallbackImg) {
          extractedData.image_url = fallbackImg;
          extractedData.images = [fallbackImg, ...( extractedData.images || [])].filter(Boolean);
        }
      }
    }

    // Ensure every item has a description — generate one from metadata if extraction missed it
    if (!extractedData.description && extractedData.name) {
      extractedData.description = await aiService.generateDescription(extractedData).catch(() => null);
    }

    // Upload all product images to S3 so the app can always load them regardless
    // of the original retailer's CDN hotlink policy or Railway's datacenter IP.
    if (extractedData.image_url || (extractedData.images || []).length > 0) {
      const s3Result = await uploadProductImages(
        extractedData.image_url,
        extractedData.images || []
      ).catch(() => null);
      if (s3Result) {
        extractedData.image_url = s3Result.imageUrl || extractedData.image_url;
        extractedData.images = s3Result.images.length > 0 ? s3Result.images : extractedData.images;
      }
    }

    if (!extractedData || extractedData.confidence < 0.2) {
      const failMsg = sourceUrl
        ? 'We couldn\'t extract enough information from this link. Try sharing a screenshot of the page instead.'
        : 'Could not identify anything from this content. Try sharing a screenshot instead.'
      await markFailed(importId, failMsg);
      return;
    }

    // Check for existing matching product
    const existingProduct = await findExistingProduct(extractedData);

    if (existingProduct && extractedData.confidence >= CONFIDENCE_THRESHOLD) {
      // High confidence + existing match → update images if we scraped better data, then complete
      const freshImages = Array.isArray(extractedData.images) && extractedData.images.length > 0
        ? extractedData.images : [];
      const descriptionUpdate = extractedData.description && !existingProduct.description
        ? extractedData.description : null;
      if (freshImages.length > 0 || descriptionUpdate) {
        await query(
          `UPDATE products
              SET images      = CASE WHEN $1::jsonb IS NOT NULL AND jsonb_array_length($1::jsonb) > jsonb_array_length(COALESCE(images,'[]'::jsonb))
                                     THEN $1::jsonb ELSE images END,
                  image_url   = COALESCE(image_url, $2),
                  description = COALESCE(description, $4),
                  updated_at  = NOW()
            WHERE id = $3`,
          [
            freshImages.length > 0 ? JSON.stringify(freshImages) : null,
            freshImages[0] || null,
            existingProduct.id,
            descriptionUpdate,
          ]
        );
      }
      await finaliseImport(importId, userId, existingProduct.id, sourceUrl, sourceType, screenshotKey);
      return;
    }

    if (extractedData.confidence >= CONFIDENCE_THRESHOLD) {
      // High confidence, no existing → create product and complete
      const productId = await createProduct(extractedData, sourceUrl, sourceType);
      // Fire-and-forget: generate suggested questions for this product
      aiService.generateSuggestedQuestions(extractedData).then(questions => {
        if (Array.isArray(questions) && questions.length > 0) {
          query('UPDATE products SET suggested_questions = $1 WHERE id = $2',
            [JSON.stringify(questions), productId]).catch(() => {});
        }
      }).catch(() => {});
      await finaliseImport(importId, userId, productId, sourceUrl, sourceType, screenshotKey);
      return;
    }

    // Low confidence → return suggestions for user confirmation
    const suggestions = [extractedData];
    if (existingProduct) {
      suggestions.unshift({ ...existingProduct, confidence: 0.9 });
    }

    await query(
      `UPDATE import_queue SET status = 'awaiting_confirmation', suggestions = $1 WHERE id = $2`,
      [JSON.stringify(suggestions), importId]
    );
  } catch (err) {
    logger.error('processImport error', { importId, error: err.message });
    await markFailed(importId, err.message);
  }
}

/**
 * Confirm a product from suggestions and finalise the import.
 */
async function confirmImport(importId, userId, confirmedData) {
  const queueResult = await query(
    `SELECT * FROM import_queue WHERE id = $1 AND user_id = $2`,
    [importId, userId]
  );

  if (queueResult.rows.length === 0) {
    throw new Error('Import not found');
  }

  const importRecord = queueResult.rows[0];

  let productId;
  if (confirmedData.product_id) {
    productId = confirmedData.product_id;
  } else {
    productId = await createProduct(confirmedData, importRecord.source_url, importRecord.source_type);
    // Fire-and-forget: generate suggested questions for this product
    aiService.generateSuggestedQuestions(confirmedData).then(questions => {
      if (Array.isArray(questions) && questions.length > 0) {
        query('UPDATE products SET suggested_questions = $1 WHERE id = $2',
          [JSON.stringify(questions), productId]).catch(() => {});
      }
    }).catch(() => {});
  }

  await finaliseImport(
    importId,
    userId,
    productId,
    importRecord.source_url,
    importRecord.source_type,
    importRecord.screenshot_key
  );

  return productId;
}

async function createProduct(data, sourceUrl, sourceType) {
  return await transaction(async client => {
    const productImages = JSON.stringify(
      Array.isArray(data.images) && data.images.length > 0
        ? data.images
        : (data.image_url ? [data.image_url] : [])
    );

    // Resolve CTA: for events prefer ticket_url, fall back to cta_url, fall back to sourceUrl
    const resolvedCtaUrl = data.cta_url || data.ticket_url ||
      (data.item_type === 'event' || data.item_type === 'place' ? sourceUrl : null);
    const resolvedCtaLabel = data.cta_label ||
      (data.item_type === 'event' ? 'Book Tickets' :
       data.item_type === 'place' ? 'Get Directions' :
       data.item_type === 'entertainment' ? 'Watch / Listen' : null);

    const productResult = await client.query(
      `INSERT INTO products (
         name, brand, description, category, image_url, images,
         item_type, address, google_maps_url, release_year, streaming_platforms,
         genre, artist_or_director, event_date, event_venue, ticket_url,
         ingredients, steps, cta_label, cta_url, isbn, platform,
         runtime, content_rating, cast_members, trailer_url,
         page_count, publisher, edition, goodreads_url,
         tracklist, record_label, pressing_info, condition,
         specs,
         latitude, longitude, opening_hours, reservation_url,
         servings, cook_time,
         imdb_score, rotten_tomatoes_score, awards, streaming_links, cast_with_photos,
         book_editions, book_awards, tour_dates, spotify_url, apple_music_url,
         price_range, menu_url, weather_forecast, nutrition, difficulty,
         course_instructor, course_duration_hours, course_modules_count, certificate_available,
         podcast_network, episode_count, latest_episode_title,
         published_date, channel_url, view_count,
         game_platforms, metacritic_score, playtime_estimate, studio,
         wine_region, grape_variety, abv, tasting_notes, food_pairing,
         publication_name, read_time_minutes, word_count, article_tags,
         pricing_model, app_store_url, app_category, app_version,
         phone, rating, review_count, reviews,
         display_config
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,
               $42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,
               $57,$58,$59,$60,$61,$62,$63,$64,$65,$66,$67,$68,$69,$70,$71,$72,$73,$74,$75,
               $76,$77,$78,$79,$80,$81,$82,$83,$84,$85,$86,$87,$88)
       ON CONFLICT (canonical_id) DO UPDATE
         SET name      = EXCLUDED.name,
             image_url = COALESCE(EXCLUDED.image_url, products.image_url),
             images    = CASE WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images ELSE products.images END,
             updated_at = NOW()
       RETURNING id`,
      [
        data.name || 'Untitled',           // $1
        data.brand || null,                // $2
        data.description || null,          // $3
        data.category || null,             // $4
        data.image_url || null,            // $5
        productImages,                     // $6
        data.item_type || null,            // $7
        data.address || null,              // $8
        data.google_maps_url || null,      // $9
        data.release_year || null,         // $10
        data.streaming_platforms ? JSON.stringify(data.streaming_platforms) : null, // $11
        data.genre || null,                // $12
        data.artist_or_director || null,   // $13
        data.event_date || null,           // $14
        data.event_venue || null,          // $15
        data.ticket_url || null,           // $16
        data.ingredients ? JSON.stringify(data.ingredients) : null, // $17
        data.steps ? JSON.stringify(data.steps) : null,             // $18
        resolvedCtaLabel,                  // $19
        resolvedCtaUrl,                    // $20
        data.isbn || null,                 // $21
        data.platform || null,             // $22
        data.runtime || null,              // $23
        data.content_rating || null,       // $24
        data.cast_members ? JSON.stringify(data.cast_members) : null, // $25
        data.trailer_url || null,          // $26
        data.page_count || null,           // $27
        data.publisher || null,            // $28
        data.edition || null,              // $29
        data.goodreads_url || null,        // $30
        data.tracklist ? JSON.stringify(data.tracklist) : null, // $31
        data.record_label || null,         // $32
        data.pressing_info || null,        // $33
        data.condition || null,            // $34
        data.specs ? JSON.stringify(data.specs) : null,         // $35
        data.latitude || null,             // $36
        data.longitude || null,            // $37
        data.opening_hours ? JSON.stringify(data.opening_hours) : null, // $38
        data.reservation_url || null,      // $39
        data.servings || null,             // $40
        data.cook_time || null,            // $41
        data.imdb_score || null,           // $42
        data.rotten_tomatoes_score || null, // $43
        data.awards ? JSON.stringify(data.awards) : null,              // $44
        data.streaming_links ? JSON.stringify(data.streaming_links) : null, // $45
        data.cast_with_photos ? JSON.stringify(data.cast_with_photos) : null, // $46
        data.book_editions ? JSON.stringify(data.book_editions) : null,       // $47
        data.book_awards ? JSON.stringify(data.book_awards) : null,           // $48
        data.tour_dates ? JSON.stringify(data.tour_dates) : null,             // $49
        data.spotify_url || null,          // $50
        data.apple_music_url || null,      // $51
        data.price_range || null,          // $52
        data.menu_url || null,             // $53
        null,                              // $54 weather_forecast — populated by weather API
        data.nutrition ? JSON.stringify(data.nutrition) : null, // $55
        data.difficulty || null,           // $56
        // New item types
        data.course_instructor || null,    // $57
        data.course_duration_hours || null, // $58
        data.course_modules_count || null, // $59
        data.certificate_available != null ? data.certificate_available : null, // $60
        data.podcast_network || null,      // $61
        data.episode_count || null,        // $62
        data.latest_episode_title || null, // $63
        data.published_date || null,       // $64
        data.channel_url || null,          // $65
        data.view_count || null,           // $66
        data.game_platforms ? JSON.stringify(data.game_platforms) : null, // $67
        data.metacritic_score || null,     // $68
        data.playtime_estimate || null,    // $69
        data.studio || null,               // $70
        data.wine_region || null,          // $71
        data.grape_variety || null,        // $72
        data.abv || null,                  // $73
        data.tasting_notes || null,        // $74
        data.food_pairing ? JSON.stringify(data.food_pairing) : null, // $75
        data.publication_name || null,     // $76
        data.read_time_minutes || null,    // $77
        data.word_count || null,           // $78
        data.article_tags ? JSON.stringify(data.article_tags) : null, // $79
        data.pricing_model || null,        // $80
        data.app_store_url || null,        // $81
        data.app_category || null,         // $82
        data.app_version || null,          // $83
        data.phone || null,                // $84
        data.rating || null,               // $85
        data.review_count || null,         // $86
        data.reviews ? JSON.stringify(data.reviews) : null, // $87
        data.display_config ? JSON.stringify(data.display_config) : null, // $88
      ]
    );
    const productId = productResult.rows[0].id;

    // Only create a retailer entry for purchasable products (not events/places/entertainment/media)
    const nonShoppableTypes = new Set(['event', 'place', 'entertainment', 'course', 'podcast', 'youtube_video', 'article']);
    const isShoppable = !nonShoppableTypes.has(data.item_type) || data.price;
    if (sourceUrl && isShoppable) {
      await client.query(
        `INSERT INTO product_retailers (product_id, retailer_name, product_url, current_price, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, product_url) DO UPDATE
           SET current_price = COALESCE(EXCLUDED.current_price, product_retailers.current_price),
               last_checked  = NOW()`,
        [
          productId,
          data.retailer_name || extractRetailerName(sourceUrl),
          sourceUrl,
          data.price || null,
          data.currency || 'GBP',
        ]
      );

      if (data.price) {
        await client.query(
          `INSERT INTO price_history (product_id, retailer_name, price, currency)
           VALUES ($1, $2, $3, $4)`,
          [productId, data.retailer_name || extractRetailerName(sourceUrl), data.price, data.currency || 'GBP']
        );
      }
    }

    return productId;
  });
}

async function finaliseImport(importId, userId, productId, sourceUrl, sourceType, screenshotKey) {
  await transaction(async client => {
    // Upsert user_products
    await client.query(
      `INSERT INTO user_products (user_id, product_id, source_url, source_type, screenshot_url, is_tracking)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [userId, productId, sourceUrl || null, sourceType, screenshotKey || null, false]
    );

    // Increment imports_used
    await client.query(
      `UPDATE users SET imports_used = imports_used + 1 WHERE id = $1`,
      [userId]
    );

    // Mark queue entry complete
    await client.query(
      `UPDATE import_queue SET status = 'completed', product_id = $1 WHERE id = $2`,
      [productId, importId]
    );
  });

  // Fire-and-forget OMDB enrichment for movies & TV — never blocks the import response
  enrichEntertainment(productId).catch(() => {});
}

async function findExistingProduct(data) {
  if (!data.name) return null;

  const result = await query(
    `SELECT id, name, brand, image_url
     FROM products
     WHERE search_vector @@ plainto_tsquery('english', $1)
       OR name ILIKE $2
     LIMIT 1`,
    [data.name, `%${data.name.slice(0, 30)}%`]
  );

  return result.rows[0] || null;
}

async function markFailed(importId, error) {
  const message = sanitizeErrorMessage(error);
  await query(
    `UPDATE import_queue SET status = 'failed', error = $1 WHERE id = $2`,
    [message, importId]
  );
}

function sanitizeErrorMessage(error) {
  if (!error) return 'Import failed. Please try again.';
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  // Hide raw API error payloads (e.g. 529 overloaded, 401 auth errors, etc.)
  if (/529|overloaded|503|502|rate.?limit|too.many.request/i.test(msg)) {
    return 'Service temporarily busy. Please try again in a moment.';
  }
  if (/401|403|invalid.*key|api.*key/i.test(msg)) {
    return 'Import failed. Please try again.';
  }
  // Hide raw database errors — these are internal and should never reach the user
  if (/column .* of relation|relation .* does not exist|violates check constraint|duplicate key|syntax error at or near|ERROR:.*postgres/i.test(msg)) {
    return 'Import failed. Please try again.';
  }
  // Sanitise any old "No products detected" messages that may still be in the DB
  if (/no products detected|social media content/i.test(msg)) {
    return 'We couldn\'t extract enough information from this link. Try sharing a screenshot instead.';
  }
  // If it looks like raw JSON or an HTTP error body, replace with generic message
  if (msg.startsWith('{') || msg.startsWith('[') || /^\d{3}\s+\{/.test(msg)) {
    return 'Import failed. Please try again.';
  }
  return msg;
}

function extractRetailerName(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return hostname.split('.')[0].replace(/-/g, ' ');
  } catch {
    return 'Unknown';
  }
}

/**
 * Get the current status of an import.
 */
async function getImportStatus(importId, userId) {
  const result = await query(
    `SELECT iq.*, p.id as product_id, p.name as product_name, p.image_url
     FROM import_queue iq
     LEFT JOIN products p ON p.id = iq.product_id
     WHERE iq.id = $1 AND iq.user_id = $2`,
    [importId, userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    source_type: row.source_type,
    suggestions: row.suggestions,
    error: row.error ? sanitizeErrorMessage(row.error) : null,
    product: row.product_id
      ? { id: row.product_id, name: row.product_name, image_url: row.image_url }
      : null,
    created_at: row.created_at,
  };
}

/**
 * Re-extract a product from its original source URL with a corrected category hint.
 * Updates the existing product record in place — does not create a new product,
 * does not touch user_products, does not increment imports_used.
 */
async function reExtractProduct(productId, userId, categoryHint) {
  // Verify ownership and get source URL
  const sourceResult = await query(
    `SELECT up.source_url, up.source_type
     FROM user_products up
     WHERE up.product_id = $1 AND up.user_id = $2`,
    [productId, userId]
  );

  if (!sourceResult.rows.length) throw new Error('Product not found');

  const { source_url: sourceUrl, source_type: sourceType } = sourceResult.rows[0];

  if (!sourceUrl) throw new Error('No source URL stored for this product — cannot re-extract');

  // Re-scrape the page
  const pageResult = await scraperService.fetchPage(sourceUrl);
  const ogData = await scraperService.extractOpenGraph(sourceUrl, pageResult?.html || null);
  const htmlData = pageResult
    ? scraperService.parseProductPage(pageResult.html, sourceUrl)
    : null;

  const rawPageData = {
    ...(htmlData || {}),
    ...(ogData ? {
      name: ogData.title || htmlData?.name,
      image_url: ogData.image || htmlData?.image_url,
      description: ogData.description || htmlData?.description,
      retailer_name: ogData.site_name,
      price: ogData.price || htmlData?.price,
    } : {}),
  };

  // Re-run AI extraction with category hint
  let extractedData = await aiService.extractProductFromUrl(sourceUrl, pageResult?.html, ogData, categoryHint);

  extractedData = {
    ...rawPageData,
    ...extractedData,
    price: extractedData.price || rawPageData.price,
    image_url: extractedData.image_url || rawPageData.image_url,
    images: [
      ...new Set([
        ...(Array.isArray(extractedData.images) ? extractedData.images : []),
        ...(Array.isArray(rawPageData.images) ? rawPageData.images : []),
        ...(extractedData.image_url ? [extractedData.image_url] : []),
        ...(rawPageData.image_url ? [rawPageData.image_url] : []),
      ])
    ].filter(Boolean).slice(0, 8),
  };

  // Update the existing product record with all freshly extracted fields
  await updateProductFields(productId, extractedData);

  return productId;
}

async function updateProductFields(productId, data) {
  const productImages = JSON.stringify(
    Array.isArray(data.images) && data.images.length > 0
      ? data.images
      : (data.image_url ? [data.image_url] : [])
  );

  await query(
    `UPDATE products SET
      name = $1, brand = $2, description = $3, category = $4, image_url = $5, images = $6,
      item_type = $7, address = $8, google_maps_url = $9, release_year = $10,
      streaming_platforms = $11, genre = $12, artist_or_director = $13,
      event_date = $14, event_venue = $15, ticket_url = $16,
      ingredients = $17, steps = $18, cta_label = $19, cta_url = $20,
      isbn = $21, platform = $22, runtime = $23, content_rating = $24,
      cast_members = $25, trailer_url = $26, page_count = $27, publisher = $28,
      edition = $29, goodreads_url = $30, tracklist = $31, record_label = $32,
      pressing_info = $33, condition = $34, specs = $35,
      latitude = $36, longitude = $37, opening_hours = $38, reservation_url = $39,
      servings = $40, cook_time = $41,
      imdb_score = $42, rotten_tomatoes_score = $43,
      awards = $44, streaming_links = $45, cast_with_photos = $46,
      book_editions = $47, book_awards = $48, tour_dates = $49,
      spotify_url = $50, apple_music_url = $51,
      price_range = $52, menu_url = $53, nutrition = $54, difficulty = $55,
      phone = $57, rating = $58, review_count = $59,
      updated_at = NOW()
    WHERE id = $56`,
    [
      data.name || 'Untitled',
      data.brand || null,
      data.description || null,
      data.category || null,
      data.image_url || null,
      productImages,
      data.item_type || null,
      data.address || null,
      data.google_maps_url || null,
      data.release_year || null,
      data.streaming_platforms ? JSON.stringify(data.streaming_platforms) : null,
      data.genre || null,
      data.artist_or_director || null,
      data.event_date || null,
      data.event_venue || null,
      data.ticket_url || null,
      data.ingredients ? JSON.stringify(data.ingredients) : null,
      data.steps ? JSON.stringify(data.steps) : null,
      data.cta_label || null,
      data.cta_url || null,
      data.isbn || null,
      data.platform || null,
      data.runtime || null,
      data.content_rating || null,
      data.cast_members ? JSON.stringify(data.cast_members) : null,
      data.trailer_url || null,
      data.page_count || null,
      data.publisher || null,
      data.edition || null,
      data.goodreads_url || null,
      data.tracklist ? JSON.stringify(data.tracklist) : null,
      data.record_label || null,
      data.pressing_info || null,
      data.condition || null,
      data.specs ? JSON.stringify(data.specs) : null,
      data.latitude || null,
      data.longitude || null,
      data.opening_hours ? JSON.stringify(data.opening_hours) : null,
      data.reservation_url || null,
      data.servings || null,
      data.cook_time || null,
      data.imdb_score || null,
      data.rotten_tomatoes_score || null,
      data.awards ? JSON.stringify(data.awards) : null,
      data.streaming_links ? JSON.stringify(data.streaming_links) : null,
      data.cast_with_photos ? JSON.stringify(data.cast_with_photos) : null,
      data.book_editions ? JSON.stringify(data.book_editions) : null,
      data.book_awards ? JSON.stringify(data.book_awards) : null,
      data.tour_dates ? JSON.stringify(data.tour_dates) : null,
      data.spotify_url || null,
      data.apple_music_url || null,
      data.price_range || null,
      data.menu_url || null,
      data.nutrition ? JSON.stringify(data.nutrition) : null,
      data.difficulty || null,
      productId,                           // $56
      data.phone || null,                  // $57
      data.rating || null,                 // $58
      data.review_count || null,           // $59
    ]
  );
}

module.exports = { startImport, confirmImport, getImportStatus, reExtractProduct };
