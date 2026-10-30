import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { McpBrowser } from './mcp-browser.mjs';

export const PORT = 8932;
export const EXTENSION_ORIGIN = 'chrome-extension://gdoidkknjbnfmeikloaafdohpjlafgbj';
const MAX_BODY = 16 * 1024;
const MAX_JOB_BYTES = 7 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'stopped', 'error']);
const now = () => new Date().toISOString();

export function normalizeAuditRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['url', 'checks'].includes(k))) throw new Error('Choose a website URL and audit checks.');
  if (typeof value.url !== 'string' || value.url.length > 4000) throw new Error('Enter a website URL.');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Enter a valid website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS websites without embedded credentials can be audited.');
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === String(PORT)) throw new Error('The companion cannot audit itself.');
  const input = value.checks;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['styles', 'accessibility', 'interactions'].includes(k))) throw new Error('Choose supported audit checks.');
  const checks = Object.fromEntries(['styles', 'accessibility', 'interactions'].map(key => [key, input[key] === true]));
  if (!Object.values(checks).some(Boolean)) throw new Error('Choose at least one audit check.');
  return { url: url.href, origin: url.origin, checks };
}

export async function loadPairingToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'pairing-token');
  let token;
  try { token = (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('base64url');
    await writeFile(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('The local pairing token is invalid. Remove pairing-token and restart to pair again.');
  await chmod(path, 0o600);
  return token;
}

export function isAuthorized(request, token, port = PORT, allowedOrigin = EXTENSION_ORIGIN) {
  if (request.headers.host !== `127.0.0.1:${port}`) return false;
  if (request.headers.origin && request.headers.origin !== allowedOrigin) return false;
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class AuditManager {
  constructor({ directory, browserFactory = options => new McpBrowser(options), headless = false, executablePath, maxDurationMs = 120000 }) {
    this.directory = directory; this.browserFactory = browserFactory; this.headless = headless; this.executablePath = executablePath; this.maxDurationMs = maxDurationMs;
    this.jobs = new Map(); this.active = null;
  }
  async initialize() {
    await mkdir(join(this.directory, 'audits'), { recursive: true, mode: 0o700 });
    const files = (await readdir(join(this.directory, 'audits'))).filter(f => /^[\da-f-]{36}\.json$/.test(f)).sort().slice(-100);
    for (const file of files) {
      try {
        const source = await readFile(join(this.directory, 'audits', file), 'utf8');
        if (source.length > MAX_JOB_BYTES) continue;
        const job = JSON.parse(source);
        if (job.id !== file.slice(0, -5)) continue;
        if (!TERMINAL.has(job.status)) {
          job.status = 'stopped'; job.error = 'The local companion closed before this audit finished. Collected evidence was preserved.';
          for (const step of job.steps || []) if (step.status === 'running') { step.status = 'stopped'; step.completedAt = now(); }
        }
        this.jobs.set(job.id, job);
      } catch { /* An incomplete local write must not hide other saved audits. */ }
    }
  }
  async save(job) {
    job.updatedAt = now();
    let data = JSON.stringify(job);
    if (Buffer.byteLength(data) > MAX_JOB_BYTES && job.evidence?.screenshots?.length > 1) {
      job.evidence.screenshots = job.evidence.screenshots.slice(0, 1);
      job.evidence.limitations.push('The final screenshot was omitted to keep the saved audit within its local storage limit.');
      data = JSON.stringify(job);
    }
    if (Buffer.byteLength(data) > MAX_JOB_BYTES) throw new Error('The audit reached the local evidence storage limit.');
    const path = join(this.directory, 'audits', `${job.id}.json`);
    // Serialized saves prevent older evidence from overwriting a later stop.
    this.saveQueue = (this.saveQueue || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, data, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    await this.saveQueue;
  }
  async create(input) {
    if (this.active) throw Object.assign(new Error('Finish or stop the current local audit before opening another.'), { status: 409 });
    const request = normalizeAuditRequest(input);
    const job = { id: randomUUID(), status: 'opening', checks: request.checks, steps: [], createdAt: now(), updatedAt: now(), page: { url: `${request.origin}${new URL(request.url).pathname}` } };
    const browser = this.browserFactory({ directory: this.directory, headless: this.headless, executablePath: this.executablePath });
    const active = { job, browser, origin: request.origin, cancelled: false };
    this.jobs.set(job.id, job); this.active = active;
    await this.save(job);
    active.work = this.open(active, request.url);
    return job;
  }
  async step(active, action, description, task) {
    if (active.cancelled) throw new Error('The audit was stopped.');
    const step = { id: active.job.steps.length + 1, action, description, status: 'running', startedAt: now() };
    active.job.steps.push(step); await this.save(active.job);
    try {
      const result = await task();
      if (active.cancelled) throw new Error('The audit was stopped.');
      step.status = 'completed'; step.completedAt = now(); await this.save(active.job);
      return result;
    } catch (error) {
      step.status = active.cancelled ? 'stopped' : 'error'; step.completedAt = now();
      await this.save(active.job); throw error;
    }
  }
  async open(active, url) {
    try {
      active.job.page = await this.step(active, 'open', 'Open the approved website in the local audit browser.', async () => {
        await active.browser.connect();
        return active.browser.navigate(url);
      });
      if (!active.cancelled) { active.job.status = 'ready'; await this.save(active.job); }
    } catch (error) { await this.fail(active, 'Could not open the local audit browser. Check that Chromium is installed and the website is reachable.'); }
  }
  async run(id) {
    const active = this.active;
    if (!active || active.job.id !== id || active.job.status !== 'ready') throw Object.assign(new Error('This audit is not ready to run.'), { status: 409 });
    active.job.status = 'running'; await this.save(active.job);
    active.work = this.collect(active);
    return active.job;
  }
  async collect(active) {
    const job = active.job;
    const timer = setTimeout(() => { this.stop(job.id, 'The local audit reached its two-minute collection limit. Partial evidence was preserved.').catch(() => {}); }, this.maxDurationMs);
    timer.unref?.();
    try {
      await this.step(active, 'scope', 'Verify that the current page belongs to the approved website.', () => active.browser.approveOrigin(active.origin));
      job.page = await active.browser.evaluate(collectPageForServer);
      job.evidence = { version: 1, engine: 'playwright-mcp', scope: 'current-page', page: job.page, screenshots: [], limitations: ['This audit covers the current rendered page, not every route or component state.', 'Page text and screenshots may contain private information. Review the evidence before sending it to AI.', 'No video recording is captured by this audit.'] };
      await this.save(job);
      job.evidence.screenshots.push(await this.step(active, 'screenshot', 'Capture the page before checks begin.', () => active.browser.screenshot('Before checks')));
      await this.save(job);
      if (job.checks.styles) {
        await active.browser.assertOrigin(active.origin);
        job.evidence.styles = await this.step(active, 'styles', 'Measure rendered typography, colors, spacing, and corner radii.', () => active.browser.styles());
        await this.save(job);
      }
      if (job.checks.accessibility) {
        await active.browser.assertOrigin(active.origin);
        job.evidence.accessibility = await this.step(active, 'accessibility', 'Run automated accessibility checks with axe-core.', () => active.browser.accessibility());
        await this.save(job);
      }
      if (job.checks.interactions) {
        job.evidence.interactions = await this.step(active, 'interactions', 'Sample hover states and keyboard Tab focus without activating controls.', () => active.browser.interactions(active.origin, async partial => {
          if (!active.cancelled) { job.evidence.interactions = structuredClone(partial); await this.save(job); }
        }));
      }
      await active.browser.assertOrigin(active.origin);
      if (job.checks.interactions) job.evidence.screenshots.push(await this.step(active, 'screenshot', 'Capture the page after interaction checks.', () => active.browser.screenshot('After interaction checks')));
      job.evidence.console = await active.browser.console();
      if (!active.cancelled) job.status = 'completed';
      await this.save(job);
    } catch (error) { await this.fail(active, 'The audit could not finish. The page may have left the approved website, changed, or closed. Collected evidence was preserved.'); }
    finally { clearTimeout(timer); await active.browser.close(); if (this.active === active) this.active = null; }
  }
  async fail(active, message) {
    if (!active.cancelled) { active.job.status = 'error'; active.job.error = message; await this.save(active.job); }
    await active.browser.close();
    if (this.active === active) this.active = null;
  }
  async stop(id, reason = 'You stopped this audit. Collected evidence was preserved.') {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error('Audit not found.'), { status: 404 });
    const active = this.active;
    if (!active || active.job.id !== id || TERMINAL.has(job.status)) return job;
    active.cancelled = true; job.status = 'stopped'; job.error = reason;
    for (const step of job.steps) if (step.status === 'running') { step.status = 'stopped'; step.completedAt = now(); }
    await this.save(job);
    await active.browser.close();
    if (this.active === active) this.active = null;
    return job;
  }
  async close() { if (this.active) await this.stop(this.active.job.id, 'The local companion closed. Collected evidence was preserved.'); await this.saveQueue; }
}

function collectPageForServer() {
  const url = new URL(location.href);
  return { url: `${url.origin}${url.pathname}`, title: document.title.slice(0, 200), viewport: { width: innerWidth, height: innerHeight }, capturedAt: new Date().toISOString() };
}

async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw Object.assign(new Error('Use application/json.'), { status: 415 });
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }); }
}

export async function createCompanion({ directory = join(dirname(fileURLToPath(import.meta.url)), '.local'), port = PORT, allowedOrigin = EXTENSION_ORIGIN, browserFactory, headless, executablePath } = {}) {
  const token = await loadPairingToken(directory);
  const manager = new AuditManager({ directory, browserFactory, headless, executablePath });
  await manager.initialize();
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
    const actualPort = server.address()?.port || port;
    const origin = request.headers.origin;
    if (request.headers.host !== `127.0.0.1:${actualPort}` || (origin && origin !== allowedOrigin)) return send(403, { error: 'This client is not allowed.' });
    if (origin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    // Browser preflight has no bearer header. Only the exact installed extension
    // origin can receive it; every actual endpoint still requires pairing.
    if (request.method === 'OPTIONS') return origin === allowedOrigin ? send(204, null) : send(403, { error: 'This client is not allowed.' });
    if (!isAuthorized(request, token, actualPort, allowedOrigin)) return send(401, { error: 'Pair Diffuse with this local companion first.' });
    try {
      if (request.method === 'GET' && request.url === '/health') return send(200, { ok: true, name: 'diffuse-local-browser', version: '0.1.0', engine: 'playwright-mcp', currentPageOnly: true, activeAuditId: manager.active?.job.id || null });
      if (request.method === 'POST' && request.url === '/audits') return send(202, { audit: await manager.create(await body(request)) });
      const match = request.url?.match(/^\/audits\/([\da-f-]{36})(?:\/(run|stop))?$/);
      if (!match) return send(404, { error: 'Endpoint not found.' });
      if (request.method === 'GET' && !match[2]) {
        const job = manager.jobs.get(match[1]); return job ? send(200, { audit: job }) : send(404, { error: 'Audit not found.' });
      }
      if (request.method === 'POST' && ['run', 'stop'].includes(match[2])) {
        const input = await body(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return send(400, { error: 'This action takes no additional arguments.' });
        return send(200, { audit: await manager[match[2]](match[1]) });
      }
      return send(405, { error: 'Method not allowed.' });
    } catch (error) { return send(error.status || 400, { error: error.message || 'The local audit could not complete this request.' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 30;
  return { server, manager, token, directory, async listen() { await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); return server.address(); }, async close() { await manager.close(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const companion = await createCompanion();
  await companion.listen();
  console.log(`Diffuse local browser is ready at http://127.0.0.1:${PORT}.\nPairing token: ${join(companion.directory, 'pairing-token')}\nKeep this terminal running. No AI provider is contacted by this companion.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await companion.close(); process.exit(0); });
}
