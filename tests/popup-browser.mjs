// Tests the actual Chrome action popup, not popup.html opened as a normal tab.
// CDP exposes this view as an unattached page target; Playwright's pages() omits it.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const{chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const artifacts=join(project,'artifacts','popup-native');
const temp=await mkdtemp(join(tmpdir(),'diffuse-popup-regression-'));
const extension=join(temp,'extension');
await mkdir(artifacts,{recursive:true});
await cp(process.env.POPUP_EXTENSION||join(project,'extension'),extension,{recursive:true});
// Grant only this disposable fixture's localhost origin so the real Start
// review click can run without an unattended browser permission prompt.
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=[...new Set([...(manifest.host_permissions||[]),'http://127.0.0.1/*'])];
await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
// Hold only the disposable worker at its cold-start boundary. The real native
// sidebar must display pending state before any page content script exists.
const workerFile=join(extension,'background.js');
const workerSource=await readFile(workerFile,'utf8');
const auditStartup="await persist();\n    await ensureOffscreen();\n    await mediaMessage('START_AUDIT', {sessionId: id});";
assert(workerSource.includes(auditStartup),'Audit cold-start fixture location changed');
await writeFile(workerFile,workerSource.replace(auditStartup,"await persist();\n    await new Promise(resolve=>{globalThis.__releaseAuditStart=resolve;});\n    await ensureOffscreen();\n    await mediaMessage('START_AUDIT', {sessionId: id});"));

const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><title>${req.url.includes('prototype')?'Forma prototype — Studio overview':'Forma production — Studio overview'}</title><style>body{margin:60px;font:16px system-ui;background:#eef3f8;color:#172b45}h1{padding:30px;background:#fff;border:1px solid #dce4f0}</style><h1 id="review-target">Fictional local popup fixture</h1>`);});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];const pass=message=>{results.push(message);console.log(`PASS ${message}`);};
let context,cdp,sessionId;
const pending=new Map();let sequence=0;
async function until(check,label,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(80);}throw new Error(`Timed out: ${label}`);}
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Popup CDP timeout: ${method}`));},8000);pending.set(id,{resolve,reject,timer});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error);});});}
async function evaluate(expression){const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.text);return response.result?.value;}
async function screenshot(name){const{data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(artifacts,`${name}.png`),Buffer.from(data,'base64'));}
async function clickSelector(selector){const box=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await pause(120);}
const click=id=>clickSelector(`#${id}`);
async function inputFile(selector,path){const{root}=await send('DOM.getDocument',{depth:0});const{nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector});assert(nodeId,`Missing file input ${selector}`);await send('DOM.setFileInputFiles',{nodeId,files:[path]});}
async function measure(){return evaluate(`(()=>{const rect=id=>{const el=document.getElementById(id),b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,hidden:!el.checkVisibility(),disabled:el.disabled}};return{innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height},bodyWidth:document.body.getBoundingClientRect().width,bodyScrollWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,rootWidth:document.documentElement.getBoundingClientRect().width,isNativePopup:chrome.extension.getViews({type:'popup'}).includes(window),bodyFontSize:getComputedStyle(document.body).fontSize,source:document.getElementById('source-title').textContent,sourceUrl:document.getElementById('source-url').textContent,startLabel:document.getElementById('start-comparison').textContent.trim(),modeChoices:document.querySelectorAll('#mode-comparison,#mode-audit,#target-tab,.mode-switch').length,controls:Object.fromEntries(['open-side-panel','start-comparison','load-review','review-reports','settings'].map(id=>[id,rect(id)]))}})()`);}
try{
  context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:process.env.POPUP_HEADED!=='1',viewport:null,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1440,1000','--use-mock-keychain','--password-store=basic']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:12000});
  const id=new URL(worker.url()).host;
  const production=context.pages()[0];await production.goto(`${origin}/production`);const prototype=await context.newPage();await prototype.goto(`${origin}/prototype`);await production.bringToFront();
  cdp=await context.browser().newBrowserCDPSession();
  const{targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===production.url()).targetId});
  let popupTarget;
  await until(async()=>{popupTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/popup.html`);return popupTarget;},'native action popup target');
  ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false}));
  cdp.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const response=JSON.parse(event.message),request=pending.get(response.id);if(!request)return;clearTimeout(request.timer);pending.delete(response.id);response.error?request.reject(new Error(response.error.message)):request.resolve(response.result);});
  await until(()=>evaluate(`document.getElementById('setup')?.hidden===false&&document.getElementById('popup').getAttribute('aria-busy')==='false'`),'loaded popup');
  await pause(350);const native=await measure();
  await screenshot(process.env.POPUP_BASELINE?'baseline':'setup-100');
  console.log('NATIVE',JSON.stringify(native));
  if(process.env.POPUP_BASELINE){await writeFile(join(artifacts,'baseline.json'),JSON.stringify({chromeVersion:context.browser().version(),native},null,2));}
  else{
    assert.equal(native.isNativePopup,true);assert(!context.pages().some(page=>page.url().endsWith('/popup.html')));pass('The tested document is the real Chrome action popup, not a normal browser tab');
    assert(native.innerWidth>=400&&native.innerWidth<=450,`Unexpected intrinsic popup width: ${native.innerWidth}`);
    assert(native.bodyWidth>=399&&native.bodyWidth<=421);assert(native.bodyScrollWidth<=native.bodyWidth+1);assert.equal(native.bodyFontSize,'16px');
    assert.equal(native.modeChoices,0);assert.match(native.source,/Forma production/);assert.match(native.sourceUrl,/\/production$/);assert.match(native.startLabel,/^Start review/);pass('Native popup keeps its intended width and shows the current page without compare or audit setup choices');
    for(const control of Object.values(native.controls)){if(!control.hidden){assert(control.height>=43.5);assert(control.x>=0&&control.x+control.width<=native.innerWidth+1);}}
    assert(native.controls['start-comparison'].bottom<=600,`Primary action falls below Chrome's 600px maximum: ${native.controls['start-comparison'].bottom}`);pass('Primary action fits Chrome’s popup limit and all controls retain 44px targets');
    assert.equal(native.controls['start-comparison'].disabled,false);assert.equal(native.controls['open-side-panel'].hidden,false);assert.equal(native.controls['open-side-panel'].disabled,false);pass('Start review and the native drawer action are available immediately on the current website');
    for(const id of ['open-side-panel','start-comparison','load-review','review-reports','settings']){await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.focus();e.scrollIntoView({block:'center'})})()`);const b=await evaluate(`(()=>{const b=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:b.x,right:b.right,top:b.top,bottom:b.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`);assert(b.x>=-.5&&b.right<=b.viewportWidth+.5,`${id} clips in native popup`);assert(b.top>=-.5&&b.bottom<=b.viewportHeight+.5,`${id} cannot be brought into view in native popup`);}
    await screenshot('footer-100');pass('Primary and secondary actions remain reachable by focus and scrolling within the native popup');
    assert.equal(native.controls['load-review'].hidden,false);assert.equal(native.controls['load-review'].disabled,false);
    const originalTabs=await worker.evaluate(async()=> (await chrome.tabs.query({})).map(tab=>({id:tab.id,url:tab.url})).sort((a,b)=>a.id-b.id));
    const originalTarget=originalTabs.find(tab=>tab.url===production.url());
    const assertNoExtraTabs=async()=>assert.deepEqual(await worker.evaluate(async()=> (await chrome.tabs.query({})).map(tab=>({id:tab.id,url:tab.url})).sort((a,b)=>a.id-b.id)),originalTabs);
    await click('load-review');
    await until(async()=>!(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.targetId===popupTarget.targetId),'action popup closes after opening native review loader');
    await until(async()=> (await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`),'persistent native review loader');
    let loaderTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`);
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:loaderTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('page-review-loader')?.checkVisibility()&&!document.getElementById('choose-page-review-file').disabled`),'native loader is ready');
    assert.equal(await evaluate(`document.getElementById('choose-page-review-file').checkVisibility()&&!document.getElementById('choose-page-review-file').disabled`),true);
    assert.equal(await evaluate(`document.body.dataset.surface`),'sidepanel');
    assert(!context.pages().some(page=>/\/(?:report|sidepanel)\.html/.test(page.url())),'Loading must not open a notebook or sidebar as a browser tab');
    await assertNoExtraTabs();await screenshot('native-review-loader');
    pass('Load review opens a persistent native sidebar with a file chooser and saved reviews, keeping the current website active without a new tab');
    // Capture the fixture at the real drawer-open size, as the normal review UI does.
    // Viewport replay uses Chrome debugger and has its own non-Playwright suite.
    await production.addScriptTag({content:await readFile(join(project,'extension/inspector.js'),'utf8')});
    await pause(500);
    const selection=await production.evaluate(()=>DiffuseInspector.inspect(document.getElementById('review-target')));
    const fixture=await evaluate(`(async()=>{
      const store=await import(chrome.runtime.getURL('review-store.mjs'));
      const transfer=await import(chrome.runtime.getURL('review-transfer.mjs'));
      const selection=${JSON.stringify(selection)};
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const drawing=canvas.getContext('2d');drawing.fillStyle='#eef3f8';drawing.fillRect(0,0,640,360);drawing.fillStyle='#172b45';drawing.font='24px sans-serif';drawing.fillText('Native sidebar review fixture',30,60);
      const createdAt=new Date().toISOString();
      const review={id:'saved-native-review',title:'Fictional saved page review',mode:'audit',productionUrl:selection.context.url,createdAt,updatedAt:createdAt};
      await store.putDraft({id:'native-review-draft',reviewId:review.id,mode:'audit',createdAt,selection,context:{production:selection.context},evidence:{production:{dataUrl:canvas.toDataURL(),width:640,height:360,capturedAt:createdAt}}},review);
      await store.addComment('native-review-draft',{title:'Keep this existing feedback',comment:'This saved finding belongs on the current page.',state:'Overview',category:'ux-issue',severity:'minor'});
      const saved=await store.getReview(review.id);
      return {saved,bundle:transfer.createReviewBundle(saved)};
    })()`);
    const sharedFile=join(temp,'shared.diffuse-review.json');await writeFile(sharedFile,JSON.stringify(fixture.bundle));
    const invalidFile=join(temp,'invalid.diffuse-review.json');await writeFile(invalidFile,'{}');
    await click('close-page-review-loader');await click('load-review');
    await until(()=>evaluate(`document.querySelector('#page-review-list button[data-review-id="saved-native-review"]')?.checkVisibility()`),'saved review list refreshes');
    await clickSelector('#page-review-list button[data-review-id="saved-native-review"]');
    await until(async()=>{const current=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);return current?.reviewId==='saved-native-review'&&current.status==='live';},'saved review starts on existing page',20000);
    await until(()=>evaluate(`document.getElementById('panel-controls')?.checkVisibility()&&document.getElementById('panel-comments').textContent.includes('Keep this existing feedback')&&!document.getElementById('page-review-loader').checkVisibility()`),'saved comments in native right sidebar');
    await production.locator('diffuse-live-overlay').locator('.comment-pin').waitFor({state:'visible'});
    let loaded=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);
    assert.equal(loaded.targetTabId,originalTarget.id);assert.equal(loaded.reviewId,fixture.saved.id);assert.equal(loaded.comments.length,1);assert.equal(loaded.comments[0].id,fixture.saved.comments[0].id);
    await assertNoExtraTabs();await screenshot('saved-review-sidebar');
    pass('Choosing a saved review attaches its original comment to the current website and shows that comment in the native sidebar without duplicating the tab');
    await click('panel-stop');
    await until(()=>evaluate(`document.getElementById('setup').checkVisibility()&&!document.getElementById('load-review').disabled`),'setup after saved review stops');
    await click('load-review');await until(()=>evaluate(`document.getElementById('page-review-loader').checkVisibility()`),'native import loader reopens');
    await inputFile('#page-review-file',invalidFile);
    await until(()=>evaluate(`document.getElementById('page-review-loader-status').textContent.length>0&&!document.getElementById('choose-page-review-file').disabled`),'invalid file error and retry');
    assert.equal(await evaluate(`(async()=> (await (await import(chrome.runtime.getURL('review-store.mjs'))).listReviews()).length)()`),1);
    assert.equal(await evaluate(`document.getElementById('page-review-loader').checkVisibility()`),true);await assertNoExtraTabs();
    await inputFile('#page-review-file',sharedFile);
    await until(async()=>{const current=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);return current?.reviewId&&current.reviewId!=='saved-native-review'&&current.status==='live';},'imported review starts on current page',20000);
    await until(()=>evaluate(`document.getElementById('panel-controls')?.checkVisibility()&&document.getElementById('panel-comments').textContent.includes('Keep this existing feedback')&&!document.getElementById('page-review-loader').checkVisibility()`),'imported comments in native sidebar');
    loaded=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);
    assert.equal(loaded.targetTabId,originalTarget.id);assert.equal(loaded.comments.length,1);assert.notEqual(loaded.comments[0].id,fixture.saved.comments[0].id);
    await production.locator('diffuse-live-overlay').locator('.comment-pin').waitFor({state:'visible'});
    const imported=await evaluate(`(async()=>{const store=await import(chrome.runtime.getURL('review-store.mjs'));return {reviews:await store.listReviews(),original:await store.getReview('saved-native-review'),loaded:await store.getReview(${JSON.stringify(loaded.reviewId)})};})()`);
    assert.equal(imported.reviews.length,2);assert.deepEqual(imported.original,fixture.saved);
    for(const key of ['selection','context','fields','evidence'])assert.deepEqual(imported.loaded.comments[0][key],fixture.saved.comments[0][key]);
    await assertNoExtraTabs();await screenshot('imported-review-sidebar');
    pass('A real review file imports directly into the active website and right sidebar; invalid files allow retry, imported IDs are fresh, and saved evidence is intact');
    await click('panel-stop');await until(()=>evaluate(`document.getElementById('setup').checkVisibility()`),'setup before denied-open recovery');
    await click('load-review');await until(()=>evaluate(`document.getElementById('page-review-loader').checkVisibility()`),'permission recovery loader');
    // Only the denied-open/denied-consent responses are simulated; the retry
    // uses real extension storage, permissions and worker/page connections.
    await evaluate(`(()=>{
      const send=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=message=>{if(message?.type==='OPEN_REVIEW'){chrome.runtime.sendMessage=send;return Promise.resolve({ok:false,error:'Allow Diffuse to access this review’s site before opening it.'});}return send(message);};
      const request=chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request=options=>{chrome.permissions.request=request;return Promise.resolve(false);};
    })()`);
    await inputFile('#page-review-file',sharedFile);
    await until(()=>evaluate(`document.getElementById('open-loaded-review').checkVisibility()&&!document.getElementById('open-loaded-review').disabled`),'import kept after denied open');
    const importedCount=await evaluate(`(async()=> (await (await import(chrome.runtime.getURL('review-store.mjs'))).listReviews()).length)()`);
    assert.equal(importedCount,3);await assertNoExtraTabs();
    await click('open-loaded-review');
    await until(()=>evaluate(`document.getElementById('page-review-loader-status').textContent.includes('Allow access')&&!document.getElementById('open-loaded-review').disabled`),'denied consent message');
    assert.equal(await evaluate(`(async()=>Boolean((await chrome.storage.session.get('comparison')).comparison))()`),false);await assertNoExtraTabs();
    assert.equal(await evaluate(`(async()=> (await (await import(chrome.runtime.getURL('review-store.mjs'))).listReviews()).length)()`),importedCount);
    await click('open-loaded-review');
    await until(async()=>{const current=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);return current?.reviewId&&current.reviewId!==loaded.reviewId&&current.status==='live';},'retry attaches already imported review',20000);
    await until(()=>evaluate(`document.getElementById('panel-controls').checkVisibility()&&document.getElementById('panel-comments').textContent.includes('Keep this existing feedback')&&!document.getElementById('page-review-loader').checkVisibility()`),'retry shows saved comments');
    assert.equal(await evaluate(`(async()=> (await (await import(chrome.runtime.getURL('review-store.mjs'))).listReviews()).length)()`),importedCount);
    assert.equal((await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison)).targetTabId,originalTarget.id);
    await assertNoExtraTabs();
    pass('Denied opening/consent preserves the imported review and current page; retry attaches that same import without saving another copy');
    await click('panel-stop');await until(()=>evaluate(`document.getElementById('setup').checkVisibility()`),'setup after imported review stops');
    await worker.evaluate(async tabId=>{const tab=await chrome.tabs.get(tabId);await chrome.sidePanel.close({windowId:tab.windowId});},originalTarget.id);
    await production.bringToFront();
    const loadReturnTarget=(await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]})).targetInfos.find(t=>t.url===production.url());
    await cdp.send('Extensions.triggerAction',{id,targetId:loadReturnTarget.targetId});
    await until(async()=>{popupTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/popup.html`);return popupTarget;},'native popup reopens after loading flow');
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('setup')?.hidden===false&&document.getElementById('popup').getAttribute('aria-busy')==='false'`),'setup ready after leaving loading flow');
    await click('start-comparison');
    await until(async()=> (await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`),'native sidebar opens with review');
    const sidebarTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`);
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:sidebarTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('panel-away')?.checkVisibility()&&document.getElementById('panel-away-message').textContent==='Starting your review…'`),'native cold-start pending state');
    assert.equal(await evaluate(`document.getElementById('panel-focus').checkVisibility()`),false);
    assert.equal(await evaluate(`document.getElementById('panel-recover-page').checkVisibility()`),false);
    assert.equal(await evaluate(`document.getElementById('feedback').checkVisibility()`),false);
    assert.equal(await evaluate(`document.getElementById('panel-stop').disabled`),true);
    await screenshot('cold-start-pending');
    await worker.evaluate(()=>globalThis.__releaseAuditStart());
    await until(async()=>{const review=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);return review?.status==='live';},'review starts on the current page');
    const review=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);
    assert.equal(review.target.url,production.url());assert.equal(Number.isInteger(review.sourceTabId),false);
    pass('Native cold start shows Starting your review without a false reconnect error');
    await until(()=>evaluate(`document.getElementById('panel-controls')?.checkVisibility()&&!document.getElementById('panel-diff').disabled`),'native sidebar connected with review controls');
    assert.equal(await evaluate(`document.querySelectorAll('#panel-comment,#panel-area').length`),0);
    assert.match(await evaluate(`document.querySelector('.shortcut-cheatsheet')?.textContent||document.getElementById('panel-instruction').textContent`),/comment/i);
    await screenshot('started-review-sidebar');
    assert.equal(await production.locator('diffuse-live-overlay').locator('#toolbar').isVisible(),false);
    pass('The real Start review gesture opens the native sidebar and starts this page without a floating toolbar');
    await worker.evaluate(async()=>{const s=(await chrome.storage.session.get('comparison')).comparison;const tab=await chrome.tabs.get(s.targetTabId);await chrome.sidePanel.close({windowId:tab.windowId});});
    assert.equal(await production.locator('diffuse-live-overlay').locator('#toolbar').isVisible(),false);
    await production.bringToFront();
    const activeTarget=(await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]})).targetInfos.find(t=>t.url===production.url());
    await cdp.send('Extensions.triggerAction',{id,targetId:activeTarget.targetId});
    await until(async()=>{popupTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/popup.html`);return popupTarget;},'reopen native popup');
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('session-panel')?.hidden===false&&document.getElementById('popup').getAttribute('aria-busy')==='false'`),'ongoing review launch');
    assert.equal(await evaluate(`document.getElementById('return-to-comparison').checkVisibility()`),true);
    assert.match(await evaluate(`document.getElementById('return-to-comparison').textContent`),/Open review sidebar/);
    await screenshot('ongoing-review');
    await click('return-to-comparison');
    await until(async()=> (await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`),'reopened sidebar');
    assert.equal((await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison)).id,review.id);
    pass('Closing and reopening the sidebar keeps the same review and shows an explicit Open review sidebar action');
    // Chrome disables browser zoom for extension pages and rejects CDP device
    // metrics override on this native action target. Do not substitute a normal
    // browser tab and claim it exercises native popup zoom.
    await writeFile(join(artifacts,'measurements.json'),JSON.stringify({chromeVersion:context.browser().version(),native,zoomMethod:'Native extension-page zoom and action-view CDP device metrics override are disabled by Chrome. This test validates the real native popup at default zoom; it does not claim200% popup zoom support.',results},null,2));
  }
}catch(error){
  console.log('NATIVE FAILURE',JSON.stringify(await evaluate(`(async()=>({surface:document.body.dataset.surface,text:document.body.innerText,session:(await chrome.storage.session.get('comparison')).comparison}))()`).catch(()=>null)));
  await screenshot('failure').catch(()=>{});
  throw error;
}finally{
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Popup test ended'));}pending.clear();
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}
