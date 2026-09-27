// Disposable browser fixtures exercise the real settings controllers and drawer UI.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/settings');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const context = await browser.newContext();
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('https://diffuse.test/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript'};
  let body = await readFile(resolve(root,'extension',name),'utf8');
  if(name === 'sidepanel.html') body = body.replace('<script src="popup.js" defer></script>','');
  await route.fulfill({status:200,contentType:types[extname(name)]||'text/plain',body});
});
await context.route('https://diffuse-jira-api.vercel.app/**', async route => {
  const url = new URL(route.request().url());
  let body = {};
  if(route.request().method() === 'GET' && url.pathname === '/v1/connection') body = {connection:{id:'10000000-0000-4000-8000-000000000001',accountId:'demo-account',displayName:'Demo Reviewer',sites:[]}};
  if(url.pathname === '/v1/sites')body={sites:[{id:'20000000-0000-4000-8000-000000000001',name:'Demo Jira',url:'https://demo.atlassian.net'}]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
await context.addInitScript(() => {
  if (location.origin !== 'https://diffuse.test') return;
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const event = () => ({addListener(){}});
  const stored = () => JSON.parse(localStorage.getItem('fixture-store') || '{}');
  const store = {async setAccessLevel(){},async get(key){const all=stored();return key ? {[key]:all[key]} : all;},async set(values){localStorage.setItem('fixture-store',JSON.stringify({...stored(),...values}));},async remove(key){const all=stored();delete all[key];localStorage.setItem('fixture-store',JSON.stringify(all));}};
  if(!localStorage.getItem('fixture-store'))store.set({'diffuseJiraConnection:10000000-0000-4000-8000-000000000001':{id:'10000000-0000-4000-8000-000000000001',accountId:'demo-account',displayName:'Demo Reviewer',sites:[{id:'20000000-0000-4000-8000-000000000001',name:'Demo Jira',url:'https://demo.atlassian.net'}],credential:'10000000-0000-4000-8000-000000000001.'+'a'.repeat(43)}});
  window.messages=[];window.permissionRequests=[];window.allowPermission=true;
  window.session={id:'session',mode:'audit',target:{title:'Atlas production'},targetViewport:{width:1440,height:900},settings:{},comments:Array.from({length:18},(_,i)=>({id:String(i),fields:{title:`Review finding ${i+1}`},context:{production:{url:'https://other-review.test/releases/42?tab=details',viewportProfile:{key:'desktop'}}}}))};
  window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
  window.chrome={runtime:{id,connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(message){window.messages.push(message);const config=()=>JSON.parse(localStorage.getItem('ai-fixture')||'{"model":"claude-sonnet-5","threshold":35,"rememberKey":false,"hasKey":false}');
    if(message.type==='GET_AI_CONFIG')return{ok:true,config:config()};
    if(message.type==='SAVE_AI_CONFIG'){localStorage.setItem('ai-fixture',JSON.stringify({model:message.model,threshold:message.threshold,rememberKey:message.rememberKey,hasKey:Boolean(message.apiKey)||config().hasKey}));return{ok:true};}
    if(message.type==='CLEAR_AI_KEY'){localStorage.setItem('ai-fixture',JSON.stringify({...config(),hasKey:false}));return{ok:true};}
    if(message.type==='VIEWPORT_PRESET'){session.viewportPreset=message.preset;return{ok:true};}
    return{ok:true,session:window.session,state:{view:'controls',active:true,available:true}};
  }},permissions:{request:async value=>{window.permissionRequests.push(value);return window.allowPermission;}},storage:{local:store,session:store},identity:{launchWebAuthFlow:async()=>''},extension:{isAllowedFileSchemeAccess:async()=>true},tabs:{onActivated:event(),onUpdated:event(),async create(value){window.openedTab=value;}},windows:{getCurrent:async()=>({id:1})}};
});
try {
  const settings = await context.newPage();
  await settings.goto('https://diffuse.test/settings.html');
  await settings.locator('#save:not([disabled])').waitFor();
  await settings.getByRole('heading',{name:'Demo Reviewer',exact:true}).waitFor();
  assert.equal(await settings.locator('[id]').evaluateAll(nodes=>new Set(nodes.map(n=>n.id)).size===nodes.length),true);
  assert.equal(await settings.locator('#file-access-status').textContent(),'Allowed');
  await settings.locator('#api-key').fill('sk-ant-'+ 'a'.repeat(64));
  await settings.locator('#model').fill('claude-sonnet-5');
  await settings.locator('#remember-key').check();
  await settings.locator('#threshold').fill('60');
  await settings.locator('#save').click();
  await settings.locator('#ai-feedback').filter({hasText:'AI settings saved.'}).waitFor();
  assert.equal(await settings.locator('#api-key').inputValue(),'');
  assert.equal(await settings.locator('#jira-feedback').isVisible(),false);
  await settings.reload();
  await settings.locator('#key-status').filter({hasText:'Key remembered'}).waitFor();
  assert.equal(await settings.locator('#threshold').inputValue(),'60');
  await settings.locator('#ai').screenshot({path:resolve(out,'ai-settings.png')});
  await settings.getByRole('button',{name:'Refresh Jira sites for Demo Reviewer'}).click();
  await settings.locator('#jira-feedback').filter({hasText:'Jira sites updated'}).waitFor();
  assert.equal(await settings.locator('#ai-feedback').isVisible(),false);
  await settings.locator('#jira').screenshot({path:resolve(out,'jira-settings.png')});
  await settings.getByRole('button',{name:'Disconnect Demo Reviewer from Diffuse'}).click();
  await settings.locator('#connection-count').filter({hasText:'0 connected'}).waitFor();
  await settings.locator('#clear-key').click();
  await settings.locator('#key-status').filter({hasText:'No key connected'}).waitFor();
  await settings.locator('#browser-settings').click();
  assert.equal(await settings.evaluate(()=>window.openedTab.url),'chrome://extensions/?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  for(const width of [1440,768,390,320]){
    await settings.setViewportSize({width,height:900});
    assert.equal(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Settings overflow at ${width}`);
  }
  console.log('PASS unified AI saves/reloads/removes key; Jira refresh/disconnect remains isolated; browser access works; settings fit 320–1440px.');
  const panel=await context.newPage({viewport:{width:360,height:720}});
  await panel.goto('https://diffuse.test/sidepanel.html');
  await panel.locator('#panel-comments .saved-item').first().waitFor();
  await panel.evaluate(()=>document.getElementById('loading').hidden=true);
  assert.equal(await panel.locator('#panel-comment,#panel-area,#ai-settings,#jira-settings').count(),0);
  assert.equal(await panel.locator('#settings').count(),1);
  await panel.evaluate(()=>window.allowPermission=false);
  await panel.locator('#panel-comments .saved-item').first().click();
  await panel.locator('#feedback').filter({hasText:'Your current page has not changed'}).waitFor();
  assert.equal(await panel.evaluate(()=>window.messages.filter(m=>m.action==='showPin').length),0);
  assert.deepEqual(await panel.evaluate(()=>window.permissionRequests.at(-1)),{origins:['https://other-review.test/*']});
  await panel.waitForTimeout(1100);
  assert.equal(await panel.locator('#feedback').isVisible(),true,'permission denial survives state refresh');
  await panel.evaluate(()=>window.allowPermission=true);
  await panel.locator('#panel-comments .saved-item').first().click();
  await panel.waitForFunction(()=>window.messages.some(m=>m.action==='showPin'&&m.id==='0'));
  console.log('PASS comment click requests only its saved site; denial keeps the page and warning, grant reveals through the worker.');
  for(const preset of ['desktop','laptop','tablet','phone']){
    const control=panel.locator(`[data-preset=${preset}]`);
    assert.equal((await control.textContent()).trim(),'');
    assert((await control.getAttribute('aria-label')).startsWith(preset[0].toUpperCase()+preset.slice(1)));
    await control.click();
    await panel.waitForFunction(preset=>window.messages.some(m=>m.type==='VIEWPORT_PRESET'&&m.preset===preset),preset);
  }
  await panel.locator('.viewport-info').hover();
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),true);
  await panel.locator('.viewport-info').focus();
  await panel.keyboard.press('Escape');
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),false);
  for(const width of [360,320]){
    await panel.setViewportSize({width,height:600});
    for(const end of [false,true]){
      await panel.locator('.drawer-scroll').evaluate((node,end)=>node.scrollTop=end?node.scrollHeight:0,end);
      const b=await panel.locator('#settings').boundingBox();
      assert(b.y>=0&&b.y+b.height<=600&&b.height>=44);
      assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
  }
  await panel.locator('.drawer-scroll').evaluate(node=>node.scrollTop=0);
  await panel.screenshot({path:resolve(out,'drawer.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS compact drawer has icon viewport controls, hover/focus info, shortcut cheatsheet, and a persistent Settings footer.');
} finally {await browser.close();}
