import { Pool, QueryResult } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render (and most cloud providers) require SSL for external DB connections
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 20,                        // Max concurrent connections
  idleTimeoutMillis: 30000,       // Close idle connections after 30s
  connectionTimeoutMillis: 5000,  // Timeout new connection attempts after 5s
});

pool.on('error', (err) => {
  // Log but don't crash — the pool will recreate connections as needed
  console.error('Unexpected database pool error:', err.message);
});

// Transient PG error codes that are safe to retry
const RETRYABLE_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

/** Query with automatic retry for transient connection failures (max 2 retries, exponential backoff) */
export async function query(text: string, params?: any[]): Promise<QueryResult> {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err: any) {
      const code = err.code || err.message;
      const isRetryable = RETRYABLE_CODES.has(code) || /connection terminated|Connection terminated/.test(err.message || '');
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(100 * Math.pow(2, attempt), 1000);
      await new Promise((r) => setTimeout(r, delay));
      if (!isProduction) console.warn(`DB query retry ${attempt + 1}/${MAX_RETRIES} after ${code}`);
    }
  }
  // TypeScript: unreachable, but satisfies return type
  throw new Error('Query retry exhausted');
}

export default pool;
