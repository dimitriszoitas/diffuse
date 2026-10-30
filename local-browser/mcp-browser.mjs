import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { collectStyles, collectPage, hoverCandidates, hoverState, focusState, axeSummary } from './collectors.mjs';

const require = createRequire(import.meta.url);
const MCP_CLI = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
const MAX_TOOL_BYTES = 5 * 1024 * 1024;

export function parseToolResult(result) {
  if (result.isError) throw new Error('The browser could not complete this check. The page may have changed or closed.');
  const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
  if (text.length > MAX_TOOL_BYTES) throw new Error('Browser result exceeded the local evidence limit.');
  // MCP versions wrap the JSON payload in a result section. Never evaluate it.
  const marker = text.match(/### (?:Result|Evaluation result)\s*\n/);
  const body = marker ? text.slice(marker.index + marker[0].length).split(/\n### /)[0].trim() : text.trim();
  try { return JSON.parse(body); } catch {}
  const fenced = body.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  throw new Error('The local browser returned an unreadable result.');
}

export class McpBrowser {
  constructor({ directory, headless = false, executablePath, callTimeout = 25000 }) {
    this.directory = directory; this.headless = headless; this.executablePath = executablePath; this.callTimeout = callTimeout;
    this.controller = new AbortController(); this.closed = false;
  }
  async connect() {
    if (this.closed) throw new Error('The audit was stopped.');
    await mkdir(join(this.directory, 'profile'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, 'mcp-output'), { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error('The audit was stopped.');
    const args = [MCP_CLI, '--browser', 'chromium', '--user-data-dir', join(this.directory, 'profile'), '--output-dir', join(this.directory, 'mcp-output'), '--output-max-size', '16777216', '--snapshot-mode', 'none', '--no-webmcp', '--block-service-workers', '--timeout-navigation', '20000', '--timeout-action', '3000', '--timeout-settle', '200', '--viewport-size', '1280,900', '--codegen', 'none'];
    if (this.headless) args.push('--headless');
    if (this.executablePath) args.push('--executable-path', this.executablePath);
    this.transport = new StdioClientTransport({ command: process.execPath, args, cwd: this.directory, stderr: 'pipe', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' } });
    this.client = new Client({ name: 'diffuse-local-audit', version: '0.1.0' }, { capabilities: {} });
    // Do not log MCP stderr: page diagnostics can contain sensitive data.
    this.transport.stderr?.resume();
    await this.client.connect(this.transport, { timeout: this.callTimeout });
    if (this.closed) { await this.transport.close(); throw new Error('The audit was stopped.'); }
    const { tools } = await this.client.listTools({}, { signal: this.controller.signal, timeout: this.callTimeout });
    this.toolNames = new Set(tools.map(t => t.name));
    this.codeTool = this.toolNames.has('browser_run_code_unsafe') ? 'browser_run_code_unsafe' : 'browser_run_code';
    if (!this.toolNames.has(this.codeTool)) throw new Error('The installed Playwright MCP version is missing the local audit tool.');
  }
  async call(name, args) {
    if (this.closed || this.controller.signal.aborted) throw new Error('The audit was stopped.');
    try { return await this.client.callTool({ name, arguments: args }, undefined, { signal: this.controller.signal, timeout: this.callTimeout }); }
    catch (error) { await this.close(); throw error; }
  }
  async code(code) { return parseToolResult(await this.call(this.codeTool, { code })); }
  async evaluate(fn, argument) {
    return this.code(`async (page) => { return await page.evaluate(${fn.toString()}, ${JSON.stringify(argument ?? null)}); }`);
  }
  async navigate(url) {
    const result = await this.call('browser_navigate', { url });
    if (result.isError) throw new Error('The browser could not open that website.');
    return this.evaluate(collectPage);
  }
  async approveOrigin(origin) {
    // This fixed closure is installed in the MCP process, outside the page realm.
    // All new top-level navigation is blocked during current-page collection.
    // Blocking before dispatch also prevents redirect chains from leaving scope.
    // Normal asset/API requests continue.
    return this.code(`async (page) => {
      const origin = ${JSON.stringify(origin)};
      if (new URL(page.url()).origin !== origin) throw new Error('Return to the approved website before running the audit.');
      page.__diffuseErrorCount = (await page.consoleMessages()).filter(message => message.type() === 'error').length + (await page.pageErrors()).length;
      page.on('pageerror', () => page.__diffuseErrorCount++);
      page.on('console', message => { if (message.type() === 'error') page.__diffuseErrorCount++; });
      page.context().on('page', popup => { if (popup !== page) popup.close().catch(() => {}); });
      await page.context().route('**/*', route => {
        const request = route.request();
        if (request.isNavigationRequest() && !request.frame().parentFrame()) return route.abort('blockedbyclient');
        return route.continue();
      });
      return { approved: true };
    }`);
  }
  async assertOrigin(origin) {
    return this.code(`async (page) => { if (new URL(page.url()).origin !== ${JSON.stringify(origin)}) throw new Error('The page left the approved website.'); return true; }`);
  }
  async styles() { return this.evaluate(collectStyles); }
  async accessibility() {
    const source = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
    return this.code(`async (page) => {
      await page.evaluate(${JSON.stringify(source)});
      return await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ['violations', 'incomplete', 'passes', 'inapplicable'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        return (${axeSummary.toString()})(result);
      });
    }`);
  }
  async interactions(origin, record) {
    const result = { hover: [], focus: [], limitations: ['Samples up to three visible controls and six Tab presses from the current focus position.', 'A style change is recorded evidence, not proof that a hover or focus state is usable.', 'No controls are clicked, activated, submitted, or typed into. Existing page handlers may react to hover or focus.'] };
    const candidates = await this.evaluate(hoverCandidates);
    for (const target of candidates.filter(t => Number.isFinite(t.x) && Number.isFinite(t.y) && t.x >= 0 && t.y >= 0 && t.x <= 16000 && t.y <= 16000).slice(0, 3)) {
      await this.assertOrigin(origin);
      const before = await this.evaluate(hoverState, target);
      await this.code(`async (page) => { await page.mouse.move(${target.x}, ${target.y}); return true; }`);
      const after = await this.evaluate(hoverState, target);
      result.hover.push({ target: target.name, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) });
      await record(result);
    }
    for (let index = 0; index < 6; index++) {
      await this.assertOrigin(origin);
      await this.call('browser_press_key', { key: 'Tab' });
      result.focus.push(await this.evaluate(focusState));
      await record(result);
    }
    return result;
  }
  async screenshot(label = 'Audited viewport') {
    const dimensions = await this.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const result = await this.call('browser_take_screenshot', { type: 'jpeg', fullPage: false, scale: 'css' });
    if (result.isError) throw new Error('The local browser could not capture the screenshot.');
    const image = result.content?.find(c => c.type === 'image' && c.mimeType === 'image/jpeg');
    if (!image || image.data.length > 2 * 1024 * 1024) throw new Error('Screenshot unavailable or larger than the local evidence limit.');
    return { label, dataUrl: `data:image/jpeg;base64,${image.data}`, width: dimensions.width, height: dimensions.height };
  }
  async console() { return this.code('async (page) => ({ errorCount: Math.min(page.__diffuseErrorCount || 0, 10000) })'); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.controller.abort();
    this.closePromise = (async () => { try { await this.client?.close(); } finally { await this.transport?.close(); } })();
    return this.closePromise;
  }
}
