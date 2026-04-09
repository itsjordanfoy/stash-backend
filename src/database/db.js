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
 * Run idempotent schema migrations on startup.
 * All statements use ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS
 * so they are safe to re-run on every deploy.
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    // New columns added after initial schema
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS phone TEXT`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2)`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS review_count INTEGER`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS suggested_questions JSONB`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS display_config JSONB`);

    // Widen item_type constraint to cover all supported types
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
