// Temporary extension/profile with fictional reviews. No user data or API calls.
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-review-visibility-'));
const extension=join(temp,'extension'),artifacts=join(project,'artifacts/review-visibility');
await cp(join(project,'extension'),extension,{recursive:true});await mkdir(artifacts,{recursive:true});
const errors=[],external=[],results=[];const pass=label=>{results.push(label);console.log(`PASS ${label}`);};
let context;
try{
  context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:{width:1440,height:960},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--use-mock-keychain','--password-store=basic']});
  await context.route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),extensionId=new URL(worker.url()).host;
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const reportUrl=`chrome-extension://${extensionId}/report.html`;
  await page.goto(reportUrl);
  const before=await page.evaluate(async()=>{
    const store=await import(chrome.runtime.getURL('review-store.mjs'));
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const drawing=canvas.getContext('2d');drawing.fillStyle='#f7f4fc';drawing.fillRect(0,0,640,360);drawing.fillStyle='#211a35';drawing.font='26px sans-serif';drawing.fillText('Fictional review evidence',30,60);
    for(const [id,title] of [['alpha','Fictional account review'],['beta','Fictional checkout review']]){
      const capturedAt='2026-09-26T19:30:00.000Z';
      const review={id,title,mode:'audit',productionUrl:`https://fixture.example.test/${id}`,createdAt:capturedAt,updatedAt:capturedAt};
      await store.putDraft({id:`draft-${id}`,reviewId:id,mode:'audit',createdAt:capturedAt,context:{production:{url:review.productionUrl,viewport:{width:640,height:360,dpr:1}}},evidence:{production:{dataUrl:canvas.toDataURL(),width:640,height:360,capturedAt}}},review);
      await store.addComment(`draft-${id}`,{title:`${title} observation`,comment:'Preserve this original comment and screenshot.',category:'ux-issue',state:'Default',severity:id==='alpha'?'major':'minor'});
    }
    return Promise.all(['alpha','beta'].map(id=>store.getReview(id)));
  });
  await page.goto(`${reportUrl}?review=alpha`);
  await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===2&&document.querySelector('#report-content').getAttribute('aria-busy')==='false');
  const row=id=>page.locator(`.review-row[data-review-id="${id}"]`);
  await row('alpha').getByRole('button',{name:'Hide Fictional account review',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===1&&document.querySelector('#notice').textContent.startsWith('Review hidden.'));
  assert.equal(await row('alpha').count(),0);assert.equal(await row('beta').count(),1);
  assert.deepEqual(await page.evaluate(()=>chrome.storage.local.get('diffuseHiddenReviewIds')),{diffuseHiddenReviewIds:['alpha']});
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===1);
  assert.equal(await row('alpha').count(),0);assert.equal(await row('beta').count(),1);
  pass('Hide removes a review from Saved and persists after reload without deleting its data');

  await page.locator('#review-view-hidden').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#review-view-hidden').getAttribute('aria-pressed')==='true'&&document.querySelector('#report-content').getAttribute('aria-busy')==='false');
  assert.equal(await row('alpha').count(),1);assert.equal(await row('beta').count(),0);
  assert.equal(await page.locator('.comment-card').count(),1);assert.match(await page.locator('.comment-card').textContent(),/Preserve this original comment/);
  assert.equal(await page.locator('#review-view-hidden').isEnabled(),true);
  await page.screenshot({path:join(artifacts,'hidden-review-desktop.png'),animations:'disabled'});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#review-view-hidden').getAttribute('aria-pressed')==='true');
  await row('alpha').getByRole('button',{name:'Restore Fictional account review',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===0&&document.querySelector('#notice').textContent==='Review restored to Saved.');
  await page.locator('#review-view-saved').click();await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===2);
  const after=await page.evaluate(async()=>{const store=await import(chrome.runtime.getURL('review-store.mjs'));return Promise.all(['alpha','beta'].map(id=>store.getReview(id)));});
  assert.deepEqual(after,before);
  pass('Hidden view is keyboard accessible; direct reload and Restore preserve every comment and evidence byte');

  await row('alpha').locator('.review-item').click();
  await page.waitForFunction(()=>document.querySelector('.comment-card h2')?.textContent==='Fictional account review observation');
  await page.getByRole('button',{name:'Edit observation',exact:true}).click();
  const severity=page.getByRole('radiogroup',{name:'Severity',exact:true});
  assert.equal(await severity.getByRole('radio',{name:'Major',exact:true}).isChecked(),true);
  const formSeverity=()=>page.evaluate(()=>{const form=document.querySelector('#edit-form');return{element:form.elements.namedItem('severity').localName,values:[...new FormData(form)].filter(([key])=>key==='severity')};});
  assert.deepEqual(await formSeverity(),{element:'select',values:[['severity','major']]});
  await page.locator('#edit-form [name=expected]').fill('Keep the existing severity when editing another field.');
  await page.locator('#save-comment').click();await page.waitForFunction(()=>!document.querySelector('#edit-dialog').open);
  const savedReview=()=>page.evaluate(async()=>(await import(chrome.runtime.getURL('review-store.mjs'))).getReview('alpha'));
  let edited=await savedReview();assert.equal(edited.comments[0].fields.severity,'major');
  assert.deepEqual(edited.comments[0].evidence,before[0].comments[0].evidence);
  await page.getByRole('button',{name:'Edit observation',exact:true}).click();
  await severity.getByRole('radio',{name:'Major',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await severity.getByRole('radio',{name:'Critical',exact:true}).isChecked(),true);
  assert.deepEqual(await formSeverity(),{element:'select',values:[['severity','critical']]});
  await page.screenshot({path:join(artifacts,'report-edit-severity.png'),animations:'disabled'});
  await page.locator('#save-comment').click();await page.waitForFunction(()=>!document.querySelector('#edit-dialog').open);
  edited=await savedReview();assert.equal(edited.comments[0].fields.severity,'critical');
  assert.deepEqual(edited.comments[0].evidence,before[0].comments[0].evidence);
  await page.reload();await page.getByRole('button',{name:'Edit observation',exact:true}).click();
  assert.equal(await severity.getByRole('radio',{name:'Critical',exact:true}).isChecked(),true);
  await page.locator('#cancel-edit').click();
  pass('Actual report severity radios keep the native form value, preserve unchanged severity, save keyboard changes and reload correctly');

  for(const id of ['alpha','beta']){
    await row(id).locator('.review-visibility-action').click();
    await page.waitForFunction(id=>!document.querySelector(`.review-row[data-review-id="${id}"]`),id);
  }
  assert.match(await page.locator('#report-content h2').textContent(),/Your reviews are in Hidden/);
  assert.equal(await page.locator('#export-toolbar').isVisible(),false);
  await page.locator('#review-view-hidden').click();await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===2);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const sizes=await page.locator('.review-visibility-action,.review-visibility-tabs button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));assert(sizes.every(height=>height>=44));
  assert.equal(await page.locator('#review-view-hidden').isEnabled(),true);
  await page.screenshot({path:join(artifacts,'hidden-reviews-phone.png'),animations:'disabled'});
  pass('Hiding all reviews has a recoverable empty state; controls fit a390px screen with44px targets');

  // A later permanent deletion must not leave stale local visibility IDs.
  await page.evaluate(async()=>{const store=await import(chrome.runtime.getURL('review-store.mjs'));await store.deleteReview('beta');});
  await page.locator('#refresh-reviews').click();await page.waitForFunction(()=>document.querySelectorAll('.review-row').length===1);
  assert.deepEqual(await page.evaluate(()=>chrome.storage.local.get('diffuseHiddenReviewIds')),{diffuseHiddenReviewIds:['alpha']});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  pass('Refreshing prunes visibility IDs for deleted reviews; no script errors or external requests');
  await writeFile(join(artifacts,'verification.json'),JSON.stringify({results,errors,externalRequests:external.length},null,2));
}finally{await context?.close();await rm(temp,{recursive:true,force:true});}
