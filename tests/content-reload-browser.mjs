// Extension reload invalidates existing content-script contexts. Exercise real
// DOM/event behavior with a local runtime stub in a disposable browser only.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),artifacts=resolve(project,'artifacts/content-reload');
const scripts=await Promise.all(['inspector.js','select-controls.js','content.js'].map(file=>readFile(resolve(project,'extension',file),'utf8')));
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const passed=[];
try{
  await mkdir(artifacts,{recursive:true});
  for(const mode of ['sync','async','missing-id','pending-ai']){
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><title>Reload recovery fixture</title><style>body{margin:40px;min-height:2400px;font:16px system-ui}</style><h1>Fictional review page</h1><button id="page-action">Page action</button>');
    await page.evaluate(()=>{
      window.calls=[];window.failure=null;window.unhandled=[];window.activeIntervals=new Set();window.activeTimeouts=new Set();
      addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason?.message||event.reason)));
      const interval=setInterval.bind(window),clearI=clearInterval.bind(window),timeout=setTimeout.bind(window),clearT=clearTimeout.bind(window);
      window.setInterval=(callback,delay,...args)=>{const id=interval(callback,delay,...args);window.activeIntervals.add(id);return id;};
      window.clearInterval=id=>{window.activeIntervals.delete(id);return clearI(id);};
      window.setTimeout=(callback,delay,...args)=>{const id=timeout(()=>{window.activeTimeouts.delete(id);callback(...args);},delay);window.activeTimeouts.add(id);return id;};
      window.clearTimeout=id=>{window.activeTimeouts.delete(id);return clearT(id);};
      window.RTCPeerConnection=class{
        constructor(){window.fixturePeer=this;this.iceGatheringState='complete';this.connectionState='new';this.closed=false;}
        async setRemoteDescription(){} async createAnswer(){return{};} async setLocalDescription(){this.localDescription={toJSON(){return{type:'answer',sdp:'fixture'};}};}
        close(){this.closed=true;} addEventListener(){} removeEventListener(){}
      };
      window.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}},sendMessage(message){
        window.calls.push(message);
        if(window.failure==='sync')throw new Error('Extension context invalidated.');
        if(window.failure==='async')return Promise.reject(new Error('Extension context invalidated.'));
        if(window.failure==='ordinary')return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        if(window.failure==='pending-save'&&message.type==='ADD_COMMENT')return new Promise(resolve=>window.resolveSave=resolve);
        if(message.type==='GET_AI_CONFIG')return Promise.resolve({ok:true,config:{hasKey:false,threshold:35}});
        if(message.type==='GET_AI_SUGGESTIONS'&&window.pauseSuggestions)return new Promise(resolve=>window.resolveSuggestions=resolve);
        if(message.type==='GET_AI_SUGGESTIONS')return Promise.resolve({ok:true,batch:null});
        return Promise.resolve({ok:true});
      }}};
      window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
    });
    await page.evaluate(mode=>window.pauseSuggestions=mode==='pending-ai',mode);
    for(const content of scripts)await page.addScriptTag({content});
    const deliver=message=>page.evaluate(message=>window.deliver(message),message);
    const session={id:'review',mode:'comparison',sourceTabId:1,status:'live',viewportPreset:'desktop',settings:{opacity:.55,reveal:50,linked:true,offsetX:0,offsetY:0},comments:[]};
    await deliver({type:'INITIALIZE',role:'target',session});
    await deliver({type:'RTC_OFFER',connectionId:'rtc-fixture',description:{type:'offer',sdp:'fixture'}});
    await deliver({type:'RECORDING_STOPPED',draft:{id:'draft-kept',selection:null,context:{production:{url:'about:blank'}},evidence:{},composerFields:{title:'Draft title',comment:'Keep this unsaved feedback after extension reload.',expected:'Keep the intended fix too.',state:'Default state',component:'Fixture',severity:'minor',category:'ux-issue'}}});
    const overlay=page.locator('diffuse-live-overlay');
    await overlay.locator('#comment-actual').fill('Keep my latest keystroke too.');
    assert.equal(await overlay.locator('#save-comment').isEnabled(),true);
    const category=overlay.getByRole('combobox',{name:'Category',exact:true}),severity=overlay.getByRole('radiogroup',{name:'Severity',exact:true});
    assert.equal(await category.count(),1);assert.equal(await severity.getByRole('radio').count(),3);
    await severity.getByRole('radio',{name:'Major',exact:true}).check();
    assert.equal(await overlay.locator('#comment-severity').inputValue(),'major');
    await page.waitForTimeout(180);
    if(mode==='sync'){
      await page.evaluate(()=>{window.failure='ordinary';dispatchEvent(new Event('resize'));});await page.waitForTimeout(220);
      assert.equal(await overlay.getAttribute('data-context-invalidated'),null,'An ordinary missing receiver must remain recoverable');
      assert.equal(await overlay.locator('#save-comment').isEnabled(),true);assert.ok(await page.evaluate(()=>activeIntervals.size)>0);
      await page.evaluate(()=>window.failure=null);
    }
    if(mode==='async'){
      await page.evaluate(()=>window.failure='pending-save');await overlay.locator('#save-comment').click();
      await page.waitForFunction(()=>typeof window.resolveSave==='function');
      assert.equal(await overlay.locator('#save-comment').isDisabled(),true);
    }
    if(mode==='missing-id')await deliver({type:'DOCK_STATE',docked:true});
    const before=await page.evaluate(()=>({calls:calls.length,intervals:activeIntervals.size,timeouts:activeTimeouts.size}));
    assert.ok(before.intervals>0);assert.ok(before.timeouts>0,'RTC setup should leave its deadline pending');
    await page.evaluate(mode=>{window.failure=mode==='pending-ai'?'sync':mode;if(mode==='missing-id')delete chrome.runtime.id;dispatchEvent(new Event('resize'));},mode);
    await page.waitForTimeout(400);
    if(mode==='async'){await page.evaluate(()=>window.resolveSave({ok:true,review:{count:1}}));await page.waitForTimeout(80);}
    if(mode==='pending-ai'){await page.evaluate(()=>window.resolveSuggestions({ok:true,batch:{id:'late-batch',suggestions:[{id:'late-finding',title:'Late response',comment:'This must never create an interactive control after reload.',expected:'Keep the frozen UI.',score:90,region:{x:0,y:0,width:.1,height:.1}}]}}));await page.waitForTimeout(80);assert.equal(await overlay.locator('.ai-suggestion').count(),0);}
    assert.equal(await overlay.count(),1,'The unfinished draft remains available on the page');
    assert.equal(await overlay.locator('#comment-actual').inputValue(),'Keep my latest keystroke too.');
    assert.equal(await overlay.locator('#comment-expected').inputValue(),'Keep the intended fix too.');
    assert.equal(await overlay.locator('#comment-title').inputValue(),'Draft title');
    assert.equal(await overlay.locator('#comment-title').evaluate(node=>node.readOnly),true,'Default-text inputs also remain copyable');
    assert.equal(await overlay.locator('#comment-panel').isVisible(),true,'Docked drafts are exposed for copying after invalidation');
    assert.equal(await overlay.locator('#save-comment').isDisabled(),true);
    assert.equal(await overlay.locator('#comment-actual').evaluate(node=>node.readOnly),true,'Draft text remains selectable for copying but cannot be edited');
    assert.equal(await overlay.locator('#context-reload-notice').isVisible(),true);
    assert.match(await overlay.locator('#context-reload-notice').textContent(),/Diffuse was updated.*Refresh this page/i);
    assert.equal(await overlay.getAttribute('data-context-invalidated'),'');
    assert.equal(await category.isDisabled(),true);
    assert.equal(await overlay.locator('.df-select-menu').count(),0);
    assert.equal(await severity.getByRole('radio',{name:'Major',exact:true}).isChecked(),true);
    assert.equal(await severity.getByRole('radio').evaluateAll(radios=>radios.every(radio=>radio.disabled)),true);
    assert.equal(await overlay.locator('#comment-category').getAttribute('aria-hidden'),'true');
    const text=await overlay.evaluate(host=>host.shadowRoot.textContent);
    assert.match(text,/reload|refresh/i,'The frozen UI explains how to restore the extension');
    const stopped=await page.evaluate(()=>({calls:calls.length,intervals:activeIntervals.size,timeouts:activeTimeouts.size,closed:fixturePeer.closed}));
    assert.equal(stopped.intervals,0,'Pin/recording loops stop when extension context is invalid');
    assert.equal(stopped.timeouts,0,'Delayed viewport, reconnect and RTC work is cancelled');
    assert.equal(stopped.closed,true,'The stale RTC connection is closed');
    assert.equal(stopped.calls-before.calls,mode==='missing-id'?0:1,'Only the first failing attempt reaches the old runtime');
    await page.evaluate(()=>{
      for(let i=0;i<4;i++){dispatchEvent(new Event('resize'));document.dispatchEvent(new Event('scroll'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',code:'KeyP',altKey:true,shiftKey:true,bubbles:true}));}
      document.querySelector('diffuse-live-overlay').shadowRoot.querySelector('#comment-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(()=>calls.length),stopped.calls,'Dead runtime is never retried by stale events or delayed work');
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>unhandled),[]);
    await page.screenshot({path:resolve(artifacts,`${mode}.png`)});
    const label=`${mode}: stale runtime freezes and retains the draft, stops async work, and produces no uncaught errors or retries`;
    passed.push(label);console.log(`PASS ${label}`);await page.close();
  }
  {
    const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><title>Idle source fixture</title><p>Fictional reference page.</p>');
    await page.evaluate(()=>{
      window.calls=[];window.activeIntervals=new Set();window.unhandled=[];
      addEventListener('unhandledrejection',event=>unhandled.push(String(event.reason)));
      const interval=setInterval.bind(window),clear=clearInterval.bind(window);
      window.setInterval=(callback,delay,...args)=>{const id=interval(callback,delay,...args);activeIntervals.add(id);return id;};
      window.clearInterval=id=>{activeIntervals.delete(id);clear(id);};
      window.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}},sendMessage(message){calls.push(message);return Promise.resolve({ok:true});}}};
      window.deliver=message=>new Promise(resolve=>receiver({namespace:'diffuse',sessionId:'source-review',...message},{id:'fixture'},resolve));
    });
    for(const content of scripts)await page.addScriptTag({content});
    await page.evaluate(()=>deliver({type:'INITIALIZE',role:'source',session:{id:'source-review',mode:'comparison',sourceTabId:1,targetTabId:2,settings:{linked:true}}}));
    assert.equal(await page.evaluate(()=>activeIntervals.size),1);
    await page.evaluate(()=>delete chrome.runtime.id);await page.waitForTimeout(1150);
    assert.equal(await page.evaluate(()=>activeIntervals.size),0,'Idle source context watcher shuts itself down');
    await page.evaluate(()=>{dispatchEvent(new Event('resize'));document.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>calls.length),0);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>unhandled),[]);
    const label='Idle source detects invalidation without user interaction and removes its watcher/listeners without runtime calls';passed.push(label);console.log(`PASS ${label}`);await page.close();
  }
  await writeFile(resolve(artifacts,'verification.json'),JSON.stringify({passed,provenance:'Runtime failure injection in a fresh isolated browser. No extension reload, user profile or network call.'},null,2));
}finally{await browser.close();}
