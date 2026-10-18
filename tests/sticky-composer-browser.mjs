// Disposable browser fixture: real sidebar markup/controller, simulated page bridge.
// Comments live on the page; the sidebar must remain a usable review overview.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),out=resolve(project,'artifacts/sticky-composer');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
try {
  const errors=[],page=await browser.newPage({viewport:{width:380,height:700}});page.on('pageerror',error=>errors.push(error.message));
  await page.setContent((await readFile(resolve(project,'extension/sidepanel.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,''));
  for(const file of ['popup.css','sidepanel.css','viewport-panel.css','ui-chrome.css','ui-theme.css','ui.css','ui-dark.css'])await page.addStyleTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  await page.evaluate(()=>{
    window.session={id:'session',mode:'audit',target:{title:'Demo page'},settings:{},comments:[{id:'saved',fields:{comment:'Keep the action clear.',category:'ux-issue',severity:'minor'}}]};
    window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
    window.snapshot={view:'comment',active:true,comment:{id:'draft',evidenceKey:'draft:1',evidenceIncluded:true,evidence:{},fields:{title:'',comment:'Feedback stays on the page.',expected:'',component:'Primary action',state:'Default',steps:'',severity:'minor',category:'ux-issue'},fieldRevisions:{}}};
    window.commands=[];window.disconnected=false;window.failFocus=false;
    const event=()=>({addListener(){}});
    window.chrome={runtime:{connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(m){
      if(m.type==='PANEL_STATE')return{ok:true,session:window.session,state:window.disconnected?{active:true,available:false,code:'PANEL_PAGE_DISCONNECTED',message:'The page connection was interrupted. Reconnect the review to continue.'}:structuredClone(window.snapshot)};
      window.commands.push(m);
      if(m.action==='focusComment'&&window.failFocus){window.disconnected=true;return{ok:false,code:'PANEL_PAGE_DISCONNECTED',error:'The page connection was interrupted.'};}
      if(m.action==='recoverPage'){window.disconnected=false;window.failFocus=false;window.snapshot.comment.fields=m.fields;}
      return{ok:true,session:window.session};
    }},tabs:{onActivated:event(),onUpdated:event()},windows:{getCurrent:async()=>({id:1})}};
  });
  await page.addScriptTag({content:await readFile(resolve(project,'extension/sidepanel.js'),'utf8')});
  await page.waitForSelector('#panel-return-comment');
  assert.equal(await page.locator('#panel-comment-form,#panel-field-title,#panel-field-component,#panel-field-state').count(),0);
  assert.equal(await page.locator('#panel-controls').isVisible(),true);
  assert.equal(await page.locator('#panel-comments').isVisible(),true);
  assert.equal(await page.locator('#panel-comments .saved-item').isDisabled(),true,'Opening saved feedback cannot navigate away from an unfinished page comment');
  assert.equal(await page.locator('#settings').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),true,'Sidebar refresh must not move focus away from the page composer');
  for(const [width,height,theme] of [[380,700,'light'],[320,480,'dark'],[600,800,'light']]){
    await page.setViewportSize({width,height});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.locator('#panel-return-comment').scrollIntoViewIfNeeded();
    const bounds=await page.locator('#panel-return-comment').evaluate(button=>{const b=button.getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height,viewport:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth};});
    assert(bounds.top>=0&&bounds.bottom<=height+1&&bounds.height>=44);assert.equal(bounds.overflow,0);
    await page.locator('#settings').scrollIntoViewIfNeeded();assert.equal(await page.locator('#settings').isVisible(),true);
    await page.screenshot({path:resolve(out,`page-comment-status-${width}-${theme}.png`)});
  }
  console.log('PASS A compact comment status keeps review tools and Settings available at narrow widths in both themes.');
  await page.locator('#panel-return-comment').click();
  await page.waitForFunction(()=>window.commands.some(message=>message.action==='focusComment'));
  const focus=await page.evaluate(()=>window.commands.find(message=>message.action==='focusComment'));
  assert.equal(focus.draftId,'draft');assert.equal(focus.fields,undefined);
  assert.equal(await page.evaluate(()=>window.commands.some(message=>message.action==='setCommentFields'||message.action==='saveComment')),false);
  console.log('PASS Return to comment focuses the page draft without a second sidebar editor or save path.');
  await page.evaluate(()=>{window.snapshot.commentSaving=true;window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>document.querySelector('#panel-composer-title').textContent==='Saving comment…');
  assert.equal(await page.locator('#panel-return-comment').isDisabled(),true);
  await page.evaluate(()=>{window.snapshot.commentSaving=false;window.snapshot.recording={startedAt:Date.now()};window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>document.querySelector('#panel-composer-title').textContent==='Recording in progress');
  assert.equal(await page.locator('#panel-return-comment').isDisabled(),true);
  assert.equal(await page.locator('#panel-record').isDisabled(),false);
  await page.evaluate(()=>{window.snapshot.recording=null;window.failFocus=true;window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>!document.querySelector('#panel-return-comment').disabled);
  await page.locator('#panel-return-comment').click();
  await page.waitForSelector('#panel-recover-comment:not([hidden])');
  assert.equal(await page.locator('#panel-return-comment').isDisabled(),true);
  assert.match(await page.locator('#panel-comment-error').textContent(),/connection was interrupted/);
  await page.locator('#panel-recover-comment').click();
  await page.waitForFunction(()=>document.querySelector('#panel-recover-comment').hidden&&!document.querySelector('#panel-return-comment').disabled);
  assert.equal(await page.evaluate(()=>window.commands.find(message=>message.action==='recoverPage').fields.comment),'Feedback stays on the page.');
  assert.equal(await page.evaluate(()=>window.commands.some(message=>message.action==='saveComment')),false);
  await page.evaluate(()=>{window.snapshot={view:'controls',active:true};window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForFunction(()=>document.querySelector('#panel-composer').hidden);
  assert.equal(await page.locator('#panel-controls').isVisible(),true);
  assert.equal(await page.locator('#panel-comments .saved-item').isDisabled(),false,'Saved comments become navigable once the draft closes');
  await page.evaluate(()=>{window.snapshot={view:'comment',commentOpen:true,active:true,pendingCaptureAction:'comment',comment:null};window.dispatchEvent(new Event('diffuse-refresh'));});
  await page.waitForSelector('#panel-return-comment');
  assert.equal(await page.locator('#panel-comments .saved-item').isDisabled(),true,'A failed initial capture still holds an unsaved comment');
  assert.equal(await page.locator('#panel-ai').isDisabled(),true);
  assert.equal(await page.locator('#panel-record').isDisabled(),true);
  assert.equal(await page.locator('#panel-return-comment').isDisabled(),false,'Capture failure can return to the unsaved text without a persisted draft ID');
  assert.match(await page.locator('#panel-comment-status').textContent(),/Retry its capture/);
  assert.deepEqual(errors,[]);
  console.log('PASS Recording, saving and connection recovery keep the sidebar status accurate without resubmitting a comment.');
} finally {await browser.close();}
