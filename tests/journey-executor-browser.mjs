import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'diffuse-journey-browser-'));
const extension = join(temp, 'extension');
await mkdir(extension);
for (const file of ['journey-executor.mjs', 'journey-page.js']) await cp(join(project, 'extension', file), join(extension, file));
await writeFile(join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Journey executor fixture', version: '1.0',
  permissions: ['tabs', 'scripting', 'debugger'], host_permissions: ['http://127.0.0.1/*'],
  background: {service_worker: 'worker.js', type: 'module'},
}));
await writeFile(join(extension, 'worker.js'), `
import {createJourneyExecutor} from './journey-executor.mjs';
globalThis.beginJourney = async url => {
  await globalThis.journey?.cleanup();
  const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
  globalThis.journey = createJourneyExecutor({
    chromeApi:chrome,tabId:tab.id,startUrl:url,assertPageAccess:async()=>{},
    captureScreenshot:async observation=>({dataUrl:'data:image/png;base64,'+(await chrome.debugger.sendCommand({tabId:tab.id},'Page.captureScreenshot',{format:'png'})).data,width:observation.context.viewport.width,height:observation.context.viewport.height})
  });
};
globalThis.observeJourney = async () => (globalThis.observation = await journey.observe());
globalThis.act = async (action) => {try{return {ok:true,result:await journey.execute(action,observation)}}catch(e){return {ok:false,error:e.message,code:e.code}}};
`);
const shell = content => `<!doctype html><html><head><title>Ingredient workspace</title><style>
body{font:18px system-ui;margin:40px}a,button,input,select{font:inherit;margin:10px;padding:10px}
</style></head><body>${content}</body></html>`;
const dashboard = shell(`
<h1>Workspace dashboard</h1><a href="/ingredients">Ingredients</a>
<a href="https://example.org/outside">External reference</a>
<button id="delete" onclick="window.wasDeleted=true">Delete ingredient</button>
<button id="continue" onclick="window.dialogAccepted=confirm('Proceed?')">Continue</button>
<label>Password<input type="password" value="hidden-password"></label>
<div hidden>hidden-content-must-not-be-seen</div>
<div data-diffuse-ui><button>Diffuse control must not be selected</button></div>
<div id="shadow"></div><script>const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<button onclick="location.href=\\'/ingredients\\'">Shadow ingredients</button>';</script>
<div style="height:1200px"></div><p>Only visible after scrolling</p>
`);
const ingredients = shell(`<h1>Ingredients</h1><a href="/new">Add ingredient</a><ul id="items"></ul>
<script>document.querySelector('#items').textContent=localStorage.getItem('ingredient')||'No ingredients yet';</script>`);
const form = shell(`<h1>New ingredient</h1><form>
<label>Name<input name="ingredient" required></label>
<label>Unit<select name="unit"><option value="g">g</option><option value="ml">ml</option></select></label>
<button>Save ingredient</button></form><p id="error"></p><script>
let nameValue='';const input=document.querySelector('input'); input.addEventListener('input',()=>nameValue=input.value);
const native=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
Object.defineProperty(input,'value',{get(){return native.get.call(this)},set(v){window.ownSetterWasUsed=true;native.set.call(this,v)}});
document.querySelector('form').addEventListener('submit',event=>{
 event.preventDefault();if(!nameValue){document.querySelector('#error').textContent='Name is required';return}
 localStorage.setItem('ingredient',nameValue+' ('+document.querySelector('select').value+')');location.href='/ingredients';
});</script>`);
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  const path = new URL(request.url, 'http://localhost').pathname;
  response.end(path === '/ingredients' ? ingredients : path === '/new' ? form : dashboard);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: {width: 1100, height: 800},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  // Let the extension's dialog guard handle these; Playwright's default
  // auto-dismiss would otherwise race the behavior this fixture is testing.
  page.on('dialog', () => {});
  await page.goto(`${origin}/`);
  await page.bringToFront();
  await worker.evaluate(url => beginJourney(url), page.url());
  const observe = () => worker.evaluate(() => observeJourney());
  const action = data => worker.evaluate(data => act(data), data);
  let observation = await observe();
  assert.ok(observation.screenshot.dataUrl.startsWith('data:image/png'));
  assert.ok(observation.text.includes('Workspace dashboard'));
  assert.ok(!observation.text.includes('hidden-content'));
  assert.ok(!observation.text.includes('Only visible after scrolling'));
  assert.ok(!observation.controls.some(control => control.label.includes('Diffuse control')));
  assert.equal(observation.controls.find(control => control.type === 'password').value, undefined);
  assert.ok(observation.controls.find(control => control.label === 'Shadow ingredients'));
  let control = observation.controls.find(control => control.label === 'Delete ingredient');
  assert.equal((await action({type: 'click', targetId: control.id})).code, 'JOURNEY_BLOCKED');
  assert.equal(await page.evaluate(() => window.wasDeleted), undefined);
  control = observation.controls.find(control => control.label === 'External reference');
  assert.equal((await action({type: 'click', targetId: control.id})).code, 'JOURNEY_BLOCKED');
  assert.equal(page.url(), `${origin}/`);
  // Reobserve after a rejected action because its target may have changed.
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Ingredients');
  await page.locator('a[href="/ingredients"]').evaluate(el => { el.textContent = 'Changed target'; });
  assert.equal((await action({type: 'click', targetId: control.id})).code, 'JOURNEY_STALE');
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Shadow ingredients');
  assert.equal((await action({type: 'click', targetId: control.id})).ok, true);
  assert.equal(page.url(), `${origin}/ingredients`);
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Add ingredient');
  assert.equal((await action({type: 'click', targetId: control.id})).ok, true);
  assert.equal(page.url(), `${origin}/new`);
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Name');
  assert.equal((await action({type: 'type', targetId: control.id, text: 'Oat milk'})).ok, true);
  assert.equal(await page.evaluate(() => window.ownSetterWasUsed), undefined);
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Unit');
  assert.equal((await action({type: 'select', targetId: control.id, value: 'ml'})).ok, true);
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Save ingredient');
  const saved = await action({type: 'click', targetId: control.id});
  assert.equal(saved.ok, true, saved.error);
  observation = await observe();
  assert.equal(observation.url, `${origin}/ingredients`);
  assert.match(observation.text, /Oat milk \(ml\)/);
  await page.reload();
  observation = await observe();
  assert.match(observation.text, /Oat milk \(ml\)/);
  console.log('PASS multi-page navigation, native controlled input, selection, save, persisted result, and fresh screenshot evidence');
  console.log('PASS hidden text, offscreen text, extension UI, password values, destructive controls, outside-origin links, shadow DOM, stale targets');
  await worker.evaluate(() => journey.cleanup());
  await page.goto(`${origin}/`);
  await worker.evaluate(url => beginJourney(url), page.url());
  observation = await observe();
  control = observation.controls.find(control => control.label === 'Continue');
  const dialog = await action({type: 'click', targetId: control.id});
  assert.equal(dialog.code, 'JOURNEY_BLOCKED', JSON.stringify(dialog));
  assert.equal(await page.evaluate(() => window.dialogAccepted), false);
  console.log('PASS native confirmation dismissed without acceptance and journey blocked');
  await worker.evaluate(() => journey.cleanup());
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, {recursive: true, force: true});
}
