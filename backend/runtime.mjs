import {createHmac} from 'node:crypto';
import {createDatabasePool} from './database.mjs';
import {createJiraOAuthClient} from './jira-oauth.mjs';
import {createAuthService} from './auth-service.mjs';
import {createPostgresStore} from './store.mjs';
import {createJiraApiClient} from './jira-api.mjs';
import {createDeliveryService} from './delivery-service.mjs';
import {createPostgresDeliveryStore} from './delivery-store.mjs';
import {createPostgresPrivacyReportingStore} from './privacy-reporting-store.mjs';
import {createPrivacyReportingService} from './privacy-reporting.mjs';
import {HttpError} from './http.mjs';

export const allowedExtensionIds = (process.env.ALLOWED_EXTENSION_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
let services;
let database;
function pool() { return database ||= createDatabasePool(process.env.DATABASE_URL); }

export function getServices() {
  if (services) return services;
  const names = ['ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'PUBLIC_ORIGIN', 'DATABASE_URL', 'TOKEN_ENCRYPTION_KEY', 'ALLOWED_EXTENSION_IDS'];
  if (names.some(name => !process.env[name]?.trim())) throw new HttpError(503, 'The Jira connection is still being configured. Please try again after setup.');
  const oauth = createJiraOAuthClient({clientId: process.env.ATLASSIAN_CLIENT_ID, clientSecret: process.env.ATLASSIAN_CLIENT_SECRET, publicOrigin: process.env.PUBLIC_ORIGIN});
  const store = createPostgresStore({pool: pool()});
  const auth = createAuthService({store, oauth, cryptoKey: process.env.TOKEN_ENCRYPTION_KEY, allowedExtensionIds});
  const jira = createJiraApiClient();
  const deliveryStore = createPostgresDeliveryStore({pool: pool()});
  const delivery = createDeliveryService({store: deliveryStore, jira, oauth});
  const privacy = createPrivacyReportingService({store: createPostgresPrivacyReportingStore({pool: pool()}), connectionStore: store, oauth, cryptoKey: process.env.TOKEN_ENCRYPTION_KEY});
  services = {oauth, store, auth, jira, delivery, deliveryStore, privacy};
  return services;
}

export async function rateLimit(req, path) {
  // Keep setup failures informative; no credentials can be issued before config is ready.
  getServices();
  const now = Date.now();
  const window = Math.floor(now / 60_000);
  // Vercel overwrites this header at the edge; never retain an IP in the database.
  const address = String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown').slice(0, 256);
  const category = path.includes('oauth') ? 'oauth' : 'read';
  const bucket = createHmac('sha256', process.env.TOKEN_ENCRYPTION_KEY).update(`${category}:${window}:${address}`).digest('hex');
  const limit = category === 'oauth' ? 20 : 120;
  const result = await pool().query(`INSERT INTO diffuse_jira_request_limits (bucket, count, expires_at)
    VALUES ($1, 1, $2) ON CONFLICT (bucket) DO UPDATE SET count = diffuse_jira_request_limits.count + 1
    WHERE diffuse_jira_request_limits.count < $3 RETURNING count`, [bucket, new Date((window + 2) * 60_000), limit]);
  // Bounded retention; short-lived authorization states and abandoned handoffs too.
  await pool().query('DELETE FROM diffuse_jira_request_limits WHERE expires_at < $1', [new Date(now)]);
  await services.store.cleanupExpired(now);
  await services.deliveryStore.cleanupExpired(now);
  return Boolean(result.rows.length);
}
