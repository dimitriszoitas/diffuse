// Functional QA for the downloadable, fully inline Diffuse playground.
// Each variant gets a clean context. No personal browser profile or AI calls.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const{chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const artifacts=join(project,'artifacts','playground');
const origin=process.env.PLAYGROUND_ORIGIN||'http://127.0.0.1:4180';
const results=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=(variant,message)=>{results.push({variant,message});console.log(`PASS ${variant}: ${message}`);};
async function until(check,label,timeout=6000){const started=Date.now();while(Date.now()-started<timeout){if(await check())return;await pause(60);}throw new Error(`Timed out: ${label}`);}
async function shot(page,variant,state){await page.screenshot({path:join(artifacts,`${variant}-${state}.png`),fullPage:false});}
async function noHorizontalOverflow(page,label){
  const dimensions=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert(dimensions.document<=dimensions.width+1,`${label}: document spills horizontally (${JSON.stringify(dimensions)})`);
  assert(dimensions.body<=dimensions.width+1,`${label}: body spills horizontally (${JSON.stringify(dimensions)})`);
}
async function watch(page){
  const errors=[];const external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.location().url?.endsWith('/favicon.ico'))errors.push(message.text());});
  page.on('request',request=>{const url=request.url();if(/^https?:/i.test(url)&&new URL(url).origin!==new URL(origin).origin)external.push(url);});
  return{errors,external};
}
async function checkInline(page){
  const linked=await page.evaluate(()=>[...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].map(element=>element.src||element.href));
  assert.deepEqual(linked,[],'Standalone page must include its scripts and styles inline');
}

async function runVariant(page,variant){
  const rows=page.locator('#release-rows tr[data-release]');
  const names=()=>rows.locator('.release-name-button>span:last-child').allTextContents();
  const openLab=async()=>{if(!await page.locator('#lab-panel').isVisible())await page.locator('#lab-toggle').click();};
  const closeLab=async()=>{if(await page.locator('#lab-panel').isVisible())await page.locator('#lab-close').click();};
  const reset=async()=>{await openLab();await page.locator('#reset-demo').click();await until(()=>page.locator('#demo-state').inputValue().then(v=>v==='normal'),'normal state after reset');await closeLab();};
  const setState=async value=>{await openLab();await page.locator('#demo-state').selectOption(value);await closeLab();};
  await until(()=>rows.count().then(n=>n===6),'initial release rows');
  const initialNames=await names();assert.equal(new Set(initialNames).size,6);
  await noHorizontalOverflow(page,`${variant} desktop`);await shot(page,variant,'overview');pass(variant,'Six fictional releases render inline without desktop overflow');

  await page.locator('#search').fill(initialNames[0]);await until(()=>rows.count().then(n=>n===1),'search result');assert((await names())[0].includes(initialNames[0]));
  await page.locator('#search').fill('no-such-release-diffuse-qa');await until(()=>rows.count().then(n=>n===0),'unmatched search');assert.equal(await page.locator('#state-panel').isVisible(),true);
  await page.locator('#clear-filters').click();await until(()=>rows.count().then(n=>n===6),'search clear');assert.equal(await page.locator('#search').inputValue(),'');
  await page.locator('#status-filter').selectOption('review');await until(()=>rows.count().then(n=>n>0&&n<6),'review filter');assert.equal(await rows.locator('.status-pill.review').count(),await rows.count());
  await page.locator('#status-filter').selectOption('all');await until(()=>rows.count().then(n=>n===6),'all statuses');pass(variant,'Search, no-match recovery, and status filtering change the visible releases');
  await page.locator('#sort-name').click();let sorted=await names();assert.deepEqual(sorted,[...initialNames].sort((a,b)=>a.localeCompare(b)));
  await page.locator('#sort-name').click();sorted=await names();assert.deepEqual(sorted,[...initialNames].sort((a,b)=>b.localeCompare(a)));pass(variant,'Name sorting works in both directions');

  const firstId=await rows.first().getAttribute('data-release');
  await rows.first().locator('.release-name-button').click();await until(()=>page.locator('#detail-dialog').isVisible(),'release drawer');assert.equal((await page.locator('#detail-title').textContent()).trim(),sorted[0]);
  await page.locator('#detail-status-select').selectOption('planned');await page.locator('#detail-note').fill('Keep the design intent visible in this release.');await page.locator('#check-copy').check();await page.locator('#save-detail').click();
  if(await page.locator('#detail-dialog').isVisible())await page.locator('[data-close="detail-dialog"]').first().click();
  await page.locator(`#release-rows tr[data-release="${firstId}"] .release-name-button`).click();assert.equal(await page.locator('#detail-status-select').inputValue(),'planned');assert.equal(await page.locator('#detail-note').inputValue(),'Keep the design intent visible in this release.');assert.equal(await page.locator('#check-copy').isChecked(),true);await shot(page,variant,'detail');await page.keyboard.press('Escape');await until(()=>page.locator('#detail-dialog').isVisible().then(v=>!v),'drawer Escape dismissal');pass(variant,'Drawer edits save and remain visible when reopened');
  await page.locator(`#release-rows tr[data-release="${firstId}"] .row-action`).click();assert.equal(await page.locator('#row-menu').isVisible(),true);await page.locator('#menu-review').click();await until(()=>page.locator(`#release-rows tr[data-release="${firstId}"] .status-pill.review`).count().then(n=>n===1),'row menu status change');assert.equal(await page.locator('#row-menu').isVisible(),false);pass(variant,'Row action menu changes release status and closes');

  await page.locator('#notifications-button').click();assert.equal(await page.locator('#notifications').isVisible(),true);await page.locator('#mark-read').click();assert(!/[1-9]\d* unread/i.test(await page.locator('#notifications-button').getAttribute('aria-label')));await page.keyboard.press('Escape');await until(()=>page.locator('#notifications').isVisible().then(v=>!v),'notifications dismissal');pass(variant,'Notifications open, mark read, and dismiss');
  await page.locator('#create-release').click();await page.locator('#save-release').click();const validation=page.locator(variant==='prototype'?'#name-error':'#form-summary');await until(()=>validation.isVisible(),'visible form validation');assert((await validation.textContent()).trim());assert.equal(await rows.count(),6);await shot(page,variant,'validation');
  await page.locator('#release-name').fill('Diffuse review test');await page.locator('#release-owner').selectOption('Alex Kim');await page.locator('#release-notes').fill('A fictional release created during the browser check.');await page.locator('#save-release').click();await until(()=>rows.count().then(n=>n===7),'saved release');assert.equal(await page.locator('#create-dialog').isVisible(),false);await page.locator('#search').fill('Diffuse review test');await until(()=>rows.count().then(n=>n===1),'new release is searchable');pass(variant,'Empty forms show validation and corrected forms save a searchable release');await reset();await until(()=>rows.count().then(n=>n===6),'reset restores seed data');

  await setState('loading');assert.equal(await page.locator('#loading-panel').isVisible(),true);assert.equal(await page.locator('#results').isVisible(),false);await pause(200);assert.equal(await page.locator('#loading-panel').isVisible(),true);await shot(page,variant,'loading');await page.locator('#finish-loading').click();await until(async()=>await rows.count()===6&&await page.locator('#results').isVisible(),'finish loading');
  await setState('empty');assert.equal(await page.locator('#state-panel').isVisible(),true);assert.equal(await page.locator('#results').isVisible(),false);assert((await page.locator('#state-panel h2').textContent()).trim());await shot(page,variant,'empty');await page.locator('#empty-create').click();assert.equal(await page.locator('#create-dialog').isVisible(),true);await page.keyboard.press('Escape');
  await setState('error');assert.equal(await page.locator('#state-panel').isVisible(),true);assert((await page.locator('#state-panel h2').textContent()).trim());await shot(page,variant,'error');await page.locator('#retry-load').click();assert.equal(await page.locator('#results').isVisible(),true);assert.equal(await rows.count(),6);
  await setState('success');assert.equal(await page.locator('#toast').isVisible(),true);assert((await page.locator('#toast-title').textContent()).trim());await shot(page,variant,'success');await reset();pass(variant,'Loading, empty, error, and success states are controllable and reset cleanly');

  await page.locator('.nav [data-view="releases"]').click();await openLab();await page.locator('#long-copy').check();await until(()=>page.locator('body').getAttribute('data-long').then(v=>v==='true'),'long copy');assert((await names()).join('').length>initialNames.join('').length);await noHorizontalOverflow(page,`${variant} long copy`);
  await page.locator('#copy-state').click();await until(()=>page.evaluate(()=>Boolean(window.__playgroundCopiedText)),'copied state link');const copied=await page.evaluate(()=>window.__playgroundCopiedText);assert.equal(new URL(copied).origin,new URL(origin).origin);await page.goto(copied,{waitUntil:'networkidle'});assert.equal(await page.locator('#long-copy').isChecked(),true);assert.equal(await page.locator('.nav [data-view="releases"]').getAttribute('aria-current'),'page');await closeLab();await rows.first().locator('.release-name-button').click();const drawerTitle=await page.locator('#detail-title').textContent();await page.locator('#copy-detail-link').click();const drawerUrl=await page.evaluate(()=>window.__playgroundCopiedText);assert(new URL(drawerUrl).searchParams.get('detail'));await page.goto(drawerUrl,{waitUntil:'networkidle'});assert.equal(await page.locator('#detail-dialog').isVisible(),true);assert.equal(await page.locator('#detail-title').textContent(),drawerTitle);await page.keyboard.press('Escape');pass(variant,'State links restore the selected view, long copy, and open release drawer');await closeLab();

  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));await noHorizontalOverflow(page,`${variant} mobile long copy`);
  const tableScroll=await page.locator('.table-scroll').evaluate(element=>{element.scrollLeft=50;const result={width:element.clientWidth,content:element.scrollWidth,local:element.scrollLeft,page:scrollX};element.scrollLeft=0;return result;});assert(tableScroll.content>tableScroll.width);assert.equal(tableScroll.local,50);assert.equal(tableScroll.page,0);
  await page.locator('#mobile-menu').click();await page.locator('.nav [data-view="overview"]').click();await until(()=>page.locator('#sidebar').isVisible().then(v=>!v),'mobile navigation dismissal');await shot(page,variant,'mobile');
  await rows.first().locator('.release-name-button').click();const drawer=await page.locator('#detail-dialog').boundingBox();assert(drawer.x>=-1&&drawer.x+drawer.width<=391);await noHorizontalOverflow(page,`${variant} mobile drawer`);await shot(page,variant,'mobile-detail');await page.keyboard.press('Escape');
  await page.locator('#create-release').click();const form=await page.locator('#create-dialog').boundingBox();assert(form.x>=0&&form.x+form.width<=390);await page.locator('#release-name').fill('');await page.locator('#save-release').click();assert.equal(await validation.isVisible(),true);await page.keyboard.press('Escape');await reset();assert.equal(await page.locator('#long-copy').isChecked(),false);assert.equal(await page.locator('#search').inputValue(),'');await noHorizontalOverflow(page,`${variant} mobile reset`);pass(variant,'390px layout contains the page, drawer and form; horizontal table scrolling stays local');
}

await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--use-mock-keychain','--password-store=basic']});
try{
  for(const variant of ['prototype','production']){
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    // Observe copy-link output without replacing the user's system clipboard.
    await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__playgroundCopiedText=String(text);}}});});
    const page=await context.newPage();page.setDefaultTimeout(6000);const observed=await watch(page);
    try{
      const response=await page.goto(`${origin}/${variant}.html`,{waitUntil:'networkidle',timeout:15000});
      assert(response?.ok(),`${variant} did not load successfully`);await checkInline(page);
      await runVariant(page,variant);
      await page.setViewportSize({width:1440,height:1000});
      await page.goto(pathToFileURL(join(project,'..','deliverables','diffuse-playground',`${variant}.html`)).href,{waitUntil:'load'});
      await checkInline(page);assert.equal(await page.locator('#release-rows tr[data-release]').count(),6);
      await page.locator('#search').fill('Aurora');assert.equal(await page.locator('#release-rows tr[data-release]').count(),1);
      await page.locator('.release-name-button').click();assert.equal(await page.locator('#detail-dialog').isVisible(),true);assert(new URL(page.url()).searchParams.get('detail'));
      pass(variant,'Downloaded file opens directly and its search and drawer work without a server');
      assert.deepEqual(observed.errors,[],`${variant} logged JavaScript errors`);
      assert.deepEqual(observed.external,[],`${variant} made external requests`);
      pass(variant,'No JavaScript errors or external network requests');
    }catch(error){await shot(page,variant,'failure').catch(()=>{});throw error;}
    finally{await context.close();}
  }
  await writeFile(join(artifacts,'results.json'),JSON.stringify({origin,results},null,2));
}finally{await browser.close();}
