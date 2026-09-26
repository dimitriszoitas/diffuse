import pg from 'pg';

export function createDatabasePool(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error('Database configuration is invalid.');
  // Copy only connection coordinates, so pg's URL parser cannot override TLS.
  const pool = new pg.Pool({host: url.hostname, port: Number(url.port || 5432),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)), ssl: {rejectUnauthorized: true}, max: 4,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000, statement_timeout: 25_000});
  pool.on('error', () => { /* pg evicts failed idle connections; never log connection secrets. */ });
  return pool;
}
