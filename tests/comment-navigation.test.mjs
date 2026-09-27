import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {isReviewableUrl,assertPageAccess} from '../extension/core.mjs';
import {createViewportController} from '../extension/viewport-controller.mjs';
import {cleanPinOffset, cleanPinSelection, pinPointFromPosition} from '../extension/review-store.mjs';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},removeListener(fn){this.listeners=this.listeners.filter(item=>item!==fn);}});
const saved=()=>({id:'saved-review',title:'Preserved title',productionUrl:'https://example.test/first',createdAt:'2026-09-01',comments:[{id:'first',fields:{comment:'Original'},selection:null,context:{production:{url:'https://example.test/first',viewport:{width:1440,height:900},viewportProfile:{key:'desktop'}}}},{id:'second',fields:{comment:'Second'},context:{production:{url:'https://example.test/second?q=1#part',viewport:{width:1542,height:1107},viewportProfile:{key:'desktop'}}}}]});
async function harness({review=saved(),initial=null,redirect=null,allow=true}={}){
 const state={review:structuredClone(review),messages:[],tab:{id:9,windowId:1,status:'complete',url:'https://example.test/first'},size:{width:1440,height:900},created:[],injections:0,persisted:null,commands:[],pinWrites:[],remapWrites:[],contextGate:null,inspectGate:null,inspection:remappedSelection()};
 const chrome={runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,getContexts:async()=>[{}],onMessage:event(),onConnect:event(),onInstalled:event(),sendMessage:async()=>({ok:true})},storage:{session:{get:async()=>({comparison:initial}),set:async value=>{state.persisted=structuredClone(value);}}},
 tabs:{onUpdated:event(),onRemoved:event(),onActivated:event(),get:async()=>({...state.tab}),query:async()=>[state.tab],create:async options=>{state.created.push(options);state.tab={...state.tab,url:redirect||options.url};return state.tab;},update:async(_id,options)=>{if(options.url)state.tab.url=redirect||options.url;return state.tab;},sendMessage:async(_id,message)=>{state.messages.push(structuredClone(message));if(message.type==='INITIALIZE')return{ok:true,viewport:state.size};if(message.type==='GET_CONTEXT'){if(state.contextGate)await state.contextGate;return{ok:true,context:{url:state.tab.url,viewport:state.size}};};if(message.type==='REFRESH_SELECTION'){if(state.inspectGate)await state.inspectGate;return{ok:true,selection:structuredClone(state.inspection)};}if(message.type==='REVEAL_COMMENT')return{ok:true,found:true};return{ok:true};}},
 windows:{onFocusChanged:event(),update:async()=>{}},permissions:{contains:async()=>allow},scripting:{executeScript:async()=>{state.injections++;}},offscreen:{closeDocument:async()=>{}},
 debugger:{onDetach:event(),getTargets:async()=>[],attach:async()=>{},detach:async()=>{},sendCommand:async(_target,method,params)=>{state.commands.push({method,params});if(method==='Emulation.setDeviceMetricsOverride')state.size={width:params.width,height:params.height};}}};
 const context=vm.createContext({URL,chrome,createViewportController,crypto:webcrypto,AbortController,DEFAULT_SETTINGS:{},viewportWarning:()=>'',isReviewableUrl,assertPageAccess:(url,api=chrome,message)=>assertPageAccess(url,api,message),reviews:{getReview:async()=>structuredClone(state.review),cleanPinOffset,cleanPinSelection,remapCommentPin:async(reviewId,commentId,selection,position)=>{const pinPoint=selection.kind==='element'?pinPointFromPosition(selection,position):null;assert.equal(reviewId,state.review.id);const comment=state.review.comments.find(item=>item.id===commentId);assert.ok(comment);comment.pinSelection=structuredClone(selection);if(pinPoint)comment.pinPoint=pinPoint;else delete comment.pinPoint;comment.pinOffset={x:0,y:0};state.remapWrites.push({reviewId,commentId,selection:structuredClone(selection)});return structuredClone(comment);},updateCommentPin:async(reviewId,commentId,offset)=>{assert.equal(reviewId,state.review.id);const comment=state.review.comments.find(item=>item.id===commentId);assert.ok(comment);comment.pinOffset=structuredClone(offset);state.pinWrites.push({reviewId,commentId,offset:structuredClone(offset)});return structuredClone(comment);}},protectAIStorage:async()=>{},setTimeout,clearTimeout});
 vm.runInContext(source.replace(/^import .*\n/gm,'')+'\nglobalThis.api={ready,handle,navigateToComment,getSession:()=>session,setSession:value=>{session=value;}};',context);
 await context.api.ready;return{...context.api,state,chrome,send:message=>context.api.handle(message,{id:'test',url:'chrome-extension://test/report.html#review'})};
}
test('opening a review preserves stored data and accepts report hash URLs',async()=>{
 const worker=await harness();const before=structuredClone(worker.state.review);const result=await worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'});
 assert.equal(result.ok,true);assert.equal(result.session.reviewId,before.id);assert.notEqual(result.session.id,before.id);assert.equal(result.session.commentCount,2);assert.equal(worker.state.created[0].url,before.productionUrl);assert.deepEqual(worker.state.review,before);assert.equal(worker.state.messages.find(message=>message.type==='REVEAL_COMMENT').commentId,'first');
});
test('comment navigation retains exact path, query, hash and recorded dimensions',async()=>{
 const worker=await harness();await worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'});const current=worker.getSession();const result=await worker.navigateToComment(current,'second');
 assert.equal(result.ok,true);assert.equal(worker.state.tab.url,'https://example.test/second?q=1#part');assert.equal(result.session.reviewId,'saved-review');assert.equal(result.session.viewportPreset,'desktop');assert.deepEqual(worker.state.size,{width:1542,height:1107});assert.equal(worker.state.messages.filter(message=>message.type==='REVEAL_COMMENT').at(-1).commentId,'second');assert.equal(worker.state.injections,2);
});
test('pending drafts prevent navigation and review replacement before side effects',async()=>{
 const worker=await harness();await worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'});const current=worker.getSession();current.pendingDraftId='draft';const before=worker.state.created.length;
 await assert.rejects(worker.navigateToComment(current,'second'),/Save or cancel/);await assert.rejects(worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'}),/Save or cancel/);assert.equal(worker.state.created.length,before);assert.equal(worker.state.tab.url,'https://example.test/first');
});
test('redirected pages never reveal a saved pin on the wrong URL',async()=>{
 const worker=await harness({redirect:'https://example.test/login'});const result=await worker.send({type:'OPEN_REVIEW',reviewId:'saved-review',commentId:'second'});
 assert.equal(result.ok,true);assert.match(result.session.error,/redirected/);assert.equal(result.session.pendingCommentId,'second');assert.equal(worker.state.messages.some(message=>message.type==='REVEAL_COMMENT'),false);
});
test('unsafe URLs and missing permission fail before creating a tab or replacing a session',async()=>{
 for(const url of ['javascript:alert(1)','chrome://settings/','data:text/html,Hi','https://username:password@example.test/']){
  const review=saved();review.productionUrl=url;review.comments=[];const worker=await harness({review});await assert.rejects(worker.send({type:'OPEN_REVIEW',reviewId:review.id}),/supported|username/);assert.equal(worker.state.created.length,0);
 }
 const worker=await harness({allow:false});await assert.rejects(worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'}),/Allow Diffuse/);assert.equal(worker.state.created.length,0);
});
test('untrusted web pages cannot open a stored review',async()=>{
 const worker=await harness();const result=await worker.handle({type:'OPEN_REVIEW',reviewId:'saved-review'},{id:'test',url:'https://example.test/report.html'});assert.equal(result.ok,false);assert.equal(worker.state.created.length,0);
});


test('an explicit older profile is restored even when its pixel size matches the current window',async()=>{
 const review=saved();review.comments[0].context.production.viewport={width:1280,height:900};
 const worker=await harness({review});worker.state.size={width:1280,height:900};
 const result=await worker.send({type:'OPEN_REVIEW',reviewId:review.id});
 assert.equal(result.session.viewportPreset,'desktop');assert.deepEqual(worker.state.size,{width:1280,height:900});
 assert.equal(worker.state.messages.find(message=>message.type==='REVEAL_COMMENT').commentId,'first');
});


const targetSender=(url='https://example.test/first')=>({id:'test',url,tab:{id:9},frameId:0});
const moveMessage=(current,extra={})=>({type:'UPDATE_COMMENT_PIN',sessionId:current.id,commentId:'first',offset:{x:132.5,y:-47},...extra});
async function pinHarness(){const worker=await harness();await worker.send({type:'OPEN_REVIEW',reviewId:'saved-review'});return worker;}

test('moving a pin publishes its offset while preserving the captured comment and its original element',async()=>{
 const worker=await pinHarness(),before=structuredClone(worker.state.review.comments[0]);
 const result=await worker.handle(moveMessage(worker.getSession()),targetSender());
 assert.equal(result.ok,true);assert.deepEqual(result.pinOffset,{x:132.5,y:-47});
 assert.equal(worker.state.pinWrites.length,1);
 assert.deepEqual(worker.state.review.comments[0],{...before,pinOffset:{x:132.5,y:-47}});
 assert.deepEqual(worker.getSession().comments[0].pinOffset,result.pinOffset);
 assert.deepEqual(worker.state.messages.filter(message=>message.type==='SESSION_UPDATE').at(-1).session.comments[0].pinOffset,result.pinOffset);
 assert.deepEqual(worker.state.persisted.comparison.comments[0].pinOffset,result.pinOffset);
});

test('only the current reviewed top frame can move a pin, never another tab, frame, popup or stale session',async()=>{
 const worker=await pinHarness(),message=moveMessage(worker.getSession());
 for(const from of [{...targetSender(),id:'foreign'}, {...targetSender(),frameId:1}, {...targetSender(),tab:{id:10}}, {id:'test',url:'chrome-extension://test/popup.html'}, {id:'test',url:'chrome-extension://test/report.html'}]) await assert.rejects(worker.handle(message,from));
 assert.equal((await worker.handle({...message,sessionId:'expired'},targetSender())).ok,false);
 await assert.rejects(worker.handle({...message,commentId:'foreign-review-comment'},targetSender()),/no longer available/);
 assert.equal(worker.state.pinWrites.length,0);
});

test('a pin cannot be moved from a different route, viewport or replaced session',async()=>{
 const worker=await pinHarness(),message=moveMessage(worker.getSession());
 await assert.rejects(worker.handle(message,targetSender('https://example.test/elsewhere')),/original page/);
 worker.state.tab.url='https://example.test/redirect';
 await assert.rejects(worker.handle(message,targetSender()),/original page/);
 worker.state.tab.url='https://example.test/first';worker.state.size={width:390,height:844};
 await assert.rejects(worker.handle(message,targetSender()),/viewport/);
 worker.state.size={width:1440,height:900};
 let release;worker.state.contextGate=new Promise(resolve=>{release=resolve;});
 const pending=worker.handle(message,targetSender());await new Promise(setImmediate);
 worker.setSession({...worker.getSession(),id:'replacement'});release();
 await assert.rejects(pending,/review changed/);assert.equal(worker.state.pinWrites.length,0);
});

test('invalid offsets never reach storage and explicit viewport profiles remain valid at custom widths',async()=>{
 const worker=await pinHarness(),current=worker.getSession();
 for(const offset of [null,{}, {x:1}, {x:0,y:'2'}, {x:Infinity,y:0}, {x:0,y:100001}]) await assert.rejects(worker.handle(moveMessage(current,{offset}),targetSender()),/position is invalid/);
 assert.equal(worker.state.pinWrites.length,0);
 current.viewportPreset='desktop';worker.state.size={width:1200,height:900};
 const result=await worker.handle(moveMessage(current,{offset:{x:0,y:0}}),targetSender());
 assert.equal(result.ok,true);assert.deepEqual(result.pinOffset,{x:0,y:0});
});

function remappedSelection() {
 return {schemaVersion:1,kind:'element',selector:'#new-component',selectorFormat:'css',tagName:'button',component:{name:'New component',source:'data-component',selector:'#new-component'},
  anchor:{version:1,kind:'element',selector:'#new-component',identity:{tag:'button',attributes:{id:'new-component'}}},
  rect:{viewport:{x:40,y:80,width:120,height:44},document:{x:40,y:580,width:120,height:44}},
  context:{url:'https://example.test/first',viewport:{width:1440,height:900},scroll:{x:0,y:500},nestedScroll:[{selector:'#nested',x:0,y:80}]}};
}
const remapMessage=(current,extra={})=>({type:'REMAP_COMMENT',sessionId:current.id,commentId:'first',selector:'#new-component',position:{x:70,y:102},...extra});

test('remapping inspects the component afresh, publishes the attachment and resets the moved bubble without rewriting evidence',async()=>{
 const worker=await pinHarness();worker.state.review.comments[0].pinOffset={x:42,y:-12};
 const before=structuredClone(worker.state.review.comments[0]);
 const result=await worker.handle(remapMessage(worker.getSession(),{selection:{selector:'#untrusted'},evidence:{production:'Never replace'}}),targetSender());
 const expected={...remappedSelection(),context:{...remappedSelection().context,viewportProfile:{key:'desktop',mode:'window'}}};
 assert.equal(result.ok,true);assert.deepEqual(result.pinSelection,expected);assert.deepEqual(result.pinPoint,{x:.25,y:.5});assert.deepEqual(result.pinOffset,{x:0,y:0});
 assert.equal(worker.state.remapWrites.length,1);
 assert.deepEqual(worker.state.review.comments[0],{...before,pinSelection:expected,pinPoint:{x:.25,y:.5},pinOffset:{x:0,y:0}});
 assert.deepEqual(worker.state.messages.find(item=>item.type==='REFRESH_SELECTION'),{namespace:'diffuse',type:'REFRESH_SELECTION',sessionId:worker.getSession().id,selector:'#new-component',forRemap:true});
 assert.deepEqual(worker.getSession().comments[0].pinSelection,expected);assert.deepEqual(worker.getSession().comments[0].pinPoint,{x:.25,y:.5});
 assert.deepEqual(worker.state.persisted.comparison.comments[0].pinSelection,expected);
 assert.deepEqual(worker.state.messages.filter(item=>item.type==='SESSION_UPDATE').at(-1).session.comments[0].pinSelection,expected);
});

test('remapping rejects other frames, tabs, extension pages, stale sessions and foreign comment IDs before writing',async()=>{
 const worker=await pinHarness(),message=remapMessage(worker.getSession());
 for(const from of [{...targetSender(),id:'foreign'}, {...targetSender(),frameId:1}, {...targetSender(),tab:{id:10}}, {id:'test',url:'chrome-extension://test/popup.html'}, {id:'test',url:'chrome-extension://test/report.html'}]) await assert.rejects(worker.handle(message,from));
 assert.equal((await worker.handle({...message,sessionId:'expired'},targetSender())).ok,false);
 await assert.rejects(worker.handle({...message,commentId:'foreign-review-comment'},targetSender()),/no longer available/);
 assert.equal(worker.state.remapWrites.length,0);
});

test('remapping rejects changed routes, viewport groups, missing targets and malformed inspected metadata',async()=>{
 const worker=await pinHarness(),message=remapMessage(worker.getSession());
 await assert.rejects(worker.handle(message,targetSender('https://example.test/other')),/original page/);
 worker.state.tab.url='https://example.test/redirect';await assert.rejects(worker.handle(message,targetSender()),/original page/);
 worker.state.tab.url='https://example.test/first';worker.state.size={width:390,height:844};await assert.rejects(worker.handle(message,targetSender()),/viewport/);
 worker.state.size={width:1440,height:900};
 for(const selector of ['',null,'x'.repeat(4097)])await assert.rejects(worker.handle({...message,selector},targetSender()),/Choose a component/);
 for(const inspection of [null,{}, {...remappedSelection(),kind:'region'}, {...remappedSelection(),anchor:null}, {...remappedSelection(),rect:{viewport:{x:0,y:0,width:Infinity,height:2}}}]){
  worker.state.inspection=inspection;await assert.rejects(worker.handle(message,targetSender()),/no longer available/);
 }
 worker.state.inspection=remappedSelection();worker.state.inspection.context.url='https://example.test/redirect';await assert.rejects(worker.handle(message,targetSender()),/original page/);
 worker.state.inspection=remappedSelection();worker.state.inspection.context.viewport={width:390,height:844};await assert.rejects(worker.handle(message,targetSender()),/viewport/);
 assert.equal(worker.state.remapWrites.length,0);
});

test('a session replacement during component inspection cannot persist a remap',async()=>{
 const worker=await pinHarness();let release;worker.state.inspectGate=new Promise(resolve=>{release=resolve;});
 const pending=worker.handle(remapMessage(worker.getSession()),targetSender());await new Promise(setImmediate);
 worker.setSession({...worker.getSession(),id:'replacement'});release();await assert.rejects(pending,/review changed/);
 assert.equal(worker.state.remapWrites.length,0);
});

test('remapped context is retained for navigation and explicit desktop profiles at custom widths',async()=>{
 const worker=await pinHarness(),current=worker.getSession();
 current.viewportPreset='desktop';worker.state.size={width:1200,height:800};worker.state.inspection.context.viewport={width:1200,height:800};
 const result=await worker.handle(remapMessage(current),targetSender());assert.equal(result.ok,true);
 assert.deepEqual(result.pinSelection.context.viewportProfile,{key:'desktop',mode:'preset'});
 worker.state.size={width:1440,height:900};await worker.navigateToComment(current,'first');
 assert.deepEqual(worker.state.size,{width:1200,height:800});assert.equal(current.viewportPreset,'desktop');
});

test('drop points are required and must fall inside the freshly inspected target, with one pixel edge tolerance',async()=>{
 const worker=await pinHarness(),current=worker.getSession();
 for(const position of [null,{}, {x:70}, {x:NaN,y:100}, {x:70,y:Infinity}, {x:38,y:100}, {x:70,y:126}])await assert.rejects(worker.handle(remapMessage(current,{position}),targetSender()),/position is invalid|component moved/);
 assert.equal(worker.state.remapWrites.length,0);
 const edge=await worker.handle(remapMessage(current,{position:{x:39.5,y:124.5}}),targetSender());assert.deepEqual(edge.pinPoint,{x:0,y:1});
 const body=remappedSelection();body.tagName='body';body.selector='body';body.anchor={...body.anchor,selector:'body',identity:{tag:'body',attributes:{}}};body.rect={viewport:{x:0,y:-200,width:1440,height:1600},document:{x:0,y:0,width:1440,height:1600}};
 worker.state.inspection=body;const blank=await worker.handle(remapMessage(current,{selector:'body',position:{x:720,y:600}}),targetSender());assert.deepEqual(blank.pinPoint,{x:.5,y:.5});
});

test('an area remap replaces an element attachment and clears its point without changing captured history',async()=>{
 const worker=await pinHarness(),current=worker.getSession();await worker.handle(remapMessage(current),targetSender());
 const original=structuredClone(worker.state.review.comments[0]);
 const region={schemaVersion:1,kind:'region',component:{name:'Selected area',source:'region'},rect:{viewport:{x:20,y:30,width:180,height:100},document:{x:20,y:530,width:180,height:100}},context:remappedSelection().context};
 worker.state.inspection=region;
 const result=await worker.handle({type:'REMAP_COMMENT',sessionId:current.id,commentId:'first',region:{x:20,y:30,width:180,height:100}},targetSender());
 assert.equal(result.ok,true);assert.equal(result.pinPoint,null);assert.equal(result.pinSelection.kind,'region');assert.deepEqual(result.pinOffset,{x:0,y:0});
 const stored=worker.state.review.comments[0];assert.equal(Object.hasOwn(stored,'pinPoint'),false);
 for(const key of ['selection','context','fields','evidence'])assert.deepEqual(stored[key],original[key]);
 assert.deepEqual(worker.state.messages.filter(item=>item.type==='REFRESH_SELECTION').at(-1),{namespace:'diffuse',type:'REFRESH_SELECTION',sessionId:current.id,region:{x:20,y:30,width:180,height:100},forRemap:true});
 assert.equal(worker.getSession().comments[0].pinSelection.kind,'region');assert.equal(Object.hasOwn(worker.getSession().comments[0],'pinPoint'),false);
});
test('area remapping rejects mixed selection modes and malformed or mismatched regions',async()=>{
 const worker=await pinHarness(),current=worker.getSession(),base={type:'REMAP_COMMENT',sessionId:current.id,commentId:'first'};
 for(const region of [null,{},[],{x:0,y:0,width:0,height:100},{x:-1,y:0,width:10,height:10},{x:0,y:0,width:NaN,height:10}])await assert.rejects(worker.handle({...base,region},targetSender()),/Choose a/);
 const region={x:20,y:30,width:180,height:100};
 await assert.rejects(worker.handle({...base,region,selector:'#new-component'},targetSender()),/component or an area/);
 await assert.rejects(worker.handle({...base,region,position:{x:30,y:40}},targetSender()),/component or an area/);
 await assert.rejects(worker.handle({...base,region},targetSender()),/component or area is no longer/);
 assert.equal(worker.state.remapWrites.length,0);
});
