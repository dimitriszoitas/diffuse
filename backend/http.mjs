import {JiraAuthError} from './security.mjs';
import {JiraOAuthError} from './jira-oauth.mjs';
import {JiraApiError} from './jira-api.mjs';
import {JiraDeliveryError} from './delivery-service.mjs';

const MAX_JSON = 24_576;
const CONNECTION = /^Bearer ([a-f0-9-]{36}\.[A-Za-z0-9_-]{43})$/;
const EXTENSION = /^[a-p]{32}$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
async function readBody(req, maxBytes = MAX_JSON) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON for this request.');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, 'This request is too large.');
  // Vercel may have already parsed the body. Apply the same bounds in both paths.
  let text;
  if (req.body !== undefined) {
    text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
  } else {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) throw new HttpError(413, 'This request is too large.');
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text || Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'This request is too large.');
  let value;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'The request must be an object.');
  return value;
}
function credential(req) {
  const match = CONNECTION.exec(req.headers.authorization || '');
  if (!match) throw new HttpError(401, 'Connect your Jira account in Diffuse.');
  return match[1];
}
function one(params, name, required = true) {
  const values = params.getAll(name);
  if (values.length > 1 || (required && (!values.length || !values[0]))) throw new HttpError(400, 'The request is invalid.');
  return values[0];
}
function safeFailure(error) {
  if (error instanceof HttpError) return {status: error.status, message: error.message};
  if (error instanceof JiraAuthError || error instanceof JiraOAuthError) {
    const status = ['unauthorized', 'access_denied', 'authorization_rejected'].includes(error.code) ? 401
      : error.code === 'rate_limited' ? 429
        : ['unavailable', 'timeout', 'invalid_configuration'].includes(error.code) ? 503 : 400;
    return {status, message: error.message, code: error.code};
  }
  if (error instanceof JiraApiError) return {status: error.status === 429 ? 429 : error.status === 401 ? 401 : error.outcome === 'not_sent' ? 400 : 502, message: error.message, code: error.code};
  if (error instanceof JiraDeliveryError) return {status: error.status, message: error.message, code: error.code};
  return {status: 503, message: 'Diffuse could not complete this request. Try again shortly.'};
}

/** No site URL or redirect is accepted from a caller. OAuth callbacks are the
 * only unauthenticated browser navigation; other operations use opaque credentials.
 * All responses are no-store, including errors, handoff codes and connection profiles.
 */
export function createHttpHandler({getServices, allowedExtensionIds = [], rateLimit = async () => true} = {}) {
  const extensions = new Set(allowedExtensionIds.filter(id => EXTENSION.test(id)));
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    const originId = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin.slice(19) : null;
    if (origin && (!originId || !extensions.has(originId))) return json(res, 403, {error: 'Open this action from Diffuse.'});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    try {
      const url = new URL(req.url, 'https://diffuse.invalid');
      if (req.method === 'OPTIONS') {
        if (!origin) throw new HttpError(403, 'Open this action from Diffuse.');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.statusCode = 204; return res.end();
      }
      if (req.method === 'GET' && ['/', '/health'].includes(url.pathname)) {
        // Health is intentionally liveness only; never disclose configured keys.
        return json(res, 200, {service: 'Diffuse Jira connection service', status: 'online'});
      }
      const routes = {'/v1/oauth/start': 'POST', '/v1/oauth/complete': 'POST', '/oauth/jira/callback': 'GET', '/v1/connection': ['GET', 'DELETE'], '/v1/sites': 'GET', '/v1/projects': 'GET', '/v1/issue-types': 'GET', '/v1/create-fields': 'GET', '/v1/attachment-settings': 'GET'};
      const deliveryRoute = /^\/v1\/deliveries\/([a-f0-9-]{36})(?:\/(chunks|issue|attachments)(?:\/([a-f0-9-]{36}))?)?$/i.exec(url.pathname);
      const deliveryPathValid = deliveryRoute && (deliveryRoute[2] === 'attachments' ? Boolean(deliveryRoute[3]) : !deliveryRoute[3]);
      const method = routes[url.pathname] || (url.pathname === '/v1/deliveries' ? 'POST' : deliveryPathValid ? deliveryRoute[2] ? 'POST' : 'GET' : null);
      if (!method) throw new HttpError(404, 'This Diffuse endpoint does not exist.');
      if (!(Array.isArray(method) ? method : [method]).includes(req.method)) throw new HttpError(405, 'This request method is not supported.');
      if (!await rateLimit(req, url.pathname)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
      const {auth, oauth, jira, delivery} = await getServices();
      if (url.pathname === '/v1/oauth/start') {
        const input = await readBody(req);
        if (originId && input.extensionId !== originId) throw new HttpError(403, 'Start the connection from the same Diffuse extension.');
        return json(res, 200, await auth.start({challenge: input.challenge, extensionId: input.extensionId}));
      }
      if (url.pathname === '/v1/oauth/complete') {
        const input = await readBody(req);
        return json(res, 200, await auth.complete({code: input.code, verifier: input.verifier}));
      }
      if (url.pathname === '/oauth/jira/callback') {
        const {redirectUrl} = await auth.callback({state: one(url.searchParams, 'state'), code: one(url.searchParams, 'code', false), error: one(url.searchParams, 'error', false)});
        // Defense in depth: even a service bug must not create an open redirect.
        const redirect = new URL(redirectUrl);
        const id = redirect.hostname.replace(/\.chromiumapp\.org$/, '');
        if (!extensions.has(id) || redirect.protocol !== 'https:' || redirect.hostname !== `${id}.chromiumapp.org` || redirect.pathname !== '/jira' || redirect.port || redirect.username || redirect.password || redirect.hash) throw new Error('Invalid callback');
        res.statusCode = 302; res.setHeader('Location', redirect.href); return res.end();
      }
      const token = credential(req);
      if (url.pathname === '/v1/connection') return json(res, 200, req.method === 'DELETE' ? await auth.disconnect(token) : {connection: await auth.authenticate(token)});
      if (url.pathname === '/v1/sites') return json(res, 200, await auth.withAccessToken(token, async accessToken => ({sites: await oauth.discoverResources({accessToken})})));
      if (url.pathname === '/v1/deliveries') {
        const input = await readBody(req, 300 * 1024);
        return json(res, 200, await auth.withAccessToken(token, (accessToken, connection) => delivery.prepare({connection, accessToken, request: input})));
      }
      if (deliveryPathValid) {
        const [, id, operation, attachmentId] = deliveryRoute;
        if (!operation) return json(res, 200, await delivery.get({connection: await auth.authenticate(token), id}));
        const input = await readBody(req, operation === 'chunks' ? 720 * 1024 : MAX_JSON);
        if (operation === 'chunks') return json(res, 200, await delivery.putChunk({connection: await auth.authenticate(token), id, attachmentId: input.attachmentId, index: input.index, dataBase64: input.dataBase64}));
        const result = await auth.withAccessToken(token, (accessToken, connection) => operation === 'issue'
          ? delivery.sendIssue({connection, accessToken, id})
          : delivery.sendAttachment({connection, accessToken, id, attachmentId}));
        return json(res, 200, result);
      }
      const cloudId = one(url.searchParams, 'site');
      const start = one(url.searchParams, 'startAt', false) || '0';
      if (!/^(0|[1-9]\d{0,5})$/.test(start)) throw new HttpError(400, 'The requested page is invalid.');
      const result = await auth.withAccessToken(token, async accessToken => {
        const sites = await oauth.discoverResources({accessToken});
        if (!sites.some(site => site.id === cloudId)) throw new HttpError(403, 'This site is not available to the selected Jira account.');
        const input = {accessToken, cloudId, startAt: Number(start)};
        if (url.pathname === '/v1/projects') return jira.listProjects(input);
        if (url.pathname === '/v1/attachment-settings') return jira.attachmentSettings(input);
        input.projectId = one(url.searchParams, 'project');
        if (url.pathname === '/v1/issue-types') return jira.listIssueTypes(input);
        return jira.getCreateFields({...input, issueTypeId: one(url.searchParams, 'issueType')});
      });
      return json(res, 200, result);
    } catch (error) {
      const failure = safeFailure(error);
      // Never log a request URL, provider body, credential or underlying database error.
      return json(res, failure.status, {error: failure.message, ...(failure.code ? {code: failure.code} : {})});
    }
  };
}
