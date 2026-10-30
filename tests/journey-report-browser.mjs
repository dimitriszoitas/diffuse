// A temporary extension profile exercises the actual report controller and
// IndexedDB retention. All content is fictional; no provider request is made.
import assert from 'node:assert/strict';
import {mkdtemp, cp, readFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'artifacts', 'journey-reports');
await mkdir(artifacts, {recursive: true});
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-journey-reports-'));
const extension = join(temporary, 'extension');
await cp(join(root, 'extension'), extension, {recursive: true});
const errors = [], externalRequests = [];
const pass = message => console.log(`PASS ${message}`);
let context;
try {
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: chromium.executablePath(), headless: true,
    viewport: {width: 1440, height: 1040}, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-mock-keychain', '--password-store=basic'],
  });
  await context.route(/^https?:\/\//, route => { externalRequests.push(route.request().url()); return route.abort(); });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/report.html`);
  const saved = await page.evaluate(async () => {
    const reviews = await import(chrome.runtime.getURL('review-store.mjs'));
    const journeys = await import(chrome.runtime.getURL('journey-store.mjs'));
    const review = {id: 'journeys-without-comments', title: 'Ingredient creation journeys', mode: 'audit',
      productionUrl: 'https://fixture.example.test/ingredients', createdAt: '2026-10-25T09:00:00.000Z', updatedAt: '2026-10-25T12:00:00.000Z'};
    await reviews.ensureReview(review);
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 440;
    const c = canvas.getContext('2d');
    c.fillStyle = '#101a25'; c.fillRect(0, 0, 800, 440);
    c.fillStyle = '#1c2e41'; c.fillRect(24, 24, 752, 392);
    c.font = '28px sans-serif'; c.fillStyle = '#edf2fa'; c.fillText('Ingredients · fictional test workspace', 48, 80);
    c.fillStyle = '#a7bbd3'; c.font = '20px sans-serif'; c.fillText('Name', 48, 144);
    c.fillStyle = '#152231'; c.fillRect(48, 162, 688, 68);
    c.fillStyle = '#edf2fa'; c.fillText('Test oat flour', 66, 204);
    c.fillStyle = '#2d6cda'; c.fillRect(48, 266, 210, 58);
    c.fillStyle = '#ffffff'; c.fillText('Create ingredient', 64, 302);
    c.font = '15px sans-serif'; c.fillStyle = '#a7bbd3'; c.fillText('Hand-authored fixture. No AI or account request.', 48, 377);
    const screenshot = canvas.toDataURL('image/png');
    const statuses = ['stopped', 'blocked', 'inconclusive', 'completed'];
    for (let index = 1; index <= 12; index++) {
      const status = statuses[(index - 1) % statuses.length];
      const timestamp = `2026-10-25T${String(index).padStart(2, '0')}:00:00.000Z`;
      const run = {id: `report-journey-${index}`, reviewId: review.id, goal: `Attempt ${index}: create an ingredient`,
        createdAt: timestamp, updatedAt: timestamp, status, startUrl: review.productionUrl, actionTarget: 2,
        persona: {description: 'First-time kitchen manager', techSavviness: 2, domainKnowledge: 4},
        metrics: {actions: 3, elapsedMs: 42000},
        summary: status === 'completed' ? 'The new ingredient was confirmed in the table.' : 'The ingredient creation task was not verified.',
        steps: [
          {index: 1, createdAt: timestamp, action: {type: 'click', controlId: 'new-ingredient'}, reason: `Saved choice for attempt ${index}: the button names the requested task.`, executionStatus: 'done',
            result: 'The ingredient form opened.', observation: {title: 'Ingredients', url: review.productionUrl,
              controls: [{id: 'new-ingredient', label: 'New ingredient'}], screenshot: {dataUrl: screenshot, width: 800, height: 440}}},
          {index: 2, createdAt: timestamp, action: {type: 'type', targetLabel: 'Name', value: `Test oat flour ${index}`}, reason: 'The name field is required.', executionStatus: 'done',
            result: 'The name is visible in the field.', observation: {title: 'New ingredient', url: `${review.productionUrl}/new`}},
          {index: 3, createdAt: timestamp, action: {type: 'click', targetLabel: 'Create ingredient'}, reason: 'Save the new ingredient.', executionStatus: status === 'blocked' ? 'error' : 'done',
            ...(status === 'blocked' ? {executionError: {code: 'target_missing', message: 'The Create ingredient control was no longer available.'}} : {}),
            observation: {title: 'New ingredient', url: `${review.productionUrl}/new`}},
        ]};
      if (status === 'stopped') run.stopReason = {source: 'user', code: 'manual_stop', message: 'The reviewer chose to stop this attempt.'};
      if (status === 'blocked') run.stopReason = {source: 'browser', code: 'target_missing', message: 'The selected control disappeared before the next action.'};
      await journeys.putJourney(run);
    }
    const index = await journeys.listJourneys(review.id);
    const runs = await Promise.all(index.map(item => journeys.getJourney(item.id)));
    return {review: await reviews.getReview(review.id), runs};
  });
  assert.equal(saved.review.comments.length, 0);
  assert.equal(saved.runs.length, 12, 'Retention never deletes an older attempt');
  const archived = saved.runs.filter(run => run.evidenceArchived);
  assert.deepEqual(archived.map(run => run.id).sort(), ['report-journey-1', 'report-journey-2']);
  for (const run of saved.runs) {
    assert.equal(run.steps.length, 3);
    assert.match(run.steps[0].reason, /Saved choice for attempt/);
    if (run.evidenceArchived) assert.equal(run.steps[0].observation.screenshot.dataUrl, undefined);
    else assert.match(run.steps[0].observation.screenshot.dataUrl, /^data:image\/png;base64,/);
  }
  pass('Twelve zero-comment attempts survive storage retention with all steps and notes; only the two oldest screenshots are archived.');

  await page.goto(`chrome-extension://${extensionId}/report.html?review=${saved.review.id}`);
  await page.locator('#review-journeys .journey-report').nth(11).waitFor();
  assert.equal(await page.locator('#report-content[aria-busy="false"]').count(), 1);
  assert.equal(await page.getByRole('region', {name: 'Journeys', exact: true}).count(), 1);
  assert.equal(await page.locator('.comment-card').count(), 0);
  assert.equal(await page.locator('.jira-selection-bar').count(), 0, 'A journey-only report has no irrelevant Jira selection toolbar');
  assert.match(await page.locator('.review-summary').textContent(), /12 journeys/);
  assert.match(await page.locator('#review-issues').textContent(), /No observations/);
  assert.equal(await page.locator('#review-journeys .journey-report-count').textContent(), '12');
  assert.equal(await page.locator('.journey-report[open]').count(), 0);
  const statusLabels = {completed: 'Completed', stopped: 'Stopped', blocked: 'Needs help', inconclusive: 'Inconclusive'};
  for (const run of saved.runs) {
    const card = page.locator(`[data-journey-id="${run.id}"]`);
    assert.match(await card.locator(':scope > summary').textContent(), new RegExp(statusLabels[run.status]));
    await card.locator(':scope > summary').click();
    assert.equal(await card.getAttribute('open'), '');
    if (run.stopReason) assert.equal(await card.locator('.journey-report-end p').textContent(), run.stopReason.message);
    else if (run.status === 'inconclusive') assert.match(await card.textContent(), /No explicit stop reason.*cannot be inferred/s);
    else assert.equal(await card.locator('.journey-report-end').count(), 0);
    assert.match(await card.textContent(), /includes AI, network and pauses; not human task time/);
    const stepDetails = card.locator('.journey-report-steps > li > details');
    assert.equal(await stepDetails.count(), 3);
    for (let index = 0; index < 3; index++) {
      await stepDetails.nth(index).locator(':scope > summary').click();
      assert.equal(await stepDetails.nth(index).getAttribute('open'), '');
      assert.match(await stepDetails.nth(index).locator('.journey-report-step-body').textContent(), /Why this action/);
    }
    assert.match(await stepDetails.nth(0).locator('summary').first().textContent(), /Click · New ingredient/);
    assert.match(await stepDetails.nth(1).textContent(), new RegExp(`Test oat flour ${run.id.split('-').at(-1)}`));
    if (run.status === 'blocked') assert.match(await stepDetails.nth(2).textContent(), /control was no longer available/);
    if (run.evidenceArchived) {
      assert.match(await card.locator('.journey-report-note').textContent(), /All recorded steps and notes remain/);
      assert.equal(await card.locator('img').count(), 0);
    } else {
      await card.locator('.journey-report-evidence > summary').click();
      await card.locator('img').evaluate(image => image.decode());
      assert.equal(await card.locator('img').evaluate(image => image.naturalWidth), 800);
    }
    await card.locator(':scope > summary').click();
  }
  pass('Reports list every status separately from observations; all 36 saved steps, known/unknown ending explanations, entered values and screenshots are readable.');

  const latest = page.locator('[data-journey-id="report-journey-12"]');
  await latest.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await latest.getAttribute('open'), '');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => DiffuseTheme.setPreference(theme), theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 1040});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width}px report does not overflow`);
      const box = await latest.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    }
    await page.setViewportSize({width: 1440, height: 1040});
    await page.locator('#review-journeys').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24));
    await page.screenshot({path: join(artifacts, `journeys-${theme}-desktop.png`)});
    await page.setViewportSize({width: 390, height: 1040});
    await latest.locator('.journey-report-steps').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24));
    await page.screenshot({path: join(artifacts, `journeys-${theme}-mobile.png`)});
  }
  const unknown = page.locator('[data-journey-id="report-journey-11"]');
  await unknown.locator(':scope > summary').click();
  await unknown.locator(':scope > summary').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24));
  await page.screenshot({path: join(artifacts, 'journey-unknown-ending-mobile.png')});
  const older = page.locator('[data-journey-id="report-journey-1"]');
  await older.locator(':scope > summary').click();
  await older.locator(':scope > summary').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24));
  await page.screenshot({path: join(artifacts, 'journey-archived-mobile.png')});
  pass('Journey and step disclosures work by keyboard; light/dark reports fit 320–1440px.');

  await page.setViewportSize({width: 1440, height: 1040});
  await page.locator('#review-actions-toggle').click();
  const downloadPending = page.waitForEvent('download');
  await page.locator('#download-html').click();
  const download = await downloadPending;
  const htmlPath = join(artifacts, 'journey-report-offline.html');
  await download.saveAs(htmlPath);
  const html = await readFile(htmlPath, 'utf8');
  assert.equal((html.match(/class="journey-report"/g) || []).length, 12);
  assert.equal((html.match(/class="journey-report-step-body"/g) || []).length, 36);
  assert.match(html, /Older screenshots and video were cleared/);
  assert.match(html, /No explicit stop reason was saved/);
  assert.doesNotMatch(html, /<script|blob:|chrome-extension:/i);
  const offline = await context.newPage();
  await offline.setViewportSize({width: 320, height: 900});
  await offline.goto(pathToFileURL(htmlPath).href);
  const offlineLatest = offline.locator('[data-journey-id="report-journey-12"]');
  await offlineLatest.locator(':scope > summary').click();
  await offlineLatest.locator('.journey-report-steps > li > details > summary').first().click();
  await offlineLatest.locator('.journey-report-evidence > summary').click();
  await offlineLatest.locator('img').evaluate(image => image.decode());
  assert.equal(await offlineLatest.locator('img').evaluate(image => image.naturalWidth), 800);
  assert.equal(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await offlineLatest.locator('.journey-report-evidence').scrollIntoViewIfNeeded();
  await offline.screenshot({path: join(artifacts, 'journeys-offline-mobile.png')});
  pass('The actual Download HTML action exports every attempt and step, with expandable screenshots and no extension/script dependency.');
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'Reviewing and exporting saved journeys makes no external request');
  pass('No page errors or external network requests.');
} finally {
  await context?.close();
  await rm(temporary, {recursive: true, force: true});
}
