// Disposable controller UI fixture. Native metrics/capture are tested separately.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.setContent('<!doctype html><style>body{margin:60px;font:16px system-ui}#target{width:200px;height:60px;margin-top:50px}</style><h1>Viewport fixture</h1><button id="target">Review this</button>');
  await page.evaluate(()=>{
    window.messages=[];
    window.chrome={runtime:{id:'fixture',onMessage:{addListener(callback){window.receiver=callback;}},async sendMessage(message){window.messages.push(message);return window.rejectViewport&&message.type==='VIEWPORT_PRESET'?{ok:false,error:'Close DevTools before switching viewports.'}:{ok:true};}}};
    window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
  });
  for(const file of ['inspector.js','content.js'])await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const comments=['desktop','tablet','phone'].map((key,index)=>({id:key,fields:{comment:`${key} finding`,category:'ux-issue'},selection:{selector:'#target'},context:{production:{url:'about:blank',viewportProfile:{key},viewport:{width:[1440,1024,390][index],height:900}}}}));
  const session={id:'review',mode:'audit',status:'live',settings:{hidden:true},comments};
  const deliver=message=>page.evaluate(message=>window.deliver(message),message);
  await deliver({type:'INITIALIZE',role:'target',session});
  const overlay=page.locator('diffuse-live-overlay');
  assert.equal(await overlay.locator('.comment-pin').count(),1);
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'desktop');
  assert.equal((await deliver({type:'GET_CONTEXT'})).context.viewportProfile.key,'desktop');
  await overlay.locator('[data-preset="phone"]').click();
  assert.deepEqual(await page.evaluate(()=>{const message=window.messages.find(m=>m.type==='VIEWPORT_PRESET');return{type:message.type,preset:message.preset,sessionId:message.sessionId};}),{type:'VIEWPORT_PRESET',preset:'phone',sessionId:'review'});
  await page.setViewportSize({width:390,height:844});
  await deliver({type:'SESSION_UPDATE',session:{...session,viewportPreset:'phone'}});
  assert.equal(await overlay.locator('.comment-pin').count(),1);
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'phone');
  assert.equal((await deliver({type:'GET_CONTEXT'})).context.viewportProfile.key,'phone');
  assert.equal(await overlay.locator('[data-preset="phone"]').getAttribute('aria-pressed'),'true');
  const toolbar=await overlay.locator('#toolbar').evaluate(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,overflow:node.scrollWidth-node.clientWidth}));
  assert.ok(toolbar.left>=0&&toolbar.right<=390);assert.equal(toolbar.overflow,0);
  await overlay.locator('[data-preset="desktop"]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.type==='VIEWPORT_PRESET').at(-1).preset),'desktop');
  await deliver({type:'SESSION_UPDATE',session:{...session,viewportPreset:'desktop'}});
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'desktop');
  await page.evaluate(()=>window.rejectViewport=true);
  await overlay.locator('[data-preset="phone"]').click();
  assert.match(await overlay.locator('#warning').textContent(),/Close DevTools/);
  await deliver({type:'PREPARE_EVIDENCE'});assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  await deliver({type:'RESTORE_EVIDENCE'});assert.equal(await overlay.locator('#toolbar').isVisible(),true);
  await mkdir(resolve(project,'artifacts/viewport-ui'),{recursive:true});
  await page.screenshot({path:resolve(project,'artifacts/viewport-ui/phone-controls.png')});
  console.log('PASS preset actions, keyboard, captured profile, isolated comments, narrow layout and evidence hiding');
}finally{await browser.close();}
