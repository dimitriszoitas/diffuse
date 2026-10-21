// Persona interaction and rendering on the shipped form. Native journey and
// permissions are covered by journey-browser.mjs; this fixture isolates inputs.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createRequire} from 'node:module';
import {DEFAULT_JOURNEY_PERSONA, normalizeJourneyPersona} from '../extension/journey-persona.mjs';
import {DEFAULT_JOURNEY_SETTINGS} from '../extension/journey-settings.mjs';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'artifacts', 'journey-persona');
await mkdir(artifacts, {recursive: true});
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (!/^\/[\w.-]+$/.test(path)) { response.writeHead(404); response.end(); return; }
  try {
    let data = await readFile(join(root, 'extension', path.slice(1)));
    if (path === '/sidepanel.html') data = data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</body>', '<script src="journey-persona-ui.js"></script></body>');
    response.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'text/css');
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/sidepanel.html`);
  await page.evaluate(() => {
    document.querySelector('#loading').hidden = true;
    document.querySelector('#dock-workspace').hidden = false;
    document.querySelector('#panel-journey-view').hidden = false;
    document.body.dataset.journeyView = 'open';
  });
  assert.deepEqual(await page.evaluate(() => diffuseJourneyPersona.read()), {...DEFAULT_JOURNEY_PERSONA});
  assert.equal(await page.locator('#journey-persona').evaluate(element => element.previousElementSibling.className), 'journey-intro');
  assert.equal(await page.locator('#journey-persona').evaluate(element => element.nextElementSibling.htmlFor), 'journey-goal');
  const range = page.getByRole('slider', {name: 'Technical confidence', exact: true});
  await range.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await range.inputValue(), '4');
  assert.equal(await range.getAttribute('aria-valuetext'), 'Confident, 4 of 5');
  assert.equal(await page.locator('#journey-persona-technicalConfidence-value').textContent(), 'Confident');
  await page.keyboard.press('End'); assert.equal(await range.inputValue(), '5');
  await page.keyboard.press('Home'); assert.equal(await range.inputValue(), '1');
  assert.equal(await range.getAttribute('min'), '1');
  assert.equal(await range.getAttribute('max'), '5');
  assert.equal(await range.getAttribute('step'), '1');
  console.log('PASS persona defaults match runner; keyboard sliders expose labels, bounds, words and current values');

  const description = page.getByRole('textbox', {name: 'Who is trying this?', exact: true});
  await description.fill(''); assert.equal(await description.evaluate(element => element.checkValidity()), false);
  assert.equal(await description.getAttribute('maxlength'), '1500');
  const profile = {description: '  New inventory manager adding the first ingredient <script>literal</script>  ', technicalConfidence: 2, productFamiliarity: 1, taskFamiliarity: 5, persistence: 2};
  await page.evaluate(value => diffuseJourneyPersona.set(value), profile);
  assert.deepEqual(await page.evaluate(() => diffuseJourneyPersona.read()), normalizeJourneyPersona(profile));
  assert.equal(await page.locator('#journey-persona script').count(), 0);
  assert.equal(await page.getByRole('slider').count(), 4);
  await page.evaluate(() => diffuseJourneyPersona.setDisabled(true));
  assert.equal(await description.isDisabled(), true);
  for (const item of await page.locator('#journey-persona input').all()) assert.equal(await item.isDisabled(), true);
  await page.evaluate(() => diffuseJourneyPersona.setDisabled(false));
  assert.equal(await description.isEnabled(), true);
  await description.focus(); await page.keyboard.press('End'); await page.keyboard.type(' Example');
  await page.evaluate(() => dispatchEvent(new CustomEvent('diffuse-panel-state', {detail: {}})));
  assert((await description.inputValue()).endsWith(' Example'));
  await page.evaluate(() => diffuseJourneyPersona.reset());
  assert.deepEqual(await page.evaluate(() => diffuseJourneyPersona.read()), {...DEFAULT_JOURNEY_PERSONA});
  console.log('PASS persona inheritance/set, required description, safe text, reset, locking and stable edits');

  assert.deepEqual(await page.evaluate(() => diffuseJourneyOptions.read()), {...DEFAULT_JOURNEY_SETTINGS});
  const settings = {exploration: 'thorough', allowRecordMoves: true, extraInstructions: 'Try the setup wizard.', focusChecks: ['completion', 'interaction', 'layout']};
  await page.evaluate(value => diffuseJourneyOptions.set({...value, id: 'saved-run'}), settings);
  assert.deepEqual(await page.evaluate(() => diffuseJourneyOptions.read()), settings);
  await page.locator('#journey-focus-checks > summary').click();
  assert.equal(await page.locator('#journey-check-count').textContent(), '3 selected');
  // Use the shipped controls; custom validity opens a collapsed section before
  // Chrome focuses its first checkbox after form validation fails.
  await page.evaluate(() => {
    for (const input of document.querySelectorAll('.journey-check-list input')) {input.checked = false; input.dispatchEvent(new Event('change', {bubbles: true}));}
    document.querySelector('#journey-focus-checks').open = false;
  });
  assert.equal(await page.locator('#journey-check-completion').evaluate(element => element.reportValidity()), false);
  assert.equal(await page.locator('#journey-focus-checks').evaluate(element => element.open), true);
  await page.locator('#journey-check-completion').check();
  assert.equal(await page.locator('#journey-check-completion').evaluate(element => element.checkValidity()), true);
  await page.evaluate(() => diffuseJourneyOptions.setDisabled(true));
  for (const selector of ['#journey-exploration', '#journey-allow-record-moves', '#journey-extra-instructions', '#journey-check-completion']) assert(await page.locator(selector).isDisabled());
  await page.evaluate(() => {diffuseJourneyOptions.setDisabled(false); diffuseJourneyOptions.reset();});
  assert.deepEqual(await page.evaluate(() => diffuseJourneyOptions.read()), {...DEFAULT_JOURNEY_SETTINGS});
  assert.equal(await page.locator('#journey-extra-instructions').getAttribute('maxlength'), '2000');
  await page.locator('#journey-exploration-options > summary').click();
  await page.locator('#journey-exploration').selectOption('thorough');
  await page.locator('#journey-allow-record-moves').check();
  await page.locator('#journey-extra-instructions').fill('Only use supplied test records.');
  assert.deepEqual(await page.evaluate(() => diffuseJourneyOptions.read()), {...DEFAULT_JOURNEY_SETTINGS, exploration: 'thorough', allowRecordMoves: true, extraInstructions: 'Only use supplied test records.'});
  console.log('PASS exploration/checklist defaults, inherited settings, explicit record moves and at-least-one-check validation');
  await page.evaluate(() => {document.querySelector('#journey-focus-checks').open = false; document.querySelector('#journey-exploration-options').open = false; document.activeElement.blur();});

  for (const width of [320, 420]) {
    await page.setViewportSize({width, height: 1100});
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.querySelector('.drawer-scroll').scrollTop = 0; }, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Persona must not overflow the drawer');
      for (const slider of await page.locator('#journey-persona input').all()) {
        const bounds = await slider.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
      }
      await page.screenshot({path: join(artifacts, `persona-${width}-${theme}.png`)});
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS persona form fits 320px and420px in light/dark themes without clipping');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
