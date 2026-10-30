// Disposable profile, fictional evidence and blocked network. No live AI call.
import assert from 'node:assert/strict';
import {mkdtemp, cp, mkdir, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'diffuse-browser-audit-report-'));
const extension = join(directory, 'extension');
const artifacts = join(root, 'artifacts', 'browser-audit-reports');
await mkdir(artifacts, {recursive: true});
await cp(join(root, 'extension'), extension, {recursive: true});
let context;
const errors = [], requests = [];
try {
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {executablePath: chromium.executablePath(), headless: true, viewport: {width: 1440, height: 1000}, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-mock-keychain', '--password-store=basic']});
  await context.route(/^https?:\/\//, route => { requests.push(route.request().url()); return route.abort(); });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(`${base}/report.html`);
  const saved = await page.evaluate(async () => {
    const {ensureReview} = await import(chrome.runtime.getURL('review-store.mjs'));
    const {saveBrowserAudit, listBrowserAudits, getBrowserAudit} = await import(chrome.runtime.getURL('browser-audit-store.mjs'));
    await ensureReview({id: 'audit-review', title: 'Fictional ingredient audit', mode: 'audit', productionUrl: 'https://fixture.example.test/ingredients', createdAt: '2026-10-28T10:00:00Z'});
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#182633'; ctx.fillRect(0, 0, 1000, 300); ctx.fillStyle = '#e7edf5'; ctx.font = '30px sans-serif'; ctx.fillText('Ingredients · fictional audit fixture', 40, 80); ctx.font = '18px sans-serif'; ctx.fillText('New ingredient', 40, 160);
    for (let index = 0; index < 12; index++) {
      await saveBrowserAudit({id: `audit-${index}`, reviewId: 'audit-review', status: index === 11 ? 'stopped' : 'completed', createdAt: new Date(Date.UTC(2026, 9, 28, 10, index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 28, 10, index)).toISOString(),
        page: {title: 'Ingredient library', url: 'https://fixture.example.test/ingredients'}, error: index === 11 ? 'Stopped by reviewer' : undefined,
        steps: [{id: 'styles', action: 'measure', description: 'Measure typography and component styles', status: 'completed', startedAt: '2026-10-28T10:00:00Z', completedAt: '2026-10-28T10:00:03Z', details: 'Inspected the current page.'}, {id: 'keyboard', action: 'keyboard', description: 'Inspect focus sequence', status: 'completed', details: 'Focused four controls without activating them.'}],
        evidence: {scope: 'current-page', styles: {elementsInspected: 17, typography: [{fontFamily: 'Inter, sans-serif', fontSize: '23px', fontWeight: '600', lineHeight: '30px', color: '#111111', count: 3, examples: [{selector: '.ingredient-card h2', text: 'Oat flour', rect: {x: 30, y: 160, width: 140, height: 30}}]}], colors: [{property: 'color', value: '#111111', count: 12}], spacing: [{property: 'padding', value: '16px', count: 4}], radii: [{value: '8px', count: 4}]}, accessibility: {engine: 'axe-core', version: 'fixture', violations: [{id: 'color-contrast', impact: 'serious', help: 'Text needs sufficient contrast', description: 'One example requires a contrast correction', nodes: [{target: ['.hint'], failureSummary: 'Contrast ratio is too low', html: '<p class="hint">Instructions</p>'}]}], incomplete: [{id: 'landmark', help: 'Confirm landmark structure'}], passesCount: 12, limitations: ['Screen-reader use was not tested.']}, interactions: {hover: [{target: '#new', changed: true, before: {color: 'white'}, after: {color: 'blue'}}], focus: [{target: '#new', role: 'button', name: 'New ingredient', visible: true}]}, screenshots: [{label: 'Ingredient library', dataUrl: canvas.toDataURL()}], limitations: ['Only one page was inspected.']},
        analysis: {provider: 'Fixture', model: 'No AI request', summary: 'Check the typography scale and contrast.', findings: [{title: 'Unexpected heading size', description: 'This measured 23px style should be reviewed against the intended scale.', recommendation: 'Check the matching design token.', severity: 'minor', evidenceIds: ['typography:1', 'step:styles']}], limitations: ['Illustrative fixture, not real findings.']}});
    }
    const index = await listBrowserAudits('audit-review');
    return {index, first: await getBrowserAudit('audit-0')};
  });
  assert.equal(saved.index.length, 12);
  assert.equal(saved.first.evidenceArchived, true);
  assert.equal(saved.first.steps.length, 2);
  assert.equal(saved.first.evidence.screenshots[0].dataUrl, undefined);
  await page.goto(`${base}/report.html?review=audit-review`);
  await page.locator('.interactive-audit-link').nth(11).waitFor();
  assert.equal(await page.locator('.comment-card').count(), 0);
  await page.locator('.interactive-audit-link').first().click();
  await page.getByRole('heading', {name: 'Ingredient library', exact: true}).waitFor();
  assert.match(await page.locator('.audit-heading').textContent(), /Stopped by reviewer/);
  assert.equal(await page.locator('.audit-step').count(), 2);
  await page.locator('.audit-evidence-links a').first().click();
  assert.match(page.url(), /#audit-evidence-typography%3A1$/);
  await page.locator('.audit-step summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.audit-step[open]').count(), 1);
  await page.locator('figure img').scrollIntoViewIfNeeded();
  await page.locator('figure img').evaluate(image => image.decode());
  assert.equal(await page.locator('figure img').evaluate(image => image.naturalWidth), 1000);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => DiffuseTheme.setPreference(theme), theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 1000});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width}px fits`);
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: join(artifacts, `audit-${theme}.png`)});
  }
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Download HTML'}).click();
  const download = await pending;
  const exportPath = join(artifacts, 'interactive-audit.html');
  await download.saveAs(exportPath);
  const html = await readFile(exportPath, 'utf8');
  assert.match(html, /Inspected the current page/);
  assert.doesNotMatch(html, /<script|chrome-extension:|blob:/);
  const offline = await context.newPage();
  await offline.goto(pathToFileURL(exportPath).href);
  await offline.locator('figure img').scrollIntoViewIfNeeded();
  await offline.locator('figure img').evaluate(image => image.decode());
  assert.equal(await offline.locator('figure img').evaluate(image => image.naturalWidth), 1000);
  assert.equal(await offline.locator('.audit-step').count(), 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log('PASS: twelve local audits retained, stopped audit linked from zero-comment review, report evidence links and keyboard disclosures, responsive light/dark UI, and offline HTML images. No external requests.');
} finally { await context?.close(); await rm(directory, {recursive: true, force: true}); }
