import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {parseFigmaReference} from '../extension/mcp-client.mjs';
import {mcpPermissionOrigin} from '../extension/mcp-config.mjs';
import {createViewportController} from '../extension/viewport-controller.mjs';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const FIGMA_URL='https://www.figma.com/design/ExampleFile/Atlas?node-id=10-20';
const image={dataUrl:'data:image/png;base64,YWJjZA==',width:100,height:100};
const event={addListener(){}};
async function harness({enabled=true,allowed=true,readReference,prepareReference,saveDraft,saveSession,reviewResult}={}){
  const state={calls:[],drafts:[],discarded:[],saved:null};
  const chrome={runtime:{id:'test',getURL:p=>`chrome-extension://test/${p}`,onMessage:event,onInstalled:event},storage:{session:{get:async()=>({}),set:async data=>{state.saved=structuredClone(data);await saveSession?.(data);}}},tabs:{onUpdated:event,onRemoved:event},permissions:{contains:async({origins})=>origins[0].includes('anthropic')||allowed}};
  const config={enabled,endpoint:'http://127.0.0.1:3845/mcp',token:'fixture-secret'};
  const ctx=vm.createContext({chrome,createViewportController,assertPageAccess(){},protectAIStorage:async()=>{},DEFAULT_SETTINGS:{},viewportWarning:()=>'',crypto:webcrypto,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,
    parseFigmaReference,mcpPermissionOrigin,
    readAISettings:async()=>({hasKey:true,apiKey:'sk-ant-fixture',model:'fixture'}),
    readMCPSettings:async({includeToken=false}={})=>includeToken?config:{enabled,endpoint:config.endpoint,hasToken:true},
    saveMCPSettings:async()=>{state.calls.push('save-config');return{};},clearMCPSettings:async()=>{},testMCPConnection:async()=>({tools:['get_design_context']}),
    readFigmaReference:async args=>{state.calls.push('mcp');state.referenceArgs=args;return readReference?readReference(args):{...parseFigmaReference(args.url),text:'Gap: 24',images:[{mimeType:'image/png',data:'YWJjZA=='}],tools:['get_design_context','get_screenshot'],serverName:'Figma Desktop',warnings:[]};},
    reviewScreens:async args=>{state.calls.push('provider');state.providerArgs=args;return reviewResult||{summary:'Compared with Figma',limitations:[],suggestions:[]};},
    reviews:{putDraft:async draft=>{state.drafts.push(structuredClone(draft));await saveDraft?.(draft);},discardDraft:async id=>state.discarded.push(id)},
    fixturePrepareReference:async()=>{state.preparingReference=true;return prepareReference?prepareReference():{ok:true,images:[image]};},
    fixtureState:state,fixtureImage:image,
  });
  vm.runInContext(source.replace(/^import .*\n/gm,'')+`
    publish=async()=>{};
    captureDraft=async()=>{fixtureState.calls.push('capture');return{id:'capture',reviewId:'review',mode:'audit',createdAt:'2026-09-27T12:00:00Z',context:{production:{url:'https://atlas.test',viewport:{width:100,height:100}}},evidence:{production:fixtureImage}};};
    mediaMessage=async(type)=>type==='PREPARE_MCP_IMAGES'?fixturePrepareReference():{ok:true,production:fixtureImage};
    globalThis.api={ready,runAIReview,handle,setSession(value){session=value;},abort(){aiJob?.controller.abort();},getSession(){return session;}};
  `,ctx);
  await ctx.api.ready;ctx.api.setSession({id:'session',reviewId:'review',mode:'audit',targetTabId:2,settings:{},status:'live'});
  return{...ctx.api,state};
}
test('a Figma URL in instructions reads MCP before the provider and keeps reference provenance/evidence',async()=>{
  const worker=await harness();
  const result=await worker.runAIReview({instructions:`Compare spacing against ${FIGMA_URL}.`});
  assert.deepEqual(worker.state.calls,['capture','mcp','provider']);
  assert.equal(worker.state.referenceArgs.url,'https://www.figma.com/design/ExampleFile?node-id=10-20');
  assert.equal(worker.state.providerArgs.designReference.text,'Gap: 24');
  assert.equal(worker.state.providerArgs.designReference.images[0].width,100);
  const draft=worker.state.drafts[0];
  assert.equal(draft.designReference.nodeId,'10:20');
  assert.equal(draft.evidence.designReference.dataUrl,image.dataUrl);
  assert.equal(JSON.stringify(draft).includes('fixture-secret'),false);
  assert.equal(result.batch.designReference.nodeId,'10:20');
  assert.equal(worker.getSession().aiRunning,false);
});
test('missing connection or permission blocks Figma review before any capture or AI call',async()=>{
  for(const config of [{enabled:false},{allowed:false}]){
    const worker=await harness(config);
    await assert.rejects(worker.runAIReview({referenceUrl:FIGMA_URL}),/Settings/);
    assert.equal(worker.state.calls.length,0);
  }
});
test('MCP failure does not silently become a screenshot-only audit',async()=>{
  const worker=await harness({readReference:async()=>{throw new Error('Figma unavailable');}});
  await assert.rejects(worker.runAIReview({referenceUrl:FIGMA_URL}),/Figma unavailable/);
  assert.deepEqual(worker.state.calls,['capture','mcp']);
  assert.deepEqual(worker.state.discarded,['capture']);
  assert.equal(worker.getSession().aiRunning,false);
});
test('cancelled Figma fetch cannot send context to AI or retain its evidence',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const worker=await harness({readReference:async args=>{await gate;return{...parseFigmaReference(args.url),text:'Context',images:[]};}});
  const request=worker.runAIReview({referenceUrl:FIGMA_URL});
  while(!worker.state.referenceArgs)await new Promise(resolve=>setImmediate(resolve));
  worker.abort();release();
  await assert.rejects(request,/cancelled or timed out/);
  assert.equal(worker.state.calls.includes('provider'),false);
  assert.equal(worker.state.drafts.length,0);
  assert.equal(worker.getSession().aiRunning,false);
});
test('only the trusted settings page can mutate MCP credentials',async()=>{
  const worker=await harness();
  await assert.rejects(worker.handle({type:'SAVE_MCP_CONFIG',sessionId:'session',endpoint:'https://other.test/mcp'}, {id:'test',url:'https://atlas.test',tab:{id:2}}));
  assert.equal(worker.state.calls.includes('save-config'),false);
  const result=await worker.handle({type:'GET_MCP_CONFIG'},{id:'test',url:'chrome-extension://test/settings.html#figma'});
  assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
});

test('session replacement or cancellation during image preparation never reaches the provider',async()=>{
  for(const replace of [false,true]){
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const worker=await harness({prepareReference:async()=>{await gate;return{ok:true,images:[image]};}});
    const request=worker.runAIReview({referenceUrl:FIGMA_URL});
    while(!worker.state.preparingReference)await new Promise(resolve=>setImmediate(resolve));
    const replacement={id:'replacement',reviewId:'other-review',aiRunning:true};
    if(replace)worker.setSession(replacement);else worker.abort();
    release();
    await assert.rejects(request,/cancelled/);
    assert.equal(worker.state.calls.includes('provider'),false);
    assert.equal(worker.state.drafts.length,0);
    assert.deepEqual(worker.state.discarded,['capture']);
    if(replace)assert.equal(worker.getSession().aiRunning,true);
  }
});

test('session replacement while writing the AI batch discards it instead of publishing it in the new review',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const worker=await harness({saveDraft:async()=>gate});
  const request=worker.runAIReview({referenceUrl:FIGMA_URL});
  while(!worker.state.drafts.length)await new Promise(resolve=>setImmediate(resolve));
  worker.setSession({id:'replacement',reviewId:'other-review',aiRunning:true});
  release();
  await assert.rejects(request,/cancelled/);
  assert.equal(worker.getSession().aiBatchId,undefined);
  assert.equal(worker.getSession().aiRunning,true);
  assert.deepEqual(worker.state.discarded,['capture']);
});

test('known MCP credentials never enter instructions or saved provider output',async()=>{
  const worker=await harness();
  await assert.rejects(worker.runAIReview({referenceUrl:FIGMA_URL,instructions:'Use fixture-secret'}),/Remove MCP credentials/);
  assert.equal(worker.state.calls.length,0);
  const echoed=await harness({reviewResult:{summary:'fixture-secret',limitations:[],suggestions:[]}});
  await assert.rejects(echoed.runAIReview({referenceUrl:FIGMA_URL}),/credential-like/);
  assert.equal(echoed.state.drafts.length,0);
  assert.deepEqual(echoed.state.discarded,['capture']);
});

test('cancellation during session persistence restores the previous usable batch pointer',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const worker=await harness({saveSession:async()=>gate});
  worker.getSession().aiBatchId='previous-batch';
  const request=worker.runAIReview({referenceUrl:FIGMA_URL});
  while(!worker.state.saved)await new Promise(resolve=>setImmediate(resolve));
  worker.abort();release();
  await assert.rejects(request,/cancelled/);
  assert.equal(worker.getSession().aiBatchId,'previous-batch');
  assert.equal(worker.state.saved.comparison.aiBatchId,'previous-batch');
  assert.deepEqual(worker.state.discarded,['capture']);
});

test('both prepared Figma images used by the AI are retained with its batch',async()=>{
  const second={...image,dataUrl:'data:image/png;base64,c2Vjb25k'};
  const worker=await harness({prepareReference:async()=>({ok:true,images:[image,second]})});
  await worker.runAIReview({referenceUrl:FIGMA_URL});
  assert.equal(worker.state.providerArgs.designReference.images.length,2);
  assert.equal(worker.state.drafts[0].evidence.designReference.dataUrl,image.dataUrl);
  assert.equal(worker.state.drafts[0].evidence.designReferenceAdditional[0].dataUrl,second.dataUrl);
});
