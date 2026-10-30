// Real drawer controllers with a disposable message fixture; no provider calls.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/ai-review-entry');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const context = await browser.newContext({viewport:{width:390,height:1000},colorScheme:'dark'});
const errors = [];
await context.route('https://diffuse.test/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript'};
  let body = await readFile(resolve(root,'extension',name),'utf8');
  if (name === 'sidepanel.html') body = body.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, file) => ['sidepanel.js','journey-panel.js','journey-persona-ui.js','interactive-audit-panel.js','theme.js'].includes(file) ? tag : '');
  await route.fulfill({contentType:types[extname(name)]||'text/plain',body});
});
await context.addInitScript(() => {
  const event = () => ({addListener(){}});
  window.session={id:'session',mode:'audit',target:{title:'Atlas production'},settings:{},comments:[]};
  window.pageState={view:'controls',active:true,available:true,ai:{config:{hasKey:true,model:'fixture'},threshold:35}};
  window.messages=[];
  window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
  window.chrome={runtime:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(message){
    window.messages.push(message);
    if(message.type==='GET_AI_CONFIG')return{ok:true,config:{hasKey:true,model:'fixture',journeyEngine:'direct'}};
    if(message.type==='JOURNEY_STATE')return{ok:true,run:window.journeyRun||null};
    if(message.type==='JOURNEY_HISTORY')return{ok:true,runs:[]};
    if(message.type==='PANEL_COMMAND') {
      if(message.action==='openAi')window.pageState.view='ai';
      if(message.action==='closeAi')window.pageState.view='controls';
    }
    return{ok:true,session:window.session,state:window.pageState};
  }},storage:{local:{async get(){return{};},async set(){}},onChanged:event()},permissions:{request:async()=>true},tabs:{onActivated:event(),onUpdated:event()},windows:{getCurrent:async()=>({id:1})}};
});
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto('https://diffuse.test/sidepanel.html');
  await page.locator('#open-ai-entry:not([disabled])').waitFor();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await page.locator('#panel-ai').isVisible(),false);
  assert.equal(await page.locator('#panel-journey').isVisible(),false);
  assert.equal(await page.locator('#panel-diff').isVisible(),true);
  assert.deepEqual(await page.locator('#panel-controls .review-tool strong').allTextContents(),['Review with AI','Diff View']);
  await page.locator('#open-ai-entry').click();
  await page.locator('#panel-ai-entry').waitFor();
  assert.equal(await page.locator('#panel-controls').isVisible(),false);
  assert.equal(await page.locator('#panel-ai-entry-title').evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(await page.locator('#panel-ai-entry .review-tool strong').allTextContents(),['Screen review','Interactive audit','Journey test']);
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='JOURNEY_START'||m.action==='runAi')),false);
  await page.screenshot({path:resolve(out,'chooser-dark.png')});
  await page.locator('#panel-ai').click();
  await page.locator('#panel-ai-view').waitFor();
  assert.equal(await page.locator('#panel-ai-entry').isVisible(),false);
  const back=page.getByRole('button',{name:'Back to AI review',exact:true});
  assert.equal(await back.isVisible(),true);
  assert.match(await back.textContent(),/←.*Review with AI/);
  const positions=await page.locator('#panel-ai-view').evaluate(el=>({back:el.querySelector('#panel-close-ai').getBoundingClientRect().bottom,title:el.querySelector('#panel-ai-title').getBoundingClientRect().top}));
  assert.ok(positions.back<=positions.title,'The text back link appears above the screen review title');
  await page.locator('#panel-ai-instructions').fill('Check the labels.');
  await page.screenshot({path:resolve(out,'screen-review-dark.png')});
  await back.click();await page.locator('#panel-ai-entry').waitFor();
  assert.equal(await page.locator('#panel-ai').evaluate(el=>el===document.activeElement),true);
  await page.locator('#panel-journey').click();await page.locator('#panel-journey-view').waitFor();
  assert.equal(await page.locator('#panel-ai-entry').isVisible(),false);
  await page.locator('#journey-back').click();await page.locator('#panel-ai-entry').waitFor();
  assert.equal(await page.locator('#panel-journey').evaluate(el=>el===document.activeElement),true);
  await page.locator('#panel-ai-entry-back').click();await page.locator('#panel-controls').waitFor();
  assert.equal(await page.locator('#open-ai-entry').evaluate(el=>el===document.activeElement),true);
  await page.evaluate(()=>{pageState.recording=true;window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>document.querySelector('#open-ai-entry').disabled);
  await page.evaluate(()=>{pageState.recording=false;pageState.picking=true;window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>document.querySelector('#open-ai-entry').disabled);
  await page.evaluate(()=>{pageState.picking=false;window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>!document.querySelector('#open-ai-entry').disabled);
  await page.locator('#open-ai-entry').click();
  await page.setViewportSize({width:320,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Chooser fits a narrow drawer');
  await page.emulateMedia({colorScheme:'light'});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.screenshot({path:resolve(out,'chooser-light-narrow.png')});
  await page.evaluate(()=>{session={...session,id:'new-session'};window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.locator('#panel-controls').waitFor();
  assert.equal(await page.locator('#panel-ai-entry').isVisible(),false,'A new review starts at its own controls');
  assert.deepEqual(errors,[]);
  console.log('PASS Unified AI entry, screen/journey back navigation, focus restoration, busy guards, responsive dark/light layout and session reset.');
} finally {await context.close();await browser.close();}
