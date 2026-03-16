import pool from './database';
import fs from 'fs';
import path from 'path';

async function migrate() {
  const client = await pool.connect();
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get already executed migrations
    const { rows: executed } = await client.query('SELECT name FROM migrations ORDER BY id');
    const executedNames = new Set(executed.map((r) => r.name));

    // Read migration files
    const migrationsDir = path.join(__dirname, '../../migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (executedNames.has(file)) {
        console.log(`Skipping (already executed): ${file}`);
        continue;
      }

      console.log(`Running migration: ${file}`);
      let sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      // Try to install extensions separately (may require superuser on some hosts)
      const extensionRegex = /CREATE EXTENSION IF NOT EXISTS\s+"([^"]+)"\s*;/gi;
      let match;
      while ((match = extensionRegex.exec(sql)) !== null) {
        try {
          await client.query(match[0]);
          console.log(`  Extension "${match[1]}" ready.`);
        } catch (extErr: unknown) {
          const msg = extErr instanceof Error ? extErr.message : String(extErr);
          console.warn(`  ⚠️ Extension "${match[1]}" could not be created (may already exist or need manual install): ${msg}`);
        }
      }
      // Remove extension lines from the migration SQL (already handled above)
      sql = sql.replace(extensionRegex, '').trim();

      if (!sql) {
        // Migration was extension-only, mark as done
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        console.log(`Completed: ${file} (extensions only)`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Completed: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed: ${file}`, err);
        throw err;
      }
    }

    console.log('All migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
