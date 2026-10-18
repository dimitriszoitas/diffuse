import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {cleanPreviewUrl, mapPreviewUrl, projectReviewToPreview} from '../extension/pr-review.mjs';

// Exercise the actual worker capture boundary with browser/capture dependencies
// replaced. The screenshot pipeline has its own tests; these protect the build,
// route and viewport association required before sharing fresh verification.
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function functionSource(name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n${next}`, start);
  assert.ok(start >= 0 && end > start, `Locate ${name} in background.js`);
  return source.slice(start > 5 && source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
}
const captureSource = functionSource('capturePRVerification', 'function getGitHubWorker(');
const pageUrlSource = functionSource('savedPageUrl', 'function savedCommentUrl(');
const viewportSource = functionSource('savedCommentViewport', 'async function waitForReviewPage(');
const head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
const oldCapture = '2026-10-17T12:00:00.000Z', newCapture = '2026-10-18T12:00:00.000Z';
const image = 'data:image/png;base64,aW1hZ2U=';
const clone = value => structuredClone(value);

function harness() {
  const context = {owner:'team', repo:'prototype', number:42, url:'https://github.com/team/prototype/pull/42',
    headSha:head, previewUrl:'https://new-preview.example.test/', sourcePreviewUrl:'https://old-preview.example.test/', association:'manual'};
  const originalContext = {url:'https://old-preview.example.test/releases?state=ready#card-1',
    viewport:{width:1534, height:1065}, viewportProfile:{key:'desktop', mode:'window'}, scroll:{x:0,y:200}};
  const comment = {id:'finding-local', findingKey:'finding-portable', createdAt:oldCapture,
    fields:{comment:'The release action is unclear.'}, context:{production:originalContext},
    selection:{selector:'#release',context:clone(originalContext)},
    evidence:{production:{dataUrl:image,width:1534,height:1065,capturedAt:oldCapture}}};
  const review = {id:'review-local',reviewKey:'review-portable',productionUrl:originalContext.url,comments:[comment],prContext:context};
  const mappedUrl = mapPreviewUrl(originalContext.url, context.sourcePreviewUrl, context.previewUrl);
  const state = {review,comment,context,mappedUrl,calls:[],discarded:[],beforeCapture:null,
    tab:{id:7,url:mappedUrl}, pageContext:{...clone(originalContext),url:mappedUrl},
    draft:{id:'verification-draft',createdAt:newCapture,context:{production:{...clone(originalContext),url:mappedUrl}},
      evidence:{production:{dataUrl:image,width:1534,height:1065,capturedAt:newCapture}}}};
  const sandbox = {
    session:{id:'live-session',reviewId:review.id,targetTabId:7,status:'live',prContext:clone(context)},
    URL, structuredClone, cleanPreviewUrl,mapPreviewUrl,projectReviewToPreview,
    isReviewableUrl:value=>/^https?:\/\//.test(value),
    assertReferenceReady(current){assert.equal(current,sandbox.session);state.calls.push('ready');},
    chrome:{tabs:{async get(id){assert.equal(id,7);return clone(state.tab);}}},
    async tabMessage(id,type){assert.equal(id,7);assert.equal(type,'GET_CONTEXT');return {context:clone(state.pageContext)};},
    async focusTab(id){assert.equal(id,7);state.calls.push('focus');},
    async captureDraft(selection,options){assert.equal(selection,null);assert.equal(options.pending,false);state.calls.push('capture');await state.beforeCapture?.();return clone(state.draft);},
    reviews:{async discardDraft(id){state.discarded.push(id);}},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${pageUrlSource}\n${viewportSource}\n${captureSource}`,sandbox);
  return {...state,state,sandbox,capture:()=>sandbox.capturePRVerification({review,comment,context})};
}

test('verification captures the mapped route and exact recorded viewport without changing original evidence',async()=>{
  const h=harness(),original=clone(h.review);
  const evidence=await h.capture();
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)),{dataUrl:image,width:1534,height:1065,capturedAt:newCapture,pageUrl:h.mappedUrl});
  assert.deepEqual(h.state.calls,['ready','focus','capture']);
  assert.deepEqual(h.state.discarded,['verification-draft']);
  assert.deepEqual(h.review,original);
});

test('a previous build, a different PR or a different preview cannot supply verification evidence',async()=>{
  for(const mutate of [
    h=>{h.sandbox.session.prContext.headSha=nextHead;},
    h=>{h.sandbox.session.prContext.url='https://github.com/team/prototype/pull/43';},
    h=>{h.sandbox.session.prContext.previewUrl='https://other-preview.example.test/';},
    h=>{h.sandbox.session.reviewId='other-local-review';},
    h=>{h.sandbox.session.status='starting';}
  ]) {
    const h=harness();mutate(h);
    await assert.rejects(h.capture(),/build changed|Open this finding/);
    assert.ok(!h.state.calls.includes('capture'));assert.deepEqual(h.state.discarded,[]);
  }
});

test('verification cannot capture a different path, query state or hash on the selected preview',async()=>{
  for(const url of ['https://new-preview.example.test/other?state=ready#card-1',
    'https://new-preview.example.test/releases?state=other#card-1',
    'https://new-preview.example.test/releases?state=ready#card-2']) {
    const h=harness();h.state.tab.url=url;
    await assert.rejects(h.capture(),/Open the finding on this preview/);
    assert.ok(!h.state.calls.includes('capture'));
  }
});

test('same desktop category is insufficient when actual width or height differs from the recorded viewport',async()=>{
  for(const viewport of [{width:1440,height:900},{width:1534,height:900},{width:1536,height:1065},{width:1534,height:1067}]) {
    const h=harness();h.sandbox.session.viewportPreset='desktop';h.state.pageContext.viewport=viewport;
    await assert.rejects(h.capture(),/recorded viewport/);assert.ok(!h.state.calls.includes('capture'));
  }
  const h=harness();h.state.pageContext.viewport={width:1535,height:1066};
  await h.capture();assert.ok(h.state.calls.includes('capture'),'One pixel rounding is tolerated');
});

test('build, preview, session and geometry changes during capture discard the temporary screenshot',async()=>{
  for(const mutate of [
    h=>{h.sandbox.session.prContext.headSha=nextHead;},
    h=>{h.sandbox.session.prContext.url='https://github.com/team/prototype/pull/43';},
    h=>{h.sandbox.session.prContext.previewUrl='https://other-preview.example.test/';},
    h=>{h.sandbox.session=clone(h.sandbox.session);},
    h=>{h.state.draft.context.production.url='https://new-preview.example.test/elsewhere';},
    h=>{h.state.draft.context.production.viewport.width=1440;},
    h=>{h.state.draft.context.production.viewport.height=900;}
  ]) {
    const h=harness(),original=clone(h.review);h.state.beforeCapture=()=>mutate(h);
    await assert.rejects(h.capture(),/page or selected build changed/);
    assert.deepEqual(h.state.discarded,['verification-draft']);assert.deepEqual(h.review,original);
  }
});

test('a missing saved selector does not fabricate a target or overwrite the captured source',async()=>{
  const h=harness();h.comment.selection.selector='#removed-component';
  const before=clone(h.comment),evidence=await h.capture();
  assert.equal(evidence.pageUrl,h.mappedUrl);assert.deepEqual(h.comment,before);
  // A human may verify that the component was deliberately removed. This
  // screenshot boundary still demands the correct build, route and viewport.
  assert.deepEqual(h.state.calls,['ready','focus','capture']);
});
