import {timingSafeEqual} from 'node:crypto';

export function createPrivacyCronHandler({run, secret} = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const reply = (status, body) => {res.statusCode = status; res.end(JSON.stringify(body));};
    if (typeof secret !== 'string' || secret.length < 32 || typeof run !== 'function') return reply(503, {error: 'Scheduled maintenance is unavailable.'});
    const supplied = req.headers?.authorization;
    const expected = Buffer.from(`Bearer ${secret}`);
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== expected.length || !timingSafeEqual(Buffer.from(supplied), expected)) return reply(401, {error: 'Unauthorized.'});
    if (req.method !== 'GET') return reply(405, {error: 'Method not allowed.'});
    try {
      const result = await run();
      // Return only aggregate counters; never serialize account IDs or provider errors.
      const counts = Object.fromEntries(Object.entries(result || {}).filter(([name, value]) => ['selected', 'reported', 'erasedAccounts', 'erasedConnections', 'failed'].includes(name) && Number.isSafeInteger(value) && value >= 0));
      const status = ['busy', 'deferred', 'idle', 'complete', 'partial', 'failed'].includes(result?.status) ? result.status : 'failed';
      return reply(['partial', 'failed'].includes(status) ? 503 : 200, {status, counts});
    } catch {
      return reply(503, {error: 'Scheduled maintenance could not finish.'});
    }
  };
}
