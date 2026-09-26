// Real extension reload in a disposable Chromium profile; no user browser or account.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const temp=await mkdtemp(join(tmpdir(),'diffuse-context-reload-'));
const extension=join(temp,'extension');await mkdir(extension);
for(const file of ['inspector.js','select-controls.js','content.js'])await cp(join(project,'extension',file),join(extension,file));
await writeFile(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Diffuse reload fixture',version:'1.0',permissions:['tabs'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'worker.js'},content_scripts:[{matches:['http://127.0.0.1/*'],js:['inspector.js','select-controls.js','content.js']}]}));
await writeFile(join(extension,'worker.js'),`chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(message.namespace==='diffuse')respond({ok:true,batch:null});});`);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Reload fixture</title><style>body{font:18px system-ui;margin:60px;min-height:3000px}</style><h1>Local page stays usable</h1><button id="page-action">Page action</button>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),headless:true,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--use-mock-keychain','--password-store=basic',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const cdp=await browser.newCDPSession(page);await cdp.send('Runtime.enable');cdp.on('Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails.exception?.description||event.exceptionDetails.text));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
  const result=await worker.evaluate(async()=>{
    const [tab]=await chrome.tabs.query({url:'http://127.0.0.1/*'});
    return chrome.tabs.sendMessage(tab.id,{namespace:'diffuse',type:'INITIALIZE',role:'target',session:{id:'reload-fixture',mode:'audit',status:'live',settings:{hidden:true},comments:[]}});
  });assert.equal(result.ok,true);
  const overlay=page.locator('diffuse-live-overlay');await overlay.waitFor({state:'attached'});
  const draftResult=await worker.evaluate(async()=>{
    const [tab]=await chrome.tabs.query({url:'http://127.0.0.1/*'});
    return chrome.tabs.sendMessage(tab.id,{namespace:'diffuse',sessionId:'reload-fixture',type:'RECORDING_STOPPED',draft:{id:'native-draft',selection:null,context:{production:{url:tab.url}},evidence:{},composerFields:{title:'Native reload draft',comment:'Keep this unfinished review.',expected:'Keep the requested change.',state:'Default state',component:'Fixture',category:'ux-issue',severity:'minor'}}});
  });assert.equal(draftResult.ok,true,draftResult.error);
  await overlay.locator('#comment-actual').fill('Keep my latest words through an extension update.');
  const category=overlay.getByRole('combobox',{name:'Category',exact:true}),severity=overlay.getByRole('radiogroup',{name:'Severity',exact:true});
  assert.equal(await category.count(),1);assert.equal(await severity.getByRole('radio').count(),3);
  await severity.getByRole('radio',{name:'Major',exact:true}).check();assert.equal(await overlay.locator('#comment-severity').inputValue(),'major');
  await category.click();assert.equal(await category.getAttribute('aria-expanded'),'true');
  assert.equal(await overlay.locator('.df-select-menu:not([hidden])').count(),1);
  // This destroys the actual extension context, leaving its page DOM and events behind.
  await worker.evaluate(()=>chrome.runtime.reload()).catch(error=>{if(!/closed|destroyed|Target|context/i.test(error.message))throw error;});
  await overlay.locator('#context-reload-notice').waitFor({state:'visible',timeout:15000});
  assert.match(await overlay.locator('#context-reload-notice').textContent(),/Refresh this page/);
  assert.equal(await overlay.locator('#comment-actual').inputValue(),'Keep my latest words through an extension update.');
  assert.equal(await overlay.locator('#comment-title').inputValue(),'Native reload draft');
  assert.equal(await overlay.locator('#comment-expected').inputValue(),'Keep the requested change.');
  assert.equal(await overlay.locator('#comment-actual').evaluate(node=>node.readOnly),true);
  assert.equal(await overlay.locator('#save-comment').isDisabled(),true);
  assert.equal(await category.isDisabled(),true);assert.equal(await category.getAttribute('aria-expanded'),'false');
  assert.equal(await overlay.locator('.df-select-menu').count(),0,'The open popup is removed after native context invalidation');
  assert.equal(await severity.getByRole('radio',{name:'Major',exact:true}).isChecked(),true);
  assert.equal(await severity.getByRole('radio').evaluateAll(radios=>radios.every(radio=>radio.disabled)),true);
  assert.equal(await overlay.locator('#comment-category').getAttribute('aria-hidden'),'true','The stale UI never falls back to a browser-native select');
  await page.setViewportSize({width:1000,height:800});await page.evaluate(()=>window.scrollTo(0,600));
  await page.locator('#page-action').click();
  await page.waitForTimeout(1400);
  assert.deepEqual(errors,[]);
  const artifacts=join(project,'artifacts/content-reload');await mkdir(artifacts,{recursive:true});
  await page.screenshot({path:join(artifacts,'native-reload.png')});
  await overlay.locator('#dismiss-reload-notice').click();assert.equal(await overlay.count(),0);
  await page.reload();assert.equal(await overlay.count(),0);
  await writeFile(join(artifacts,'native-verification.json'),JSON.stringify({realRuntimeReload:true,customWidgetsFrozen:true,openMenuRemoved:true,latestDraftRetained:true,uncaughtErrors:errors,noticeVisible:true,pageInteractive:true,staleOverlayDismissed:true},null,2));
  console.log('PASS real chrome.runtime.reload: old context stops, custom widgets freeze, latest draft stays readable, page stays usable, no uncaught errors');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
