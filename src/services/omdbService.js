/**
 * OMDB enrichment — fetches IMDb score, Rotten Tomatoes score, and awards
 * for movies and TV shows after import.
 *
 * Free tier: 1,000 requests/day at http://www.omdbapi.com/
 * Requires OMDB_API_KEY in .env
 */

const { query } = require('../database/db');
const { logger } = require('../utils/logger');

/**
 * Enrich a movie/TV product with scores and awards from OMDB.
 * Fire-and-forget — never throws, never blocks the import response.
 */
async function enrichEntertainment(productId) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return;

  try {
    // Fetch product name + year
    const result = await query(
      `SELECT name, release_year, item_type FROM products WHERE id = $1`,
      [productId]
    );
    if (!result.rows.length) return;
    const { name, release_year, item_type } = result.rows[0];
    if (item_type !== 'entertainment') return;

    // Skip if already enriched
    const existing = await query(
      `SELECT imdb_score FROM products WHERE id = $1`,
      [productId]
    );
    if (existing.rows[0]?.imdb_score) return;

    // Query OMDB by title (+ year if available)
    const params = new URLSearchParams({ apikey: apiKey, t: name, plot: 'short' });
    if (release_year) params.set('y', String(release_year));

    const res = await fetch(`https://www.omdbapi.com/?${params}`);
    const data = await res.json();

    if (data.Response !== 'True') {
      logger.warn('OMDB: no result', { name, release_year, error: data.Error });
      return;
    }

    // Extract scores
    const imdbScore = data.imdbRating && data.imdbRating !== 'N/A'
      ? `${data.imdbRating}/10`
      : null;

    const rtRating = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
    const rottenTomatoesScore = rtRating
      ? parseInt(rtRating.Value.replace('%', ''), 10)
      : null;

    // Parse awards into a short array of notable badges
    const awards = parseAwards(data.Awards);

    // Only update if we got something useful
    if (!imdbScore && !rottenTomatoesScore && !awards.length) return;

    await query(
      `UPDATE products
       SET imdb_score           = COALESCE($1, imdb_score),
           rotten_tomatoes_score = COALESCE($2, rotten_tomatoes_score),
           awards               = COALESCE($3, awards)
       WHERE id = $4`,
      [
        imdbScore,
        rottenTomatoesScore,
        awards.length ? JSON.stringify(awards) : null,
        productId,
      ]
    );

    logger.info('OMDB enrichment complete', { productId, imdbScore, rottenTomatoesScore, awards });
  } catch (err) {
    // Never block the import — log and move on
    logger.warn('OMDB enrichment failed (non-fatal)', { productId, error: err.message });
  }
}

/**
 * Converts OMDB's free-text Awards string into an array of short badge labels.
 * e.g. "Won 3 Oscars. Another 45 wins & 148 nominations."
 *   → ["Oscar Winner", "45 Wins"]
 */
function parseAwards(awardsStr) {
  if (!awardsStr || awardsStr === 'N/A') return [];
  const badges = [];
  const lower = awardsStr.toLowerCase();

  if (lower.includes('won') && lower.includes('oscar')) badges.push('Oscar Winner');
  else if (lower.includes('nominated') && lower.includes('oscar')) badges.push('Oscar Nominated');

  if (lower.includes('golden globe') && lower.includes('won')) badges.push('Golden Globe Winner');
  else if (lower.includes('golden globe')) badges.push('Golden Globe Nominated');

  if (lower.includes('bafta') && lower.includes('won')) badges.push('BAFTA Winner');
  else if (lower.includes('bafta')) badges.push('BAFTA Nominated');

  if (lower.includes('cannes') || lower.includes('palme')) badges.push("Palme d'Or");
  if (lower.includes('emmy') && lower.includes('won')) badges.push('Emmy Winner');
  if (lower.includes('sundance')) badges.push('Sundance Winner');

  // Generic win count as a fallback badge
  if (!badges.length) {
    const match = awardsStr.match(/(\d+)\s+win/i);
    if (match && parseInt(match[1]) >= 5) badges.push(`${match[1]} Award Wins`);
  }

  return badges;
}

module.exports = { enrichEntertainment };
