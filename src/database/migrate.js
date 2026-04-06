require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { logger } = require('../utils/logger');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('Migration completed successfully');
  } catch (err) {
    logger.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
