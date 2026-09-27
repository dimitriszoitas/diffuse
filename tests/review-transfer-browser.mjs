// Disposable extension/profile and fictional evidence only. No live page or API traffic.
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-transfer-'));
const extension=join(temp,'extension'),artifacts=join(project,'artifacts/review-transfer');
await cp(join(project,'extension'),extension,{recursive:true});await mkdir(artifacts,{recursive:true});
let context;const errors=[],external=[],results=[];const pass=label=>{results.push(label);console.log(`PASS ${label}`);};
try {
 context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:{width:1440,height:960},acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--use-mock-keychain','--password-store=basic']});
 await context.route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const id=new URL(worker.url()).host,page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`chrome-extension://${id}/report.html`);
 await page.waitForFunction(()=>document.querySelector('#report-content').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#import-review').isVisible(),true);assert.equal(await page.locator('.export-help').count(),0);
 assert.equal(await page.locator('.sidebar-settings').count(),1);assert.equal(await page.locator('.sidebar-settings').getAttribute('href'),'settings.html');
 const fixture=await page.evaluate(async()=>{
  const store=await import(chrome.runtime.getURL('review-store.mjs'));
  const capturedAt='2026-09-27T10:00:00.000Z';const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
  const drawing=canvas.getContext('2d');drawing.fillStyle='#f7f4fc';drawing.fillRect(0,0,640,360);drawing.fillStyle='#211a35';drawing.font='26px sans-serif';drawing.fillText('Portable fictional review',30,60);
  const image=canvas.toDataURL();
  const stream=canvas.captureStream(1),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
  const finished=new Promise(resolve=>{recorder.ondataavailable=event=>chunks.push(event.data);recorder.onstop=resolve;});recorder.start();await new Promise(resolve=>setTimeout(resolve,150));recorder.stop();await finished;stream.getTracks().forEach(track=>track.stop());
  const video=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
  const review={id:'original',title:'Fictional portable review',mode:'audit',productionUrl:'https://fixture.example.test/releases',createdAt:capturedAt,updatedAt:capturedAt};
  for(const [suffix,path,width,profile] of [['one','/releases',1440,'desktop'],['two','/releases/42?tab=activity#details',1280,'laptop']]){
   const url=`https://fixture.example.test${path}`,context={url,viewport:{width,height:900,dpr:1,visualScale:1},viewportProfile:{key:profile,mode:'preset'},scroll:{x:0,y:600},nestedScroll:[{selector:'#activity',x:0,y:240}]};
   await store.putDraft({id:`draft-${suffix}`,reviewId:'original',mode:'audit',createdAt:capturedAt,context:{production:context},selection:{schemaVersion:1,kind:'element',selector:'#activity',anchor:{version:1,kind:'element',selector:'#activity',identity:{tag:'div',attributes:{id:'activity'}}},context,rect:{viewport:{x:20,y:40,width:50,height:60},document:{x:20,y:640,width:50,height:60}}},evidence:{production:{dataUrl:image,annotatedDataUrl:image,cropDataUrl:image,crop:{x:20,y:40,width:50,height:60},width:640,height:360,capturedAt},video:{dataUrl:video,mimeType:'video/webm',filename:'fixture.webm',durationMs:150,startedAt:capturedAt,stoppedAt:capturedAt}}},review);
   await store.addComment(`draft-${suffix}`,{title:`Observation ${suffix}`,comment:'Keep the same evidence and location.',expected:'More space',state:'Expanded',severity:'major',category:'ux-issue'});
  }
  const original=await store.getReview('original'),first=original.comments[0];
  for(const [reviewId,commentId,offset] of [['different-review',first.id,{x:1,y:2}],['original','missing-comment',{x:1,y:2}],['original',first.id,{x:Infinity,y:0}],['original',first.id,{x:0,y:100001}],['original',first.id,{x:1}]]) {
   let rejected=false;try{await store.updateCommentPin(reviewId,commentId,offset);}catch{rejected=true;}
   if(!rejected)throw new Error('Invalid pin update was accepted');
  }
  if(JSON.stringify(await store.getReview('original'))!==JSON.stringify(original))throw new Error('Rejected pin updates changed saved data');
  const moved=await store.updateCommentPin('original',first.id,{x:125.5,y:-72.25,evidence:{production:'Do not replace'}});
  for(const key of ['id','reviewId','createdAt','fields','selection','context','evidence'])if(JSON.stringify(moved[key])!==JSON.stringify(first[key]))throw new Error(`Moving the pin changed ${key}`);
  if(JSON.stringify(moved.pinOffset)!==JSON.stringify({x:125.5,y:-72.25}))throw new Error('Pin display offset was not saved independently');
  const second=original.comments[1],pinSelection={...structuredClone(second.selection),selector:'#remapped',selectorFormat:'css',tagName:'button',component:{name:'Remapped component',source:'data-component'},anchor:{version:1,kind:'element',selector:'#remapped',identity:{tag:'button',attributes:{id:'remapped'}}},context:{...structuredClone(second.selection.context),scroll:{x:0,y:920},nestedScroll:[{selector:'#activity',x:0,y:180}]}};
  const beforeRemap=await store.getReview('original');
  for(const [reviewId,commentId,target] of [['different-review',second.id,pinSelection],['original','missing-comment',pinSelection],['original',second.id,{}],['original',second.id,{...pinSelection,context:{...pinSelection.context,url:'https://other.example.test/'}}]]){
   let rejected=false;try{await store.remapCommentPin(reviewId,commentId,target,{x:32.5,y:70});}catch{rejected=true;}
   if(!rejected)throw new Error('Invalid remapping was accepted');
  }
  if(JSON.stringify(await store.getReview('original'))!==JSON.stringify(beforeRemap))throw new Error('Rejected remapping changed saved data');
  await store.updateCommentPin('original',second.id,{x:80,y:20});
  const remapped=await store.remapCommentPin('original',second.id,{...pinSelection,unknownCredential:'never save'},{x:32.5,y:70});
  for(const key of ['id','reviewId','createdAt','fields','selection','context','evidence'])if(JSON.stringify(remapped[key])!==JSON.stringify(second[key]))throw new Error(`Remapping the pin changed ${key}`);
  if(JSON.stringify(remapped.pinPoint)!==JSON.stringify({x:.25,y:.5})||JSON.stringify(remapped.pinOffset)!==JSON.stringify({x:0,y:0})||remapped.pinSelection.selector!=='#remapped'||remapped.pinSelection.unknownCredential)throw new Error('Remapped attachment was not stored independently and sanitized');
  const area={schemaVersion:1,kind:'region',component:{name:'Selected area',source:'region'},rect:{viewport:{x:20,y:40,width:180,height:90},document:{x:20,y:960,width:180,height:90}},context:structuredClone(pinSelection.context)};
  const areaSaved=await store.remapCommentPin('original',second.id,area);
  if(areaSaved.pinSelection.kind!=='region'||Object.hasOwn(areaSaved,'pinPoint'))throw new Error('Area remapping did not replace the element attachment and clear its point');
  for(const key of ['selection','context','fields','evidence'])if(JSON.stringify(areaSaved[key])!==JSON.stringify(second[key]))throw new Error(`Area remapping changed captured ${key}`);
  const {createReviewBundle}=await import(chrome.runtime.getURL('review-transfer.mjs'));
  const importedArea=await store.importReview(createReviewBundle(await store.getReview('original')));
  const areaRoundtrip=(await store.getReview(importedArea.review.id)).comments[1];
  if(JSON.stringify(areaRoundtrip.pinSelection)!==JSON.stringify(areaSaved.pinSelection)||Object.hasOwn(areaRoundtrip,'pinPoint'))throw new Error('Area attachment did not survive portable import');
  await store.deleteReview(importedArea.review.id);
  await store.remapCommentPin('original',second.id,pinSelection,{x:32.5,y:70});
  return store.getReview('original');
 });
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.comment-card').length===2);
 assert.deepEqual(await page.evaluate(async()=>(await (await import(chrome.runtime.getURL('review-store.mjs'))).getReview('original')).comments[0].pinOffset),{x:125.5,y:-72.25});
 assert.deepEqual(await page.evaluate(async()=>(await (await import(chrome.runtime.getURL('review-store.mjs'))).getReview('original')).comments[1].pinSelection),fixture.comments[1].pinSelection);
 pass('Pin movement, normalized element drops and area remapping survive real IndexedDB reload/import; wrong review/comment IDs, invalid coordinates and foreign page attachments leave saved data unchanged');
 const actions=page.locator('#review-actions-toggle'),menu=page.locator('#review-actions-menu');
 assert.equal(await page.locator('.workspace h1').count(),1);
 assert.equal(await page.locator('#report-content h1').count(),0);
 assert.equal(await page.locator('#review-header-copy h1').textContent(),fixture.title);
 assert.match(await page.locator('#review-header-copy .review-summary').textContent(),/2 observations/);
 assert.equal(await page.getByRole('heading',{name:'Share review',exact:true}).count(),0);
 assert.equal(await page.locator('#export-toolbar #delete-review').isVisible(),true);
 assert.equal(await page.locator('#export-toolbar #review-actions-toggle').isVisible(),true);
 assert.equal(await menu.isVisible(),false);assert.equal(await actions.getAttribute('aria-expanded'),'false');
 await actions.click();
 assert.equal(await menu.getAttribute('role'),'menu');assert.equal(await actions.getAttribute('aria-expanded'),'true');
 const actionIds=['open-review','export-review','copy-report','download-html','download-markdown'];
 assert.deepEqual(await menu.getByRole('menuitem').evaluateAll(items=>items.map(item=>item.id)),actionIds);
 for(const actionId of actionIds)assert.equal(await menu.locator(`#${actionId}`).isVisible(),true);
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
 assert.equal(await actions.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#open-review').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#export-review').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('End');assert.equal(await page.locator('#download-markdown').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Home');assert.equal(await page.locator('#open-review').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowUp');assert.equal(await page.locator('#download-markdown').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Tab');assert.equal(await menu.isVisible(),false);assert.equal(await actions.getAttribute('aria-expanded'),'false');
 await actions.click();await page.locator('#review-header-copy h1').click();assert.equal(await menu.isVisible(),false);
 pass('Review title, summary, Delete and one actions trigger share a single header; all five menu actions support arrow keys, Home/End, Escape, Tab and outside dismissal');
 const downloadPromise=page.waitForEvent('download');await actions.click();await page.locator('#export-review').click();const download=await downloadPromise;
 assert.equal(await menu.isVisible(),false);assert.equal(await actions.evaluate(el=>el===document.activeElement),true);
 assert.match(download.suggestedFilename(),/\.diffuse-review\.json$/);
 const bytes=await readFile(await download.path()),bundle=JSON.parse(bytes);assert.equal(bundle.review.comments.length,2);
 assert.equal(bundle.review.comments[1].context.production.url,fixture.comments[1].context.production.url);
 assert.deepEqual(bundle.review.comments[0].evidence,fixture.comments[0].evidence);assert.equal(bundle.review.id,undefined);
 assert.deepEqual(bundle.review.comments[0].pinOffset,fixture.comments[0].pinOffset);assert.deepEqual(bundle.review.comments[1].pinPoint,{x:.25,y:.5});assert.deepEqual(bundle.review.comments[1].pinOffset,{x:0,y:0});assert.deepEqual(bundle.review.comments[1].pinSelection,fixture.comments[1].pinSelection);
 pass('Actual Export review download retains both paths, viewport presets, anchors, moved pin position, remapped component, screenshots and a real WebM recording');
 const htmlDownloadPromise=page.waitForEvent('download');await actions.click();await page.locator('#download-html').click();const htmlDownload=await htmlDownloadPromise;
 assert.match(htmlDownload.suggestedFilename(),/\.html$/);
 const exportedHtml=await readFile(await htmlDownload.path(),'utf8');assert.match(exportedHtml,/data:image\/png;base64,/);assert.match(exportedHtml,/data:video\/webm/);assert.match(exportedHtml,/Observation one/);
 assert.equal(await menu.isVisible(),false);assert.equal(await actions.evaluate(el=>el===document.activeElement),true);
 pass('HTML download remains available in the custom menu and retains embedded screenshots and playable recording data');
 await page.goto(`chrome-extension://${id}/report.html?load=1`);
 await page.locator('#choose-review-file').waitFor({state:'visible'});
 assert.equal(await page.locator('#choose-review-file').evaluate(el=>el===document.activeElement),true);
 const canceled=page.waitForEvent('filechooser');await page.locator('#choose-review-file').click();await (await canceled).setFiles([]);
 assert.equal(await page.locator('#load-review-panel').isVisible(),true);
 assert.equal(await page.locator('.review-row').count(),1);
 const invalid=page.waitForEvent('filechooser');await page.locator('#choose-review-file').click();await (await invalid).setFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
 await page.waitForFunction(()=>document.querySelector('#notice').dataset.type==='error');
 assert.equal(await page.locator('#load-review-panel').isVisible(),true);
 assert.equal(await page.locator('.review-row').count(),1);
 assert.equal(await page.locator('#choose-review-file').isEnabled(),true);
 await page.screenshot({path:join(artifacts,'load-review.png'),animations:'disabled'});
 pass('Load review opens a focused file loader; cancel and invalid files keep saved reviews intact and allow retry');
 // Isolate the notebook's import behavior from separate navigation tests. Simulate a recipient needing site access.
 await page.evaluate(()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=message=>message?.type==='OPEN_REVIEW'?Promise.resolve({ok:false,error:'Allow Diffuse to access this page before continuing.'}):send(message);});
 for(let index=0;index<2;index++) {
  const chooser=page.waitForEvent('filechooser');await page.locator(index===0?'#choose-review-file':'#import-review').click();await (await chooser).setFiles({name:'shared.diffuse-review.json',mimeType:'application/json',buffer:bytes});
  await page.waitForFunction(count=>document.querySelectorAll('.review-row').length===count&&document.querySelector('#notice').textContent.includes('Review imported and saved.'),index+2);
  await actions.click();assert.equal(await page.locator('#open-review').isVisible(),true);await page.keyboard.press('Escape');
  assert.equal(await page.locator('#load-review-panel').isVisible(),false);
  assert.equal(new URL(page.url()).searchParams.has('load'),false);
 }
 const saved=await page.evaluate(async()=>{const store=await import(chrome.runtime.getURL('review-store.mjs'));return Promise.all((await store.listReviews()).map(review=>store.getReview(review.id)));});
 assert.equal(saved.length,3);assert.equal(new Set(saved.map(review=>review.id)).size,3);
 assert.equal(new Set(saved.flatMap(review=>review.comments.map(comment=>comment.id))).size,6);
 assert.deepEqual(saved.find(review=>review.id==='original'),fixture);
 for(const review of saved.filter(review=>review.id!=='original')) {
  assert.equal(review.comments.length,2);assert.equal(review.comments[0].reviewId,review.id);
  for(let index=0;index<2;index++)for(const key of ['fields','context','selection','evidence','pinOffset','pinSelection','pinPoint'])assert.deepEqual(review.comments[index][key],fixture.comments[index][key]);
 }
 pass('Two real IndexedDB imports create fresh IDs atomically, preserve every media byte and location, and keep the original unchanged');
 assert.match(await page.locator('#notice').textContent(),/Use Open review page to try again/);
 const bad=structuredClone(bundle);bad.review.comments[0].evidence.production.dataUrl='https://remote.example.test/track.png';
 await page.locator('#import-review-file').setInputFiles({name:'unsafe.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bad))});
 await page.waitForFunction(()=>document.querySelector('#notice').dataset.type==='error');
 assert.equal(await page.locator('.review-row').count(),3);
 assert.equal(await page.evaluate(async()=>(await (await import(chrome.runtime.getURL('review-store.mjs'))).listReviews()).length),3);
 pass('Malformed imported media is rejected before any storage change or remote request; permission fallback keeps the imported review available');
 await actions.click();await page.locator('#refresh-reviews').evaluate(button=>button.click());await page.waitForFunction(()=>!document.querySelector('#refresh-reviews').disabled);
 assert.equal(await menu.isVisible(),false);assert.equal(await actions.getAttribute('aria-expanded'),'false');
 pass('Refreshing the selected review closes the menu so stale actions never remain open');
 await page.locator('#toggle-review-sidebar').click();assert.equal(await page.locator('#toggle-review-sidebar').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#review-list').isVisible(),false);
 assert.equal(await page.locator('.sidebar-settings').isVisible(),true);
 await page.reload();await page.waitForFunction(()=>document.body.classList.contains('review-sidebar-collapsed'));
 assert.equal(await page.locator('#toggle-review-sidebar').getAttribute('aria-label'),'Expand review sidebar');
 await page.locator('#toggle-review-sidebar').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#review-list').isVisible(),true);
 await page.screenshot({path:join(artifacts,'portable-review-desktop.png'),animations:'disabled'});
 for(const width of [768,390,320]) {
  await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await actions.click();const bounds=await menu.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,`Actions menu fits ${width}px without clipping`);assert.ok(bounds.y>=0&&bounds.y+bounds.height<=900,`Actions menu remains within the ${width}px viewport`);
  await page.keyboard.press('Escape');await page.locator('#toggle-review-sidebar').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('#toggle-review-sidebar').click();
 }
 await page.screenshot({path:join(artifacts,'portable-review-phone.png'),animations:'disabled'});
 pass('Sidebar collapse persists, remains keyboard accessible, and import/settings controls fit desktop, tablet and narrow phones');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(join(artifacts,'verification.json'),JSON.stringify({results,errors,externalRequests:external.length},null,2));
} finally {await context?.close();await rm(temp,{recursive:true,force:true});}
