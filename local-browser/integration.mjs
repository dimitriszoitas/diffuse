// Real MCP integration verification, using only disposable local fixtures and a
// fresh temporary browser profile. Never connects to a personal browser session.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, EXTENSION_ORIGIN } from './server.mjs';
import { McpBrowser } from './mcp-browser.mjs';

const directory = await mkdtemp(join(tmpdir(), 'diffuse-mcp-integration-'));
let rejectedNavigationHits = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === '/outside') rejectedNavigationHits++;
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html lang="en"><head><title>Diffuse local audit fixture</title><style>
  body{font:16px Arial;padding:24px;color:#112233;background:#fff} h1{font-size:32px;line-height:40px}h2{font-size:23px;line-height:30px}button{padding:12px 24px;border-radius:8px;background:#eee;color:#111}button:hover{background:#123456;color:white}button:focus-visible{outline:3px solid #00f} .bad{color:#ddd;background:#fff}
  </style></head><body><main><h1>Account settings</h1><h2>Different heading</h2><button>Save preferences</button><a href="#more">More information</a><input><p class="bad">Low contrast text</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><div id="more">Details</div></main></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const companion = await createCompanion({ directory, port: 0, headless: true, executablePath: process.env.DIFFUSE_TEST_BROWSER || undefined });
const address = await companion.listen();
const headers = { Authorization: `Bearer ${companion.token}`, Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json' };
const base = `http://127.0.0.1:${address.port}`;
const request = async (path, data) => {
  const response = await fetch(`${base}${path}`, { method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
};
const waitFor = async (id, statuses) => {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const { audit } = await request(`/audits/${id}`);
    if (statuses.includes(audit.status)) return audit;
    if (['error', 'stopped'].includes(audit.status)) throw new Error(`Audit ${audit.status}: ${audit.error}; ${JSON.stringify(audit.steps)}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Audit fixture timed out');
};
try {
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  const { audit: opened } = await request('/audits', { url: `http://127.0.0.1:${fixture.address().port}/`, checks: { styles: true, accessibility: true, interactions: true } });
  await waitFor(opened.id, ['ready']);
  await request(`/audits/${opened.id}/run`, {});
  const completed = await waitFor(opened.id, ['completed']);
  assert.ok(completed.evidence.styles.typography.some(style => style.fontSize === '23px'));
  assert.ok(completed.evidence.accessibility.violations.some(issue => issue.id === 'label'));
  assert.ok(completed.evidence.accessibility.violations.some(issue => issue.id === 'color-contrast'));
  assert.ok(completed.evidence.interactions.hover.some(sample => sample.changed));
  assert.equal(completed.evidence.interactions.focus.length, 6);
  assert.match(completed.evidence.screenshots[0].dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(completed.evidence.screenshots.length, 2);
  assert.equal(completed.evidence.screenshots[0].width, 1280);
  assert.equal(completed.evidence.screenshots[0].height, 900);
  assert.equal(JSON.parse(await readFile(join(directory, 'audits', `${completed.id}.json`))).status, 'completed');
  // Verify fixed collection scope before dispatching a navigation, then interrupt
  // an actual in-flight MCP call and prove its dedicated profile can be reopened.
  const probeOptions = { directory: join(directory, 'cancellation-probe'), headless: true, executablePath: process.env.DIFFUSE_TEST_BROWSER || undefined };
  const probe = new McpBrowser(probeOptions);
  const fixtureURL = `http://127.0.0.1:${fixture.address().port}/`;
  await probe.connect(); await probe.navigate(fixtureURL); await probe.approveOrigin(new URL(fixtureURL).origin);
  const forbidden = await probe.call('browser_navigate', { url: `${fixtureURL}outside` });
  assert.equal(forbidden.isError, true); assert.equal(rejectedNavigationHits, 0);
  const pid = probe.transport.pid;
  const pending = probe.code('async () => { await new Promise(() => {}); return null; }').then(() => ({ resolved: true }), error => ({ error: error.message }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const stopStarted = Date.now(); await probe.close();
  assert.ok((await pending).error); assert.ok(Date.now() - stopStarted < 7000);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const reopened = new McpBrowser(probeOptions);
  try { await reopened.connect(); await reopened.navigate(fixtureURL); } finally { await reopened.close(); }
  console.log(JSON.stringify({ status: completed.status, steps: completed.steps.length, typographyGroups: completed.evidence.styles.typography.length, violations: completed.evidence.accessibility.violations.map(issue => issue.id), hoverSamples: completed.evidence.interactions.hover.length, focusSamples: completed.evidence.interactions.focus.length, screenshots: completed.evidence.screenshots.length, blockedNavigation: true, inFlightCancellation: true, profileReuse: true }));
} finally {
  await companion.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
