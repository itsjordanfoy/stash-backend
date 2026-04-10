const { Pool } = require('pg');
const { logger } = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 600000,            // 10 min — keep connections alive longer
  connectionTimeoutMillis: 10000,       // 10 s to acquire a connection before erroring
  keepAlive: true,                      // TCP keepalive prevents OS/firewall dropping idle connections
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  // Log but do NOT rethrow — a dead client should not crash the process
  logger.error('PostgreSQL pool client error (pool will recover):', err.message);
});

async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connected:', result.rows[0].now);
  } catch (err) {
    logger.error('Database connection failed:', err);
    process.exit(1);
  }
}

/**
 * Widen a column to TEXT using information_schema to check first.
 * Logs clearly on success or failure — never silently swallows errors.
 */
async function widenToText(client, table, col) {
  try {
    const res = await client.query(
      `SELECT data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, col]
    );
    if (res.rows.length === 0) {
      // Column doesn't exist yet — will be added by ADD COLUMN below
      return;
    }
    const { data_type, character_maximum_length } = res.rows[0];
    if (data_type === 'character varying') {
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE TEXT`);
      logger.info(`Migration: widened ${table}.${col} from VARCHAR(${character_maximum_length}) to TEXT`);
    }
  } catch (err) {
    logger.error(`Migration: failed to widen ${table}.${col}: ${err.message}`);
  }
}

/**
 * Run idempotent schema migrations on startup.
 * All statements use ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS
 * so they are safe to re-run on every deploy.
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    // ── Step 1: Widen any VARCHAR columns that have restrictive length limits.
    //    Done BEFORE adding new columns so nothing blocks later steps.
    const toWiden = [
      // VARCHAR(20) columns that can overflow with real-world AI-generated values
      ['products', 'item_type'],
      ['products', 'runtime'],
      ['products', 'content_rating'],
      ['products', 'difficulty'],
      ['products', 'pricing_model'],
      ['products', 'isbn'],
      // VARCHAR(10) — imdb_score values like "7.8 (1.2M)" can exceed 10 chars
      ['products', 'imdb_score'],
      // VARCHAR(50) — app_version can be long (e.g. "2024.4.1 (build 12345)")
      ['products', 'app_version'],
      // VARCHAR(20) — status enum includes 'awaiting_confirmation' which is 21 chars
      ['import_queue', 'status'],
      ['import_queue', 'source_type'],
      // user_products status enums — widen proactively to survive future additions
      ['user_products', 'source_type'],
      ['user_products', 'listen_status'],
      ['user_products', 'watch_status'],
      ['user_products', 'read_status'],
      ['user_products', 'game_status'],
      ['user_products', 'size_preference'],
      // Notifications type and subscription status — same safety play
      ['notifications', 'type'],
      ['users', 'subscription_status'],
    ];
    for (const [table, col] of toWiden) {
      await widenToText(client, table, col);
    }

    // ── Step 2: Add any missing columns (IF NOT EXISTS = safe to re-run)
    const cols = [
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS phone TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2)`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS review_count INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS suggested_questions JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS display_config JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS reviews JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS imdb_score TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS rotten_tomatoes_score INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS awards JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS streaming_links JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS cast_with_photos JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS book_editions JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS book_awards JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS tour_dates JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS spotify_url TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS apple_music_url TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS price_range INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS menu_url TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS weather_forecast JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS nutrition JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS difficulty TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS course_instructor TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS course_duration_hours NUMERIC`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS course_modules_count INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS certificate_available BOOLEAN`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS podcast_network TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS episode_count INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS latest_episode_title TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS published_date DATE`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS channel_url TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS view_count BIGINT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS game_platforms JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS metacritic_score INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS playtime_estimate TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS studio TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_region TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS grape_variety TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS abv NUMERIC`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS tasting_notes TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS food_pairing JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS publication_name TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS read_time_minutes INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS word_count INTEGER`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS article_tags JSONB`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing_model TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS app_store_url TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS app_category TEXT`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS app_version TEXT`,
    ];
    for (const sql of cols) {
      await client.query(sql);
    }

    // ── Step 3: Widen item_type constraint to cover all supported types
    await client.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_item_type_check`);
    await client.query(`
      ALTER TABLE products ADD CONSTRAINT products_item_type_check
        CHECK (item_type IN (
          'product','place','entertainment','event','general',
          'course','podcast','youtube_video','video_game','wine','article','app'
        ))
    `);

    logger.info('Database migrations complete');
  } catch (err) {
    logger.error('Migration error (non-fatal):', err.message);
  } finally {
    client.release();
  }
}

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn('Slow query detected', { text, duration, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    logger.error('Query error', { text, params, error: err.message });
    throw err;
  }
}

async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  client.release = () => {
    client.release = originalRelease;
    return originalRelease();
  };
  return client;
}

async function transaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, getClient, transaction, testConnection, runMigrations };
