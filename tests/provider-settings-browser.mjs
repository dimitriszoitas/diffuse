// Provider settings UI against a local message fixture; no real keys or API calls.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/provider-settings');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('https://diffuse.test/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript'};
  let body = await readFile(resolve(root,'extension',name),'utf8');
  if (name.endsWith('.html')) body = body.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, file) => ['ai-settings.js','theme.js'].includes(file) ? tag : '');
  await route.fulfill({contentType:types[extname(name)]||'text/plain',body});
});
await context.addInitScript(() => {
  if (location.origin !== 'https://diffuse.test') return;
  const event = () => ({addListener(){}});
  const initial = {provider:'anthropic',threshold:35,profiles:{
    anthropic:{model:'claude-opus-5-5',rememberKey:true,hasKey:true,reviewEngine:'direct',reviewBudgetUsd:2,journeyEngine:'direct',journeyBudgetUsd:20},
    openai:{model:'gpt-6.1-sol',rememberKey:false,hasKey:false,reviewEngine:'direct',reviewBudgetUsd:2,journeyEngine:'direct',journeyBudgetUsd:2},
  },ready:{anthropic:{journey:false,review:false},openai:{journey:false,review:false}}};
  if (!localStorage.getItem('provider-fixture')) localStorage.setItem('provider-fixture', JSON.stringify(initial));
  const read = () => JSON.parse(localStorage.getItem('provider-fixture'));
  const write = state => localStorage.setItem('provider-fixture', JSON.stringify(state));
  const publicConfig = requested => {const state=read(),provider=requested||state.provider;return{...state.profiles[provider],provider,activeProvider:state.provider,threshold:state.threshold,connections:state.profiles};};
  window.messages=[];window.permissionRequests=[];window.allowPermission=true;
  window.chrome={runtime:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',async sendMessage(message){
    window.messages.push(message);
    const state=read(),provider=message.provider||state.provider;
    if(message.type==='GET_AI_CONFIG')return{ok:true,config:publicConfig(message.provider)};
    if(message.type==='SAVE_AI_CONFIG'){
      const profile=state.profiles[provider];
      for(const key of ['model','rememberKey','reviewEngine','reviewBudgetUsd','journeyEngine','journeyBudgetUsd']) if(message[key]!==undefined)profile[key]=message[key];
      if(message.apiKey){profile.hasKey=true;state.ready[provider]={journey:false,review:false};}
      state.provider=provider;state.threshold=message.threshold;write(state);return{ok:true,config:publicConfig(provider)};
    }
    if(message.type==='GET_JOURNEY_AGENTS_STATUS')return{ok:true,agents:{ready:state.ready[provider].journey}};
    if(message.type==='GET_REVIEW_AGENT_STATUS')return{ok:true,agent:{ready:state.ready[provider].review}};
    if(message.type==='SETUP_JOURNEY_AGENTS'){state.ready[provider].journey=true;state.profiles[provider].journeyEngine='managed';write(state);return{ok:true,agents:{ready:true}};}
    if(message.type==='SETUP_REVIEW_AGENT'){state.ready[provider].review=true;state.profiles[provider].reviewEngine='managed';write(state);return{ok:true,agent:{ready:true}};}
    if(message.type==='CLEAR_AI_KEY'){state.profiles[provider].hasKey=false;state.ready[provider]={journey:false,review:false};write(state);return{ok:true};}
    return{ok:true};
  }},permissions:{async request(value){window.permissionRequests.push(value);return window.allowPermission;}},storage:{local:{async get(){return{};},async set(){}},onChanged:event()}};
});
try {
  const page=await context.newPage();
  await page.goto('https://diffuse.test/settings.html#ai');
  const ready=()=>page.waitForFunction(()=>document.querySelector('#ai-settings-form').getAttribute('aria-busy')==='false');
  const choose=async provider=>{await page.locator(`#provider-${provider}`).check();await ready();assert.equal(await page.locator(`#provider-${provider}`).isChecked(),true);};
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('provider-fixture')));
  await ready();
  assert.equal(await page.locator('#api-key').inputValue(),'');
  assert.equal(await page.locator('#anthropic-connection-state').textContent(),'Key remembered');
  assert.equal(await page.locator('#openai-connection-state').textContent(),'No key connected');
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type.startsWith('SETUP_'))),false,'Loading settings never creates agents');
  await choose('openai');
  assert.equal(await page.locator('#model').inputValue(),'gpt-6.1-sol');
  assert.equal(await page.locator('#ai-active-provider').textContent(),'Using Anthropic');
  assert.equal((await state()).provider,'anthropic');
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='SAVE_AI_CONFIG')),false,'Selecting a provider does not activate or save it');
  const newKey='sk-proj-openai-browser-fixture-not-a-real-key';
  await page.locator('#api-key').fill(newKey);
  await page.locator('#model').fill('gpt-6.1-sol');
  await choose('anthropic');
  assert.equal(await page.locator('#api-key').inputValue(),'','Saved keys are never revealed');
  assert.equal(await page.locator('#model').inputValue(),'claude-opus-5-5');
  await choose('openai');
  assert.equal(await page.locator('#api-key').inputValue(),newKey,'Only the user-entered unsaved draft is restored');
  assert.equal(await page.locator('#api-key').getAttribute('type'),'password');
  await page.evaluate(()=>window.allowPermission=false);
  await page.locator('#save').click();await ready();
  await page.locator('#ai-feedback').filter({hasText:'Allow the OpenAI connection'}).waitFor();
  assert.equal((await state()).provider,'anthropic');
  assert.equal((await state()).profiles.openai.hasKey,false);
  assert.equal(await page.locator('#api-key').inputValue(),newKey,'Permission denial preserves the unsaved draft');
  assert.deepEqual(await page.evaluate(()=>permissionRequests.at(-1)),{origins:['https://api.openai.com/*']});
  await page.evaluate(()=>window.allowPermission=true);
  await page.locator('#save').click();await ready();
  await page.locator('#ai-feedback').filter({hasText:'AI settings saved.'}).waitFor();
  assert.equal(await page.locator('#api-key').inputValue(),'');
  assert.equal(await page.locator('#ai-active-provider').textContent(),'Using OpenAI');
  assert.equal((await state()).profiles.anthropic.hasKey,true);
  assert.equal((await state()).profiles.anthropic.rememberKey,true);
  assert.equal((await state()).profiles.openai.rememberKey,false);
  await page.reload();await ready();
  assert.equal(await page.locator('#provider-openai').isChecked(),true);
  assert.equal(await page.locator('#api-key').inputValue(),'');
  assert.equal(await page.locator('#openai-connection-state').textContent(),'Key ready for this session');
  console.log('PASS Provider selection stays unsaved until Save, drafts stay separate, permission denial preserves the old provider, and key retention policies stay independent.');

  await page.locator('#journey-engine-managed').check();
  assert.equal(await page.locator('#journey-managed-model').textContent(),'GPT-6.1 Sol · Max effort');
  assert.match(await page.locator('label[for="journey-budget"]').textContent(),/Estimated.*guard/);
  assert.match(await page.locator('#journey-budget-help').textContent(),/request already running can exceed/);
  await page.locator('#save').click();await ready();
  await page.locator('#ai-feedback').filter({hasText:'Set up journey agents'}).waitFor();
  assert.equal((await state()).profiles.openai.journeyEngine,'direct');
  await page.locator('#setup-journey-agents').click();await ready();
  await page.locator('#journey-agent-status').filter({hasText:'Agents ready'}).waitFor();
  await page.locator('#review-engine-managed').check();
  await page.locator('#setup-review-agent').click();await ready();
  await page.locator('#review-agent-status').filter({hasText:'Reviewer ready'}).waitFor();
  const setupCalls=await page.evaluate(()=>messages.filter(m=>m.type.startsWith('SETUP_')).map(m=>({type:m.type,provider:m.provider})));
  assert.deepEqual(setupCalls,[{type:'SETUP_JOURNEY_AGENTS',provider:'openai'},{type:'SETUP_REVIEW_AGENT',provider:'openai'}]);
  assert.equal((await state()).profiles.anthropic.journeyEngine,'direct');
  assert.equal((await state()).profiles.anthropic.reviewEngine,'direct');
  for(const theme of ['light','dark'])for(const width of [1440,390,320]){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} provider controls fit ${width}px`);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.ai-provider-settings').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(out,'openai-settings-dark.png')});
  console.log('PASS OpenAI setup routes both agents to the selected provider; Sol Max and estimated spending guidance are visible; settings fit both themes at 320–1440px.');

  await choose('anthropic');await page.locator('#save').click();await ready();
  assert.equal((await state()).provider,'anthropic');
  assert.equal((await state()).profiles.openai.hasKey,true);
  await choose('openai');await page.locator('#clear-key').click();await ready();
  assert.equal((await state()).provider,'anthropic','Clearing an inactive provider never activates it');
  assert.equal((await state()).profiles.anthropic.hasKey,true);
  assert.equal((await state()).profiles.openai.hasKey,false);
  await page.locator('#api-key').fill('sk-ant-wrong-provider-fixture-key');
  await page.locator('#save').click();await ready();
  await page.locator('#ai-feedback').filter({hasText:'valid OpenAI API key'}).waitFor();
  assert.equal((await state()).provider,'anthropic');
  assert.equal((await state()).profiles.openai.hasKey,false);
  const legacy=await context.newPage();await legacy.goto('https://diffuse.test/ai-settings.html');
  await legacy.locator('#save:not([disabled])').waitFor();
  assert.equal(await legacy.locator('#provider-anthropic').isChecked(),true);
  assert.equal(await legacy.locator('#api-key').inputValue(),'');
  assert.equal(await legacy.locator('[id]').evaluateAll(nodes=>new Set(nodes.map(node=>node.id)).size===nodes.length),true);
  assert.deepEqual(errors,[]);
  console.log('PASS Switching back preserves both connections; removing one key is isolated; wrong-provider keys are rejected; standalone AI settings use the same controls.');
} finally {await context.close();await browser.close();}
