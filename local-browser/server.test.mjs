import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditManager, createCompanion, EXTENSION_ORIGIN, isAuthorized, loadPairingToken, normalizeAuditRequest } from './server.mjs';
import { McpBrowser, parseToolResult } from './mcp-browser.mjs';

const temporary = () => mkdtemp(join(tmpdir(), 'diffuse-companion-test-'));
const fixtureRequest = { url: 'https://example.test/page?q=private#part', checks: { styles: true, accessibility: false, interactions: false } };
class FakeBrowser {
  async connect() {}
  async navigate() { return { url: 'https://example.test/page', title: 'Fixture' }; }
  async evaluate() { return { url: 'https://example.test/page', title: 'Fixture' }; }
  async approveOrigin() {}
  async assertOrigin() {}
  async styles() { return { typography: [{ fontSize: '23px', count: 1 }], elementsInspected: 1 }; }
  async accessibility() { return { violations: [], incomplete: [], passesCount: 1 }; }
  async screenshot() { return { label: 'Viewport', dataUrl: 'data:image/jpeg;base64,AA==' }; }
  async console() { return { errorCount: 0 }; }
  async close() { this.closed = true; }
}
const settle = async manager => { const current = manager.active; if (current) await current.work; };

test('only bounded HTTP URLs and a fixed check set are accepted', () => {
  assert.equal(normalizeAuditRequest(fixtureRequest).origin, 'https://example.test');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://a:b@example.test', 'http://127.0.0.1:8932/health']) assert.throws(() => normalizeAuditRequest({ ...fixtureRequest, url }));
  assert.throws(() => normalizeAuditRequest({ ...fixtureRequest, code: 'page.click()' }));
  assert.throws(() => normalizeAuditRequest({ ...fixtureRequest, checks: { execute: true } }));
  assert.throws(() => normalizeAuditRequest({ ...fixtureRequest, checks: {} }));
});

test('pairing token persists with owner-only permissions', async () => {
  const directory = await temporary();
  try {
    const first = await loadPairingToken(directory);
    assert.equal(first.length, 43); assert.equal(await loadPairingToken(directory), first);
    assert.equal((await stat(join(directory, 'pairing-token'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('authorization requires exact loopback Host, installed extension Origin, and bearer', () => {
  const good = { host: '127.0.0.1:8932', origin: EXTENSION_ORIGIN, authorization: 'Bearer pairing' };
  assert.equal(isAuthorized({ headers: good }, 'pairing'), true);
  for (const change of [{ host: 'evil.test:8932' }, { host: 'localhost:8932' }, { origin: 'null' }, { origin: 'https://attacker.test' }, { authorization: 'Bearer wrong' }, { authorization: '' }]) assert.equal(isAuthorized({ headers: { ...good, ...change } }, 'pairing'), false);
});

test('MCP result parsing is JSON only and rejects errors or oversized results', () => {
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '### Result\n{"ok":true}\n### Ran Playwright code\n...' }] }), { ok: true });
  assert.throws(() => parseToolResult({ content: [{ type: 'text', text: 'process.exit()' }] }));
  assert.throws(() => parseToolResult({ isError: true, content: [] }));
  assert.throws(() => parseToolResult({ content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }] }));
});

test('cancellation before MCP initialization cannot launch an orphan process', async () => {
  const directory = await temporary();
  try {
    const browser = new McpBrowser({ directory }); await browser.close();
    await assert.rejects(browser.connect(), /stopped/);
    assert.equal(browser.transport, undefined);
    const racing = new McpBrowser({ directory });
    const starting = racing.connect(); await racing.close();
    await assert.rejects(starting, /stopped/);
    assert.equal(racing.transport, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('opening waits for an explicit run and records all completed stages locally', async () => {
  const directory = await temporary();
  const manager = new AuditManager({ directory, browserFactory: () => new FakeBrowser() });
  try {
    await manager.initialize(); const job = await manager.create(fixtureRequest); await settle(manager);
    assert.equal(job.status, 'ready'); assert.equal(job.evidence, undefined);
    assert.equal(job.page.url, 'https://example.test/page');
    await assert.rejects(manager.create(fixtureRequest), /current local audit/);
    await manager.run(job.id); await settle(manager);
    assert.equal(job.status, 'completed'); assert.equal(manager.active, null);
    assert.equal(job.evidence.styles.typography[0].fontSize, '23px');
    assert.equal(job.evidence.screenshots.length, 1);
    assert.ok(job.steps.every(step => step.status === 'completed'));
    const saved = JSON.parse(await readFile(join(directory, 'audits', `${job.id}.json`)));
    assert.equal(saved.status, 'completed'); assert.equal(saved.steps.length, 4);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stop interrupts a hanging stage, preserves earlier evidence, and frees the browser only after close', async () => {
  const directory = await temporary();
  let rejectAxe, started;
  const axeStarted = new Promise(resolve => { started = resolve; });
  const browser = new FakeBrowser();
  browser.accessibility = () => { started(); return new Promise((_, reject) => { rejectAxe = reject; }); };
  browser.close = async () => { browser.closed = true; rejectAxe?.(new Error('cancelled')); };
  const manager = new AuditManager({ directory, browserFactory: () => browser });
  try {
    await manager.initialize(); const job = await manager.create({ ...fixtureRequest, checks: { styles: true, accessibility: true } }); await settle(manager);
    await manager.run(job.id); const work = manager.active.work; await axeStarted;
    await manager.stop(job.id); await work;
    assert.equal(job.status, 'stopped'); assert.equal(browser.closed, true); assert.equal(manager.active, null);
    assert.equal(job.evidence.styles.typography[0].fontSize, '23px');
    assert.equal(job.steps.at(-1).status, 'stopped');
    assert.equal(JSON.parse(await readFile(join(directory, 'audits', `${job.id}.json`))).status, 'stopped');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a restart exposes interrupted work as stopped with its saved partial evidence', async () => {
  const directory = await temporary(), id = '00000000-0000-4000-8000-000000000001';
  try {
    await mkdir(join(directory, 'audits'));
    await writeFile(join(directory, 'audits', `${id}.json`), JSON.stringify({ id, status: 'running', steps: [{ status: 'running' }], evidence: { styles: { elementsInspected: 3 } } }));
    const manager = new AuditManager({ directory }); await manager.initialize();
    const job = manager.jobs.get(id);
    assert.equal(job.status, 'stopped'); assert.equal(job.evidence.styles.elementsInspected, 3); assert.equal(job.steps[0].status, 'stopped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same-origin verification errors preserve the trace and never proceed to collection', async () => {
  const directory = await temporary(); let collected = false;
  const browser = new FakeBrowser(); browser.approveOrigin = async () => { throw new Error('wrong origin'); }; browser.styles = async () => { collected = true; };
  const manager = new AuditManager({ directory, browserFactory: () => browser });
  try {
    await manager.initialize(); const job = await manager.create(fixtureRequest); await settle(manager);
    await manager.run(job.id); await settle(manager);
    assert.equal(job.status, 'error'); assert.equal(collected, false); assert.equal(job.steps.at(-1).status, 'error');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP surface has no generic tools and enforces authentication, origin and JSON bounds', async () => {
  const directory = await temporary(); const companion = await createCompanion({ directory, port: 0, browserFactory: () => new FakeBrowser() });
  try {
    const address = await companion.listen(), base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${companion.token}`, Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${base}/tools/call`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/audits`, { method: 'POST', headers, body: JSON.stringify({ ...fixtureRequest, url: 'x'.repeat(18000) }) })).status, 413);
    const response = await fetch(`${base}/audits`, { method: 'POST', headers, body: JSON.stringify(fixtureRequest) });
    assert.equal(response.status, 202);
    const { audit } = await response.json();
    assert.match(audit.id, /^[\da-f-]{36}$/);
    const stop = await fetch(`${base}/audits/${audit.id}/stop`, { method: 'POST', headers, body: '{}' });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).audit.status, 'stopped');
  } finally { await companion.close(); await rm(directory, { recursive: true, force: true }); }
});
