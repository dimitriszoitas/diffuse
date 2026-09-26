import {readFile} from 'node:fs/promises';
import {createDatabasePool} from './database.mjs';

let pool;
try {
  pool = createDatabasePool(process.env.DATABASE_URL);
  for (const name of ['schema.sql', 'rate-schema.sql', 'delivery-schema.sql']) await pool.query(await readFile(new URL(name, import.meta.url), 'utf8'));
  console.log('Diffuse database schema is ready.');
} catch {
  console.error('Diffuse database setup failed. Check the database configuration and connection; credentials were not logged.');
  process.exitCode = 1;
} finally { await pool?.end(); }
