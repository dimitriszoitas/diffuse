// Disposable Chromium fixture. Commands originate from the drawer controller;
// no user profile, account, browser tabs or remote providers are used.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),artifacts=resolve(project,'artifacts/no-toolbar');
await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
try{
  const page=await browser.newPage({viewport:{width:1928,height:1115}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<!doctype html><title>Drawer review fixture</title><style>body{margin:80px;font:16px system-ui;color:#211a35;background:#f8f6fc}main{padding:36px;border:1px solid #ddd2ee;border-radius:16px;background:white;max-width:700px}button{padding:14px}</style><main><h1>Review your latest release</h1><p>A fictional page used to inspect Diffuse feedback.</p><button id="target">Create release</button></main>');
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
    window.calls=[];window.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;}},async sendMessage(message){
      window.calls.push(message);
      if(message.type==='GET_AI_CONFIG')return{ok:true,config:{hasKey:false,threshold:35}};
      if(message.type==='GET_AI_SUGGESTIONS')return{ok:true,batch:null};
      if(message.type==='STOP_RECORDING')return{ok:true,draft:{id:'draft',evidence:{production:{dataUrl:canvas.toDataURL()}}}};
      return{ok:true};
    }}};
    window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
  });
  for(const file of ['inspector.js','content.js'])await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const deliver=message=>page.evaluate(message=>window.deliver(message),message);
  const command=async(action,fields={})=>{const response=await deliver({type:'PANEL_COMMAND',action,...fields});assert.equal(response.ok,true,response.error);return response;};
  const overlay=page.locator('diffuse-live-overlay');
  const session={id:'review',mode:'audit',status:'live',settings:{hidden:true,opacity:.55,reveal:50,linked:false},commentCount:1,comments:[{id:'first',fields:{comment:'Check this action',category:'ux-issue'},selection:{selector:'#target'},context:{production:{url:'about:blank'}}}]};
  const noToolbar=async()=>{
    assert.equal(await overlay.locator('#toolbar').isVisible(),false);
    assert.equal(await overlay.locator('#toolbar').evaluate(node=>node.inert),true);
    assert.equal(await overlay.locator('#toolbar').getAttribute('aria-hidden'),'true');
    assert.equal(await overlay.locator('#toolbar-toggle,#toolbar-mini,#dock-sidebar').count(),0);
    assert.equal(await overlay.locator('#toolbar button:visible').count(),0);
  };
  for(const mode of ['audit','comparison']){
    await deliver({type:'INITIALIZE',role:'target',session:{...session,mode,sourceTabId:mode==='comparison'?1:null}});
    for(const viewport of [{width:1928,height:1115},{width:1280,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      for(const docked of [true,false]){await deliver({type:'DOCK_STATE',docked});await noToolbar();}
      await deliver({type:'PREPARE_EVIDENCE'});await noToolbar();
      await deliver({type:'RESTORE_EVIDENCE'});await noToolbar();
    }
  }
  assert.equal(await overlay.locator('.comment-pin').isVisible(),true);
  await command('selectArea');assert.equal(await overlay.locator('#picker-tip').isVisible(),true);
  await command('cancelSelection');assert.equal(await overlay.locator('#picker-tip').isVisible(),false);
  await command('openAi');assert.equal(await overlay.locator('#ai-panel').isVisible(),true);await noToolbar();
  await command('closeAi');assert.equal(await overlay.locator('#ai-panel').isVisible(),false);
  await command('openDiff');assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.type==='OPEN_DIFF').length),1);
  await deliver({type:'SESSION_UPDATE',session:{...session,recording:{id:'recording',startedAt:Date.now()-2000}}});
  await noToolbar();await command('stopRecording');
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.type==='STOP_RECORDING').length),1);
  assert.equal(await overlay.locator('#comment-panel').isVisible(),true);await noToolbar();
  await command('cancelComment');await command('openReport');
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.type==='OPEN_REPORT').length),1);
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:resolve(artifacts,'review-page.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS no floating controls in audit/comparison, desktop/laptop/phone, drawer open/closed, capture and recording; drawer commands and page pins remain usable');
}finally{await browser.close();}
