// Exercise native wheel targeting and the real content controllers in two
// isolated fixture pages; the worker's authorization is covered separately.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const scripts = await Promise.all(['inspector.js', 'select-controls.js', 'content.js'].map(name => readFile(resolve(project, 'extension', name), 'utf8')));
const browser = await chromium.launch({headless: true, args: ['--use-mock-keychain', '--password-store=basic']});
const errors = [], passed = [], forwarded = [];
const fixture = '<!doctype html><title>Independent scroll fixture</title><style>html,body{margin:0;scroll-behavior:auto}body{height:3200px;font:16px system-ui;background:linear-gradient(#fff,#dde3fc)}#nested{position:fixed;left:650px;top:140px;width:460px;height:250px;overflow:auto;border:1px solid}#inside{width:1000px;height:1500px;background:repeating-linear-gradient(#f4e9ff 0 80px,#dccaf8 80px 160px)}</style><h1>Production / prototype fixture</h1><div id="nested"><div id="inside">Nested panel</div></div>';
try {
  const source = await browser.newPage({viewport: {width: 1200, height: 800}});
  const target = await browser.newPage({viewport: {width: 1200, height: 800}});
  const session = {id: 'scroll-review', mode: 'comparison', sourceTabId: 1, targetTabId: 2, status: 'live', sourceViewport: {width:1200,height:800}, targetViewport: {width:1200,height:800}, settings: {opacity:.55,reveal:50,offsetX:0,offsetY:0,linked:false,hidden:false}, comments: []};
  for (const [page, role] of [[source, 'source'], [target, 'target']]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fixture);
    await page.exposeFunction('relay', async message => {
      if (message.type === 'SCROLL_REFERENCE' || message.type === 'SCROLL') {
        forwarded.push(message);
        return source.evaluate(message => window.deliver({type: message.type === 'SCROLL_REFERENCE' ? 'APPLY_WHEEL' : 'APPLY_SCROLL', sessionId:message.sessionId, wheel:message.wheel, scroll:message.scroll}), message);
      }
      if (message.type === 'GET_AI_CONFIG') return {ok:true,config:{hasKey:false}};
      if (message.type === 'GET_AI_SUGGESTIONS') return {ok:true,batch:null};
      return {ok:true};
    });
    await page.evaluate(() => {
      window.chrome = {runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;}},sendMessage:message=>window.relay(message)}};
      window.deliver = message => new Promise(resolve => window.receiver({namespace:'diffuse',sessionId:'scroll-review',...message},{id:'fixture'},resolve));
    });
    for (const content of scripts) await page.addScriptTag({content});
    await page.evaluate(({session,role})=>window.deliver({type:'INITIALIZE',session,role}),{session,role});
  }
  const deliver = message => target.evaluate(message=>window.deliver(message),message);
  const settings = async patch => {
    Object.assign(session.settings,patch);
    for (const page of [source,target]) await page.evaluate(session=>window.deliver({type:'SESSION_UPDATE',session}),session);
  };
  const read = page => page.evaluate(()=>({x:scrollX,y:scrollY,nestedX:document.querySelector('#nested').scrollLeft,nestedY:document.querySelector('#nested').scrollTop}));
  const reset = async () => {for (const page of [source,target]) await page.evaluate(()=>{scrollTo(0,0);document.querySelector('#nested').scrollTo(0,0);});await target.waitForTimeout(50);};
  const wheel = async (x,y,dx,dy) => {await target.mouse.move(x,y);await target.mouse.wheel(dx,dy);await target.waitForTimeout(160);};
  await target.bringToFront();
  await wheel(100,500,0,210);
  assert.ok((await read(target)).y>0); assert.equal((await read(source)).y,0); assert.equal(forwarded.length,0);
  passed.push('Native left-side wheel scrolls only production');
  await reset(); await wheel(900,600,0,190);
  assert.equal((await read(target)).y,0); assert.equal((await read(source)).y,190);
  passed.push('Right-side wheel scrolls only prototype root');
  await reset(); await wheel(900,210,70,160);
  assert.equal((await read(target)).nestedY,0); assert.equal((await read(target)).nestedX,0);
  assert.equal((await read(source)).nestedY,160); assert.equal((await read(source)).nestedX,70); assert.equal((await read(source)).y,0);
  passed.push('Right-side horizontal and vertical wheel finds prototype nested scroll area');
  await source.evaluate(()=>{const panel=document.querySelector('#nested');panel.style.overscrollBehavior='contain';panel.scrollTop=panel.scrollHeight;});
  await wheel(900,210,0,200);assert.equal((await read(source)).y,0);
  await source.evaluate(()=>document.querySelector('#nested').style.overscrollBehavior='auto');
  await wheel(900,210,0,200);assert.equal((await read(source)).y,200);
  passed.push('Nested overscroll containment and parent chaining respected');
  await reset();
  await source.evaluate(()=>{const shadow=document.createElement('div');shadow.id='shadow-fixture';shadow.style.cssText='position:fixed;left:650px;top:140px;width:460px;height:250px';shadow.attachShadow({mode:'open'}).innerHTML='<div id="shadow-panel" style="height:250px;overflow:auto"><div style="height:1400px">Shadow panel</div></div>';document.body.append(shadow);});
  await wheel(900,210,0,90);
  assert.equal(await source.evaluate(()=>document.querySelector('#shadow-fixture').shadowRoot.querySelector('#shadow-panel').scrollTop),90);
  assert.equal((await read(source)).nestedY,0);
  await source.evaluate(()=>document.querySelector('#shadow-fixture').remove());
  passed.push('Open shadow DOM nested panels are hit-tested correctly');
  await source.evaluate(()=>{const frame=document.createElement('iframe');frame.id='frame-fixture';frame.style.cssText='position:fixed;left:650px;top:140px;width:460px;height:250px';document.body.append(frame);});
  await wheel(900,210,0,90);
  const drawerState=await deliver({type:'PANEL_STATE'});assert.match(drawerState.state.warning,/Embedded reference frames/);
  assert.equal((await read(target)).nestedY,0);assert.equal((await read(source)).y,0);
  await source.evaluate(()=>document.querySelector('#frame-fixture').remove());
  passed.push('Embedded iframe limitation is explained in the drawer without moving production');
  await reset(); await settings({reveal:20});
  await target.locator('diffuse-live-overlay').evaluate(host=>{const video=host.shadowRoot.querySelector('#reference');video.style.width='600px';video.style.height='400px';video.style.transform='translate(100px,40px)';});
  await wheel(550,145,0,60);
  assert.equal((await read(source)).nestedY,120);assert.equal((await read(target)).nestedY,0);
  const mapped=forwarded.at(-1).wheel;assert.ok(Math.abs(mapped.x-.75)<.001);assert.ok(Math.abs(mapped.y-.2625)<.001);
  passed.push('Rendered reference scale and alignment map hit points and movement accurately');
  await settings({reveal:50});await reset();
  const dispatch = options => target.evaluate(options=>{const event=new WheelEvent('wheel',{clientX:900,clientY:210,deltaY:120,bubbles:true,cancelable:true,composed:true,...options});document.querySelector('#inside').dispatchEvent(event);return event.defaultPrevented;},options);
  let count=forwarded.length;
  assert.equal(await dispatch({ctrlKey:true}),false);assert.equal(await dispatch({metaKey:true}),false);
  await target.waitForTimeout(50);assert.equal(forwarded.length,count);
  for (const patch of [{hidden:true},{hidden:false,opacity:0}]) {
    await settings(patch);count=forwarded.length;assert.equal(await dispatch({}),false);await target.waitForTimeout(50);assert.equal(forwarded.length,count);
  }
  await settings({opacity:.55,hidden:false});
  const productionBefore=await read(target);await target.locator('diffuse-live-overlay').evaluate(host=>{const panel=document.createElement('div');panel.id='fixture-own-panel';panel.style.cssText='position:fixed;top:140px;left:650px;width:460px;height:250px;overflow:auto;pointer-events:auto;background:#fff';panel.innerHTML='<div style="height:1200px">Own panel</div>';host.shadowRoot.append(panel);});
  count=forwarded.length;await wheel(900,210,0,110);assert.equal(forwarded.length,count);assert.equal((await read(target)).y,productionBefore.y);
  assert.ok(await target.locator('diffuse-live-overlay').locator('#fixture-own-panel').evaluate(node=>node.scrollTop)>0);
  await target.locator('diffuse-live-overlay').locator('#fixture-own-panel').evaluate(node=>node.remove());
  passed.push('Zoom gestures, hidden/transparent diff, and Diffuse panels are excluded');
  await deliver({type:'PANEL_COMMAND',action:'selectArea'});count=forwarded.length;assert.equal(await dispatch({}),false);await target.waitForTimeout(50);assert.equal(forwarded.length,count);await deliver({type:'PANEL_COMMAND',action:'cancelSelection'});
  await deliver({type:'PANEL_COMMAND',action:'selectElement'});count=forwarded.length;assert.equal(await dispatch({}),false);await target.waitForTimeout(50);assert.equal(forwarded.length,count);await deliver({type:'PANEL_COMMAND',action:'cancelSelection'});
  passed.push('Area and element selection retain their page interactions');
  await reset();await settings({linked:true});await wheel(100,600,0,150);
  assert.equal((await read(source)).y,(await read(target)).y);assert.ok((await read(source)).y>0);assert.equal(forwarded.at(-1).type,'SCROLL');
  passed.push('Explicit Link scroll still synchronizes production to prototype');
  await settings({linked:false});await reset();count=forwarded.length;
  await target.evaluate(async()=>{for(let i=0;i<4;i++)document.querySelector('#inside').dispatchEvent(new WheelEvent('wheel',{clientX:900,clientY:200,deltaY:10,bubbles:true,cancelable:true,composed:true}));await new Promise(requestAnimationFrame);});
  await target.waitForTimeout(80);assert.equal(forwarded.length-count,1);assert.equal(forwarded.at(-1).wheel.deltaY,40);
  const wrong=await source.evaluate(()=>window.deliver({type:'APPLY_WHEEL',sessionId:'stale',wheel:{x:.75,y:.2,deltaX:0,deltaY:100}}));assert.equal(wrong.ok,false);
  count=forwarded.length;await target.evaluate(async()=>{document.querySelector('#inside').dispatchEvent(new WheelEvent('wheel',{clientX:900,clientY:200,deltaY:120,bubbles:true,cancelable:true,composed:true}));await window.deliver({type:'STOP'});});
  await target.waitForTimeout(80);assert.equal(forwarded.length,count);
  passed.push('Wheel frames batch deltas and stop/session changes cancel stale work');
  assert.deepEqual(errors,[]);
  await mkdir(resolve(project,'artifacts/independent-scroll'),{recursive:true});
  await writeFile(resolve(project,'artifacts/independent-scroll/results.json'),JSON.stringify({passed,errors,forwardedCount:forwarded.length},null,2));
  console.log(JSON.stringify({passed,errors},null,2));
} finally {await browser.close();}
