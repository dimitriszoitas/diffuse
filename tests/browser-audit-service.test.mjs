import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserAuditService} from '../extension/browser-audit-service.mjs';
import {browserAuditRequest, browserAuditURL, pairBrowserAudit, readBrowserAuditConfig} from '../extension/browser-audit-client.mjs';
import {browserAuditAnalysisEvidence, validateBrowserAuditAnalysis, analyzeBrowserAudit} from '../extension/browser-audit-ai.mjs';
import {browserAuditSummary} from '../extension/browser-audit-store.mjs';

const token = 'a'.repeat(43), key = 'sk-proj-browser-audit-test-not-real';
const ai = {provider:'openai',model:'gpt-6.1-sol',hasKey:true,apiKey:key};
const evidence = {page:{url:'https://example.test/form?secret=yes#private',title:'Example'},styles:{elementsInspected:2,typography:[{fontFamily:'Inter',fontSize:'23px',count:2,examples:[{text:'Title',selector:'h1'}]}]},screenshots:[{dataUrl:'data:image/png;base64,cHJpdmF0ZQ=='}]};
const result = {summary:'One typography variant was measured.',limitations:['Current page only.'],findings:[{title:'Check heading consistency',description:'The heading is 23px.',recommendation:'Compare this with the intended heading scale.',severity:'minor',assessment:'heuristic',evidenceIds:['typography:1']}]};
function harness({analyze = async()=>result, request, acceptFinding} = {}) {
  const records = new Map(), calls = [], tabs = [];
  let session={id:'session',reviewId:'review',target:{url:'https://example.test/form',title:'Example'}};
  const store={save:async value=>{records.set(value.id,structuredClone(value));return value;},get:async id=>structuredClone(records.get(id)),list:async reviewId=>[...records.values()].filter(a=>a.reviewId===reviewId).map(browserAuditSummary)};
  let remote={id:'audit-1',status:'opening',steps:[]};
  const service=createBrowserAuditService({getSession:()=>session,store,readConfig:async({includeToken}={})=>({paired:true,...includeToken?{token}:{}}),readAI:async()=>({...ai}),
    chromeApi:{permissions:{contains:async()=>true},tabs:{create:async tab=>tabs.push(tab)},runtime:{getURL:path=>`chrome-extension://diffuse/${path}`}},
    request:async(path,options)=>{calls.push({path,options});if(request)return request(path,options);if(path.endsWith('/run'))remote={...remote,status:'running'};if(path.endsWith('/stop'))remote={...remote,status:'stopped'};return {audit:structuredClone(remote)};},analyze,acceptFinding});
  return {service,records,calls,tabs,store,setSession:value=>{session=value;},setRemote:value=>{remote=value;}};
}
const open = h=>h.service.handle({type:'BROWSER_AUDIT_OPEN',url:'https://example.test/form',checks:{styles:true}});
test('loopback client rejects endpoints/tools, credentials and its own helper URL',async()=>{
  assert.throws(()=>browserAuditURL('javascript:alert(1)'));
  assert.throws(()=>browserAuditURL('https://user:pass@example.test/'));
  assert.throws(()=>browserAuditURL('http://localhost:8932/audits'));
  await assert.rejects(browserAuditRequest('https://evil.test/',{token}));
  await assert.rejects(browserAuditRequest('/tools/call',{token}));
  let captured;
  await browserAuditRequest('/health',{token,fetchImpl:async(url,options)=>{captured={url,options};return Response.json({ok:true});}});
  assert.equal(captured.url,'http://127.0.0.1:8932/health');assert.equal(captured.options.redirect,'error');assert.equal(captured.options.credentials,'omit');
  await assert.rejects(browserAuditRequest('/health',{token,fetchImpl:async()=>Response.json({echo:token})}),/credential/);
});
test('pairing is remembered only after authentication; public config never exposes secret',async()=>{
  const data={}; const storage={get:async()=>data,set:async value=>Object.assign(data,value),setAccessLevel:async()=>{}};
  await assert.rejects(pairBrowserAudit(token,{storage,fetchImpl:async()=>Response.json({error:'private text'},{status:403})}));assert.deepEqual(data,{});
  await pairBrowserAudit(token,{storage,fetchImpl:async()=>Response.json({ok:true})});
  const publicConfig=await readBrowserAuditConfig({storage});assert.equal(publicConfig.paired,true);assert.equal(JSON.stringify(publicConfig).includes(token),false);
});
test('local collection saves ready/running/stopped ledgers without invoking AI',async()=>{
  let modelCalls=0;const h=harness({analyze:async()=>{modelCalls++;}});
  await open(h);assert.equal(h.records.get('audit-1').reviewId,'review');
  h.setRemote({id:'audit-1',status:'ready',steps:[{id:1,description:'Opened website',status:'completed'}]});
  await h.service.handle({type:'BROWSER_AUDIT_STATE',id:'audit-1'});
  await h.service.handle({type:'BROWSER_AUDIT_RUN',id:'audit-1'});
  const stopped=await h.service.handle({type:'BROWSER_AUDIT_STOP',id:'audit-1'});
  assert.equal(stopped.audit.status,'stopped');assert.equal(stopped.audit.steps.length,1);assert.equal(modelCalls,0);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const auditTime = index => `2026-10-28T12:00:0${index}.000Z`;
const ledger = () => [{id: 1, description: 'Collected typography', status: 'completed'}];

test('offline Stop preserves local evidence and retries only the idempotent stop when helper recovers', async () => {
  let online = false;
  const remote = {id: 'audit-1', status: 'stopped', steps: ledger(), evidence, updatedAt: auditTime(3)};
  const h = harness({request: async path => {
    assert.equal(path, '/audits/audit-1/stop');
    if (!online) throw Object.assign(new Error('Start the local browser helper.'), {code: 'AUDIT_OFFLINE'});
    return {audit: remote};
  }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'running', helperUpdatedAt: auditTime(1), steps: ledger(), evidence, analysis: {summary: 'Earlier analysis stays saved'}});
  const stopped = (await h.service.handle({type: 'BROWSER_AUDIT_STOP', id: 'audit-1'})).audit;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopUnconfirmed, true);
  assert.match(stopped.error, /could not confirm/);
  assert.match(stopped.syncError, /local browser helper/);
  assert.deepEqual(stopped.steps, ledger());
  assert.deepEqual(stopped.evidence, evidence);
  assert.equal(stopped.analysis.summary, 'Earlier analysis stays saved');
  online = true;
  const recovered = (await h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'})).audit;
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.stopUnconfirmed, false);
  assert.equal(recovered.syncError, null);
  assert.deepEqual(recovered.evidence, evidence);
  assert.equal(recovered.analysis.summary, 'Earlier analysis stays saved');
  assert.deepEqual(h.calls.map(call => [call.path, call.options.method]), [['/audits/audit-1/stop', 'POST'], ['/audits/audit-1/stop', 'POST']]);
  await h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'});
  assert.equal(h.calls.length, 2, 'A confirmed stopped audit no longer needs helper calls');
});

test('missing helper job confirms a formerly unconfirmed local stop without losing the saved ledger', async () => {
  const h = harness({request: async () => { throw Object.assign(new Error('This helper no longer has the job.'), {code: 'AUDIT_MISSING'}); }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'stopped', stopUnconfirmed: true, steps: ledger(), evidence});
  const state = (await h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'})).audit;
  assert.equal(state.status, 'stopped');
  assert.equal(state.stopUnconfirmed, false);
  assert.match(state.error, /session ended/);
  assert.deepEqual(state.steps, ledger());
  assert.deepEqual(state.evidence, evidence);
  await h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'});
  assert.equal(h.calls.length, 1, 'A missing job does not cause endless stop retries');
});

test('a delayed pre-run helper response cannot regress a newer running audit or its evidence', async () => {
  const readStarted = deferred(), oldRead = deferred();
  const steps = [...ledger(), {id: 2, description: 'Checking accessibility', status: 'running'}];
  const h = harness({request: async path => {
    if (path.endsWith('/run')) return {audit: {id: 'audit-1', status: 'running', updatedAt: auditTime(2), steps, evidence}};
    readStarted.resolve(); return oldRead.promise;
  }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'ready', helperUpdatedAt: auditTime(1), steps: ledger()});
  const oldRequest = h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'});
  await readStarted.promise;
  await h.service.handle({type: 'BROWSER_AUDIT_RUN', id: 'audit-1'});
  oldRead.resolve({audit: {id: 'audit-1', status: 'ready', updatedAt: auditTime(1), steps: []}});
  const state = (await oldRequest).audit;
  assert.equal(state.status, 'running');
  assert.equal(state.helperUpdatedAt, auditTime(2));
  assert.deepEqual(state.steps, steps);
  assert.deepEqual(state.evidence, evidence);
  assert.equal(h.records.get('audit-1').reviewId, 'review');
});

test('a delayed running response cannot reopen a terminal audit even without a helper timestamp', async () => {
  const readStarted = deferred(), oldRead = deferred();
  const h = harness({request: async path => {
    if (path.endsWith('/stop')) return {audit: {id: 'audit-1', status: 'stopped', steps: ledger(), evidence}};
    readStarted.resolve(); return oldRead.promise;
  }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'running', steps: ledger(), evidence});
  const oldRequest = h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'});
  await readStarted.promise;
  await h.service.handle({type: 'BROWSER_AUDIT_STOP', id: 'audit-1'});
  oldRead.resolve({audit: {id: 'audit-1', status: 'running', steps: []}});
  const state = (await oldRequest).audit;
  assert.equal(state.status, 'stopped');
  assert.deepEqual(state.steps, ledger());
  assert.deepEqual(state.evidence, evidence);
});

test('a delayed running response cannot undo an offline Stop or clear the unconfirmed-stop flag', async () => {
  const readStarted = deferred(), oldRead = deferred();
  const h = harness({request: async path => {
    if (path.endsWith('/stop')) throw Object.assign(new Error('Helper offline'), {code: 'AUDIT_OFFLINE'});
    readStarted.resolve(); return oldRead.promise;
  }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'running', helperUpdatedAt: auditTime(1), steps: ledger(), evidence});
  const oldRequest = h.service.handle({type: 'BROWSER_AUDIT_STATE', id: 'audit-1'});
  await readStarted.promise;
  await h.service.handle({type: 'BROWSER_AUDIT_STOP', id: 'audit-1'});
  oldRead.resolve({audit: {id: 'audit-1', status: 'running', updatedAt: auditTime(2), steps: []}});
  const state = (await oldRequest).audit;
  assert.equal(state.status, 'stopped');
  assert.equal(state.stopUnconfirmed, true);
  assert.match(state.error, /could not confirm/);
  assert.deepEqual(state.steps, ledger());
  assert.deepEqual(state.evidence, evidence);
});

test('concurrent accepts share one callback and later retries keep the same finding identity', async () => {
  const finish = deferred(), entered = deferred(), identities = [], savedComments = new Map();
  let creations = 0;
  const h = harness({acceptFinding: async (_audit, index, identity) => {
    assert.equal(index, 0); identities.push(identity); entered.resolve(); await finish.promise;
    if (!savedComments.has(identity)) savedComments.set(identity, `comment-${++creations}`);
    return savedComments.get(identity);
  }});
  await h.store.save({id: 'audit-1', reviewId: 'review', status: 'completed', steps: [], evidence, analysis: {...result, createdAt: auditTime(1)}});
  const first = h.service.handle({type: 'BROWSER_AUDIT_ACCEPT', id: 'audit-1', findingIndex: 0});
  const simultaneous = h.service.handle({type: 'BROWSER_AUDIT_ACCEPT', id: 'audit-1', findingIndex: 0});
  await entered.promise;
  assert.equal(identities.length, 1);
  finish.resolve();
  assert.deepEqual(await Promise.all([first, simultaneous]), [{ok: true, commentId: 'comment-1'}, {ok: true, commentId: 'comment-1'}]);
  assert.equal((await h.service.handle({type: 'BROWSER_AUDIT_ACCEPT', id: 'audit-1', findingIndex: 0})).commentId, 'comment-1');
  assert.equal(identities.length, 2, 'Sequential retry uses the persistent callback with the same idempotency identity');
  assert.equal(identities[0], identities[1]);
  assert.equal(creations, 1);
  await assert.rejects(h.service.handle({type: 'BROWSER_AUDIT_ACCEPT', id: 'audit-1', findingIndex: 1}), /Choose a finding/);
  await assert.rejects(h.service.handle({type: 'BROWSER_AUDIT_ACCEPT', id: 'audit-1', findingIndex: '0'}), /Choose a finding/);
  assert.equal(identities.length, 2, 'Invalid selections do not enter the accept callback');
});
test('provider changes and duplicate analysis are blocked before spending',async()=>{
  let finish, calls=0; const h=harness({analyze:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  await h.store.save({id:'audit-1',reviewId:'review',status:'completed',steps:[],evidence});
  await assert.rejects(h.service.handle({type:'BROWSER_AUDIT_ANALYZE',id:'audit-1',expectedProvider:'anthropic'}),/provider changed/);assert.equal(calls,0);
  const attempts=await Promise.allSettled([1,2].map(()=>h.service.handle({type:'BROWSER_AUDIT_ANALYZE',id:'audit-1',expectedProvider:'openai'})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
  finish(result);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.records.get('audit-1').analysisStatus,'completed');
});
test('interrupted analysis recovers without retry, and mismatched helper IDs never overwrite ownership',async()=>{
  const h=harness();await h.store.save({id:'audit-1',reviewId:'review',status:'completed',analysisStatus:'running',steps:[],evidence});
  const restored=await h.service.handle({type:'BROWSER_AUDIT_STATE',id:'audit-1'});assert.equal(restored.audit.analysisStatus,'error');assert.match(restored.audit.analysisError,/interrupted/);
  await h.store.save({...restored.audit,status:'ready'});h.setRemote({id:'other',status:'completed',steps:[]});
  const mismatch=await h.service.handle({type:'BROWSER_AUDIT_STATE',id:'audit-1'});assert.equal(mismatch.audit.id,'audit-1');assert.equal(mismatch.audit.reviewId,'review');assert.match(mismatch.audit.syncError,/another audit/);
});
test('AI evidence excludes screenshots, URL secrets and arbitrary helper fields; validates citations',()=>{
  const subset=browserAuditAnalysisEvidence({status:'completed',evidence:{...evidence,cookies:'secret',rawLog:'secret'},steps:[]});
  assert.equal(subset.page.url,'https://example.test/form');assert.equal(JSON.stringify(subset).includes('base64'),false);assert.equal(JSON.stringify(subset).includes('secret'),false);
  assert.equal(validateBrowserAuditAnalysis(result,subset).findings[0].assessment,'heuristic');
  assert.throws(()=>validateBrowserAuditAnalysis({...result,findings:[{...result.findings[0],evidenceIds:['invented']}]},subset));
  assert.throws(()=>validateBrowserAuditAnalysis({...result,summary:key},subset,[key]));
});
test('AI analysis sends one text-only request to selected provider and never retries or falls back',async()=>{
  const calls=[];
  const value=await analyzeBrowserAudit({status:'completed',evidence,steps:[]},ai,{fetchImpl:async(url,options)=>{calls.push(url);const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(JSON.stringify(body).includes('base64'),false);assert.equal(body.input[0].content.every(block=>block.type==='input_text'),true);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});}});
  assert.equal(value.provider,'openai');assert.deepEqual(calls,['https://api.openai.com/v1/responses']);
  const failed=[];await assert.rejects(analyzeBrowserAudit({status:'completed',evidence,steps:[]},ai,{fetchImpl:async url=>{failed.push(url);return Response.json({},{status:503});}}));assert.equal(failed.length,1);
});
