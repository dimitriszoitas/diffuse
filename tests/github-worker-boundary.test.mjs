import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const noop={addListener(){}};
async function harness({error}={}){
 const state={calls:[],created:0};
 const chrome={runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,onMessage:{addListener(fn){state.listener=fn;}},onInstalled:noop},storage:{session:{get:async()=>({comparison:null})}},tabs:{onUpdated:noop,onRemoved:noop}};
 const context=vm.createContext({chrome,createViewportController:()=>({}),assertPageAccess(){},protectAIStorage:async()=>{},reviews:{},formatGitHubSummary(){},
  isGitHubRequest:type=>['GITHUB_PUBLISH','GITHUB_RECHECK','GITHUB_LOAD','GITHUB_PUBLICATION_STATUS'].includes(type),
  createGitHubConnectionClient:()=>{state.created++;return{};},
  createGitHubWorker:()=>({async handle(message){state.calls.push(message);if(error)throw error;return{ok:true};}}),
  isReviewableUrl:url=>/^https?:/.test(url)});
 vm.runInContext(source.replace(/^import .*\n/gm,'')+'\nglobalThis.readyForTest=ready;',context);await context.readyForTest;
 const send=(type='GITHUB_PUBLISH',sender={})=>new Promise(resolve=>{
  const result=state.listener({namespace:'diffuse',target:'worker',type},{id:'test',url:'chrome-extension://test/report.html?review=1',frameId:0,...sender},resolve);
  if(result!==true)resolve(null);
 });return{state,send};
}
test('inspected pages, nested frames, other extensions and settings cannot perform GitHub review writes',async()=>{
 const worker=await harness();
 for(const type of ['GITHUB_PUBLISH','GITHUB_RECHECK','GITHUB_LOAD','GITHUB_PUBLICATION_STATUS']){
  for(const sender of [{id:'foreign'},{url:'https://preview.example.test/',tab:{id:42},frameId:0},{url:'chrome-extension://test/settings.html'},{url:'chrome-extension://test/sidepanel.html'},{frameId:1},{url:'chrome-extension://test/report.html.evil'}])await worker.send(type,sender);
 }
 assert.equal(worker.state.created,0);assert.equal(worker.state.calls.length,0);
 assert.equal((await worker.send()).ok,true);assert.equal(worker.state.calls.length,1);
});
test('worker error response only forwards a safe GitHub installation URL',async()=>{
 for(const installationUrl of ['https://github.com/apps/diffuse-review/installations/new','https://evil.test/install','https://github.com/apps/diffuse/installations/new?secret=x','https://github.com@evil.test/apps/diffuse/installations/new']){
  const error=Object.assign(new Error('Install Diffuse on this repository.'),{code:'repository_unavailable',installationUrl});
  const response=await(await harness({error})).send();assert.equal(response.ok,false);
  assert.equal(response.installationUrl,installationUrl==='https://github.com/apps/diffuse-review/installations/new'?installationUrl:undefined);
 }
});
