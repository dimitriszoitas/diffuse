import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewportController} from '../extension/viewport-controller.mjs';
function fixture(){const attached=new Set(),metrics=new Map(),calls=[];let fail=null,allowed=true;const chromeApi={tabs:{get:async id=>({url:`https://example.test/${id}`})},debugger:{getTargets:async()=>[1,2,3].map(tabId=>({tabId,attached:attached.has(tabId)})),attach:async({tabId})=>{calls.push(['attach',tabId]);attached.add(tabId);},detach:async({tabId})=>{attached.delete(tabId);},sendCommand:async({tabId},method,params)=>{calls.push([method,tabId,params]);if(fail?.(tabId,method,params))throw new Error('Controlled failure');if(!attached.has(tabId))throw new Error('Not attached');if(method==='Emulation.setDeviceMetricsOverride')metrics.set(tabId,params);if(method==='Emulation.clearDeviceMetricsOverride')metrics.delete(tabId);}}};let detached=0;const controller=createViewportController({chromeApi,assertPageAccess:async()=>{if(!allowed)throw new Error('Access denied');},onDetached:async()=>{detached++;}});return{controller,chromeApi,attached,metrics,calls,deny:()=>{allowed=false;},fail:fn=>{fail=fn;},detached:()=>detached};}
test('presets set both real CSS viewports and restore releases only owned tabs',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'phone');assert.deepEqual(f.metrics.get(1),{width:390,height:844,deviceScaleFactor:0,mobile:false,scale:1});assert.deepEqual(f.metrics.get(2),f.metrics.get(1));await f.controller.restore();assert.equal(f.attached.size,0);assert.equal(f.metrics.size,0);});
test('Laptop is a distinct 1280 by800 preset and preserves Desktop and Tablet sizes',async()=>{
  const f=fixture();
  for(const [preset,width,height] of [['desktop',1440,900],['laptop',1280,800],['tablet',1024,768]]){
    await f.controller.apply({targetTabId:1,sourceTabId:2},preset);
    assert.equal(f.controller.preset,preset);
    assert.deepEqual(f.metrics.get(1),{width,height,deviceScaleFactor:0,mobile:false,scale:1});
    assert.deepEqual(f.metrics.get(2),f.metrics.get(1));
  }
  await f.controller.restore();assert.equal(f.attached.size,0);
});
test('restart retains the distinct Laptop preset and its paired metrics',async()=>{
  const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'laptop');
  const restarted=createViewportController({chromeApi:f.chromeApi,assertPageAccess:async()=>{}});
  assert.equal(await restarted.resume({targetTabId:1,sourceTabId:2,viewportPreset:'laptop',viewportDebuggerTabs:[1,2]}),'laptop');
  assert.equal(f.metrics.get(1).width,1280);assert.equal(f.metrics.get(2).height,800);
  await restarted.restore();
});
test('page permission and existing debugger checks happen before any attach',async()=>{const f=fixture();f.deny();await assert.rejects(f.controller.apply({targetTabId:1},'desktop'),/denied/);assert.equal(f.calls.length,0);const g=fixture();g.attached.add(2);await assert.rejects(g.controller.apply({targetTabId:1,sourceTabId:2},'tablet'),/DevTools/);assert.deepEqual(g.calls,[]);assert.deepEqual([...g.attached],[2]);});
test('a second-page failure rolls back an existing paired preset',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'desktop');f.fail((id,method,p)=>id===2&&p.width===390);await assert.rejects(f.controller.apply({targetTabId:1,sourceTabId:2},'phone'),/Controlled/);assert.equal(f.controller.preset,'desktop');assert.equal(f.metrics.get(1).width,1440);assert.equal(f.metrics.get(2).width,1440);});
test('a first-use failure clears and detaches every newly owned tab',async()=>{const f=fixture();f.fail((id,method)=>id===2&&method==='Emulation.setDeviceMetricsOverride');await assert.rejects(f.controller.apply({targetTabId:1,sourceTabId:2},'phone'));assert.equal(f.attached.size,0);assert.equal(f.metrics.size,0);assert.equal(f.controller.preset,null);});
test('switching reference inherits the preset and restores the previous reference',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'tablet');await f.controller.apply({targetTabId:1,sourceTabId:3},'tablet');assert.deepEqual(f.controller.ownedTabIds(),[1,3]);assert.equal(f.metrics.has(2),false);assert.equal(f.metrics.get(3).width,1024);});
test('external detach restores the other page and clears the selected preset',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'phone');f.attached.delete(1);f.metrics.delete(1);await f.controller.externalDetach({tabId:1},'canceled_by_user');assert.equal(f.attached.size,0);assert.equal(f.controller.preset,null);assert.equal(f.detached(),1);});
test('restart resumes only debugger connections that still belong to the extension',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'phone');const restarted=createViewportController({chromeApi:f.chromeApi,assertPageAccess:async()=>{}});assert.equal(await restarted.resume({targetTabId:1,sourceTabId:2,viewportPreset:'phone',viewportDebuggerTabs:[1,2]}),'phone');await restarted.restore();assert.equal(f.attached.size,0);});

test('each resized page flushes its painted layout before a capture can resume',async()=>{const f=fixture();await f.controller.apply({targetTabId:1,sourceTabId:2},'laptop');const commands=f.calls.filter(([method])=>method!=='attach');assert.deepEqual(commands.map(([method,id])=>[method,id]),[['Emulation.setDeviceMetricsOverride',1],['Runtime.evaluate',1],['Emulation.setDeviceMetricsOverride',2],['Runtime.evaluate',2]]);for(const [method,id,params]of commands)if(method==='Runtime.evaluate'){assert.equal(params.awaitPromise,true);assert.equal(params.timeout,1500);assert.match(params.expression,/getBoundingClientRect/);}});
