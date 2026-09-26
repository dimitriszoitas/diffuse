// Isolated extension profile with fictional, correctly sized viewport captures.
// No API keys, existing reviews, real Jira calls or user browser profile.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-viewport-report-'));
const extension=join(temp,'extension'),artifacts=join(project,'artifacts/viewport-report');
await cp(join(project,'extension'),extension,{recursive:true});await mkdir(artifacts,{recursive:true});
const results=[],errors=[],external=[];const pass=label=>{results.push(label);console.log(`PASS ${label}`);};
let context;
try{
  context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:{width:1440,height:960},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--use-mock-keychain','--password-store=basic']});
  await context.route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),extensionId=new URL(worker.url()).host;
  const captures={},capture=await context.newPage(),timestamp='2026-09-26T19:30:00.000Z';
  for(const [key,width,height] of [['desktop',1440,900],['tablet',1024,768],['phone',390,844]]){
    await capture.setViewportSize({width,height});
    await capture.setContent(`<!doctype html><title>Fictional ${key} review fixture</title><style>body{font:16px system-ui;margin:24px;background:#f7f4fc;color:#211a35}main{max-width:900px;background:white;padding:24px;border:1px solid #ddd2ee;border-radius:12px}h1{font-size:28px}</style><main><h1>Fictional ${key} workspace</h1><p>Hand-authored responsive review fixture, captured at ${width} × ${height}.</p><button>Example action</button></main>`);
    const png=await capture.screenshot({path:join(artifacts,`${key}-fixture.png`)});
    captures[key]={viewport:{width,height,dpr:1},evidence:{dataUrl:`data:image/png;base64,${png.toString('base64')}`,width,height,capturedAt:timestamp}};
  }
  await capture.close();
  const review={id:'viewport-review-fixture',title:'Fictional multi-viewport review',mode:'audit',productionUrl:'https://fixture.example.test/workspace',createdAt:timestamp,updatedAt:timestamp};
  const items=[['desktop','ux-issue','Desktop action needs space'],['desktop','copy-change','Desktop action label'],['tablet','ux-issue','Tablet navigation overlap'],['phone','copy-change','Phone empty-state copy']];
  const drafts=items.map(([key,category,title],index)=>({id:`viewport-fixture-${index}`,reviewId:review.id,mode:'audit',createdAt:timestamp,context:{production:{url:review.productionUrl,viewport:captures[key].viewport,viewportProfile:{key,mode:'preset'},scroll:{x:0,y:0}}},evidence:{production:captures[key].evidence},fields:{title,category,comment:`Illustrative ${key} observation.`,expected:'Apply the recorded requested change in this viewport.',state:'Fictional default state',component:'Example page',severity:'minor'}}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/report.html`);
  const before=await page.evaluate(async({review,drafts})=>{const store=await import(chrome.runtime.getURL('review-store.mjs'));for(const draft of drafts){const{fields,...capture}=draft;await store.putDraft(capture,review);await store.addComment(capture.id,fields);}return store.getReview(review.id);},{review,drafts});
  await page.goto(`chrome-extension://${extensionId}/report.html?review=${review.id}`);
  await page.waitForFunction(()=>document.querySelectorAll('.comment-card').length===4&&document.querySelector('#report-content').getAttribute('aria-busy')==='false');
  const visible=()=>page.locator('.comment-card:not([hidden]) h2').allTextContents();
  const view=key=>page.locator(`[data-viewport-filter="${key}"]`),category=key=>page.locator(`[data-category-filter="${key}"]`);
  const jira=page.locator('.jira-selection-bar');
  assert.deepEqual((await visible()).sort(),items.map(item=>item[2]).sort());
  assert.equal(await view('desktop').getAttribute('aria-pressed'),'false');
  await view('desktop').click();assert.deepEqual((await visible()).sort(),items.slice(0,2).map(item=>item[2]).sort());
  await category('ux-issue').click();assert.deepEqual(await visible(),[items[0][2]]);
  await view('phone').click();assert.deepEqual(await visible(),[]);assert.equal(await jira.getByRole('button',{name:'Select visible',exact:true}).isEnabled(),false);
  await category('all').click();assert.deepEqual(await visible(),[items[3][2]]);
  pass('All, Desktop, Laptop / tablet and Phone filters compose with category selection, including empty intersections');

  await jira.getByRole('button',{name:'Select visible',exact:true}).click();
  const selectedTitles=()=>page.locator('.comment-card').evaluateAll(cards=>cards.filter(card=>card.querySelector('input[type=checkbox]')?.checked).map(card=>card.querySelector('h2').textContent));
  assert.deepEqual(await selectedTitles(),[items[3][2]]);
  await view('tablet').click();assert.deepEqual(await visible(),[items[2][2]]);
  assert.match(await jira.textContent(),/1 selected.*1 hidden/);
  await jira.getByRole('button',{name:'Clear selection',exact:true}).click();
  await jira.getByRole('button',{name:'Select visible',exact:true}).click();assert.deepEqual(await selectedTitles(),[items[2][2]]);
  pass('Jira Select visible uses both filters and preserves explicitly selected hidden items until cleared');

  for(const [button,file] of [['download-html','filtered-review.html'],['download-markdown','filtered-review.md']]){
    const pending=page.waitForEvent('download');await page.locator(`#${button}`).click();const download=await pending;await download.saveAs(join(artifacts,file));
    const text=await readFile(join(artifacts,file),'utf8');for(const item of items)assert.ok(text.includes(item[2]),`${file} must include ${item[2]}`);
    if(file.endsWith('.html'))assert.equal((text.match(/class="comment-card"/g)||[]).length,4);
  }
  assert.deepEqual(await visible(),[items[2][2]]);
  const after=await page.evaluate(async id=>(await import(chrome.runtime.getURL('review-store.mjs'))).getReview(id),review.id);assert.deepEqual(after,before);
  pass('HTML and Markdown exports retain all viewports while filtering and selection leave saved comments unchanged');

  await view('all').focus();await page.keyboard.press('Enter');assert.equal((await visible()).length,4);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(artifacts,'viewport-filters-phone.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  pass('Viewport filters remain keyboard-operable and reflow at 390px without external requests');
  await writeFile(join(artifacts,'verification.json'),JSON.stringify({results,errors,externalRequests:external.length,provenance:'Fictional screenshots captured independently at actual Desktop, Laptop / tablet and Phone sizes in an isolated browser.'},null,2));
}catch(error){throw error;}finally{await context?.close();await rm(temp,{recursive:true,force:true});}
