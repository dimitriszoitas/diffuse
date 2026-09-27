// Disposable browser fixture: actual drawer markup/controller, simulated bridge.
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
  const page=await browser.newPage({viewport:{width:380,height:700}});page.on('pageerror',error=>console.error(error.message));
  await page.setContent((await readFile(resolve(project,'extension/sidepanel.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,''));
  for(const file of ['popup.css','sidepanel.css','ui-theme.css'])await page.addStyleTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  await page.evaluate(()=>{
    if(!crypto.randomUUID)crypto.randomUUID=()=> 'fixture-editor';
    window.session={id:'session',mode:'audit',target:{title:'Demo page'},settings:{},comments:[]};
    window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
    window.snapshot={view:'comment',active:true,comment:{id:'draft',evidenceKey:'draft:1',evidenceIncluded:true,evidence:{},fields:{title:'',comment:'',expected:'',component:'Primary action',state:'Default',steps:'',severity:'minor',category:'ux-issue'},fieldRevisions:{}}};
    window.commands=[];window.disconnected=false;window.failSave=true;
    const event=()=>({addListener(){}});
    window.chrome={runtime:{connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(m){
      if(m.type==='PANEL_STATE')return{ok:true,session:window.session,state:window.disconnected?{active:true,available:false,code:'PANEL_PAGE_DISCONNECTED',message:'The page connection was interrupted. Reconnect the review, then save again.'}:structuredClone(window.snapshot)};
      window.commands.push(m);
      if(m.action==='saveComment'&&window.failSave){window.disconnected=true;return{ok:false,code:'PANEL_PAGE_DISCONNECTED',error:'The page connection was interrupted. Reconnect the review, then save again.'};}
      if(m.action==='recoverPage'){window.disconnected=false;window.failSave=false;window.snapshot.comment.fields=m.fields;}
      if(m.action==='setCommentFields'){window.snapshot.comment.fields=m.fields;window.snapshot.comment.fieldRevisions[m.editorId]=m.fieldRevision;}
      if(m.action==='saveComment'){window.snapshot={view:'controls',active:true};}
      return{ok:true,session:window.session};
    }},tabs:{onActivated:event(),onUpdated:event()},windows:{getCurrent:async()=>({id:1})}};
  });
  await page.addScriptTag({content:await readFile(resolve(project,'extension/sidepanel.js'),'utf8')});
  await page.waitForSelector('body[data-composer-open=true]');
  const geometry=()=>page.evaluate(()=>{const b=document.querySelector('#panel-save-comment').getBoundingClientRect();return{top:b.top,bottom:b.bottom,height:b.height,viewport:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth};});
  for(const [width,height] of [[380,700],[320,480],[600,800]]){
    await page.setViewportSize({width,height});
    for(const end of [false,true]){
      await page.locator('.panel-composer-scroll').evaluate((el,end)=>el.scrollTop=end?el.scrollHeight:0,end);
      const b=await geometry();assert(b.top>=0&&b.bottom<=height+1&&b.height>=44);assert.equal(b.overflow,0);
    }
  }
  console.log('PASS Save remains visible at both ends of the form in narrow and short drawers.');
  await page.setViewportSize({width:380,height:700});
  await page.locator('#panel-field-comment').fill('The page connection must not lose this comment.');
  await page.locator('#panel-save-comment').click();
  await page.waitForSelector('#panel-recover-comment:not([hidden])');
  assert.equal(await page.locator('#panel-field-comment').inputValue(),'The page connection must not lose this comment.');
  assert.equal(await page.locator('#panel-save-comment').isDisabled(),true);
  const error=await page.locator('#panel-comment-error').boundingBox();assert(error.y>=0&&error.y+error.height<=700);
  await page.screenshot({path:resolve(out,'connection-recovery.png')});
  await page.locator('#panel-field-comment').fill('Edited while disconnected.');
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#panel-field-comment').inputValue(),'Edited while disconnected.');
  await page.locator('#panel-recover-comment').click();
  await page.waitForSelector('#panel-recover-comment[hidden]',{state:'attached'});
  assert.equal(await page.evaluate(()=>window.commands.filter(m=>m.action==='saveComment').length),1);
  assert.equal(await page.evaluate(()=>window.commands.find(m=>m.action==='recoverPage').fields.comment),'Edited while disconnected.');
  await page.locator('#panel-save-comment').click();
  await page.waitForSelector('body[data-composer-open=false]');
  assert.equal(await page.evaluate(()=>window.commands.filter(m=>m.action==='saveComment').length),2);
  console.log('PASS Connection failure preserves editable draft and visible error; reconnect does not repeat Save.');
} finally {await browser.close();}
