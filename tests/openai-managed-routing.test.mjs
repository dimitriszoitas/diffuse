import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedJourneyDriver, requestManagedJourneyFollowUp} from '../extension/journey-managed.mjs';
import {reviewScreensManaged} from '../extension/review-managed.mjs';
import {openAIAgentAccountFingerprint, OPENAI_AGENT_MODEL, OPENAI_JOURNEY_AGENT_REVISION} from '../extension/openai-agent-config.mjs';
import {JOURNEY_DIMENSIONS} from '../extension/journey-ai.mjs';
import {ManagedAgentError} from '../extension/claude-agents-client.mjs';

const KEY = 'sk-proj-managed-routing-fixture-not-real';
const image = {dataUrl:'data:image/png;base64,aW1hZ2U=',width:1200,height:800};
const observation = {url:'https://example.test/',title:'Ingredients',text:'Create ingredient',controls:[{id:'create',role:'button',label:'Create ingredient'}],screenshot:image};
const args = history => ({goal:'Create an ingredient',observation,history:history || []});
const scores = () => JOURNEY_DIMENSIONS.map(dimension=>({dimension,score:null,reason:'Not tested.',evidenceSteps:[],confidence:0}));
const json = content => content.filter(block=>block.type==='text').flatMap(block=>{try{return [JSON.parse(block.text)];}catch{return [];}});
const reply = {answer:'The recorded control label matched the task.',evidenceSteps:[1],routeSuggestion:null};

async function fixture() {
  const account = await openAIAgentAccountFingerprint(KEY);
  const calls = {sessions:[],sent:[],waits:[],interrupts:[]};
  const content = new Map();
  let sequence=0, actorCount=0;
  const client = {
    async createSession(options) {
      calls.sessions.push({...options,initialContent:structuredClone(options.initialContent)});
      assert.ok(options.initialContent?.length,'OpenAI initial evidence is sent atomically with creation');
      const id=`session_${options.agentId}_${++sequence}`;content.set(id,options.initialContent);return{id};
    },
    async sendEvents(id,events) { calls.sent.push({id,events:structuredClone(events)});content.set(id,events[0].content); },
    async waitForTool(id,options) {
      calls.waits.push({id,options});
      const base={toolUseId:`call_${++sequence}`,cursor:{seenIds:[`event_${sequence}`]}};
      if(options.toolNames.includes('journey_step')) {
        const payload=json(content.get(id)).find(item=>item.currentStep);
        const action=++actorCount===1?{type:'click',targetId:'create'}:{type:'finish',outcome:'completed',summary:'Ingredient is visible.'};
        return{...base,name:'journey_step',input:{action,reason:'The visible label matches the goal.',observationStep:payload.currentStep,observationToken:payload.observationToken}};
      }
      if(options.toolNames.includes('journey_assessment')) return{...base,name:'journey_assessment',input:{action:{type:'finish',outcome:'completed',summary:'The evidence confirms creation.',findings:[],scores:scores()},reason:'Reviewed the saved observations.'}};
      return{...base,name:'journey_answer',input:reply};
    },
    async interrupt(id) { calls.interrupts.push(id); },
  };
  const agents={ready:true,provider:'openai',model:OPENAI_AGENT_MODEL,revision:OPENAI_JOURNEY_AGENT_REVISION,account,environmentId:'none',actor:{id:'actor',version:1},evaluator:{id:'evaluator',version:1}};
  const driver=await createManagedJourneyDriver({config:{provider:'openai',apiKey:KEY,journeyBudgetUsd:2},agents,client});
  return{driver,client,calls,account,agents};
}

test('OpenAI actor and evaluator create one session each with initial evidence and no duplicate initial event',async()=>{
  const f=await fixture();
  const first=await f.driver.decide(args());
  const history=[{index:1,observation,...first,executionStatus:'complete',result:{performed:true}}];
  const result=await f.driver.decide(args(history));
  assert.equal(result.action.outcome,'completed');
  assert.equal(f.driver.metadata.provider,'openai');assert.equal(f.driver.metadata.model,'gpt-6.1-sol');
  assert.equal(f.calls.sessions.length,2);assert.deepEqual(f.calls.sessions.map(item=>item.budgetUsd),[1.5,.5]);
  assert.equal(f.calls.sent.length,1,'Only the subsequent actor tool result uses sendEvents');
  assert.equal(f.calls.sent[0].events[0].type,'user.custom_tool_result');
  assert.equal(json(f.calls.sent[0].events[0].content)[0].previousProposal.executionStatus,'complete');
  assert.ok(f.calls.sessions.every(item=>item.initialContent.some(block=>block.type==='image')));
  assert.equal(JSON.stringify(f.calls.sessions).includes(KEY),false);
  const metadata=f.driver.metadata;
  await f.driver.close();
  assert.deepEqual(f.calls.interrupts,[],'Idle evaluator remains available for discussion');
  const run={id:'run-openai',provider:'openai',goal:'Create an ingredient',status:'completed',steps:history,followUps:[],managed:metadata};
  const answer=await requestManagedJourneyFollowUp({provider:'openai',apiKey:KEY,run,question:'Why this control?',client:f.client});
  assert.equal(answer.answer,reply.answer);assert.equal(f.calls.sessions.length,2,'Discussion shares the evaluator budget');
  assert.equal(f.calls.sent.at(-1).events[0].custom_tool_use_id,metadata.evaluatorPendingToolId);
});

test('stopped OpenAI journeys reserve one evaluator and send the first question atomically',async()=>{
  const f=await fixture();let saved=f.driver.metadata;
  const run={id:'run-stopped',provider:'openai',goal:'Create an ingredient',status:'stopped',steps:[{index:1,observation,action:{type:'click',targetId:'create'},reason:'Open form.'}],followUps:[],managed:saved};
  const answer=await requestManagedJourneyFollowUp({provider:'openai',apiKey:KEY,run,question:'Why did it stop?',client:f.client,onMetadata:async value=>{saved=value;}});
  assert.equal(answer.answer,reply.answer);assert.equal(f.calls.sessions.length,1);assert.equal(f.calls.sent.length,0);
  assert.equal(json(f.calls.sessions[0].initialContent)[0].question,'Why did it stop?');
  assert.equal(saved.evaluatorRequestInFlight,false);assert.ok(saved.evaluatorPendingToolId);
  await f.driver.close();
});

test('provider mismatches and exhausted evaluator budgets fail without a new request or budget',async()=>{
  const f=await fixture();
  const run={provider:'openai',goal:'Create an ingredient',status:'stopped',steps:[{index:1,observation}],managed:f.driver.metadata};
  await assert.rejects(requestManagedJourneyFollowUp({provider:'anthropic',apiKey:KEY,run,question:'Why?',client:f.client}),{code:'AI_PROVIDER'});
  await assert.rejects(requestManagedJourneyFollowUp({provider:'openai',apiKey:KEY,run:{...run,managed:{...run.managed,evaluatorBudgetExhausted:true}},question:'Why?',client:f.client}),{code:'AGENT_BUDGET'});
  assert.equal(f.calls.sessions.length,0);assert.equal(f.calls.sent.length,0);
  await f.driver.close();
});

test('uncertain OpenAI evaluator creation remains reserved across a chat retry',async()=>{
  const f=await fixture();let saved=f.driver.metadata;
  let attempts=0;f.client.createSession=async()=>{attempts++;throw new ManagedAgentError('AGENT_NETWORK','The session creation was not confirmed.',{ambiguous:true});};
  const run={provider:'openai',goal:'Create an ingredient',status:'stopped',steps:[{index:1,observation}],managed:saved};
  const ask=()=>requestManagedJourneyFollowUp({provider:'openai',apiKey:KEY,run:{...run,managed:saved},question:'Why?',client:f.client,onMetadata:async value=>{saved=value;}});
  await assert.rejects(ask(),{code:'AGENT_NETWORK'});assert.equal(saved.evaluatorSessionCreationUncertain,true);
  await assert.rejects(ask(),{code:'AGENT_SESSION'});assert.equal(attempts,1);
  await f.driver.close();
});

test('OpenAI UX and accessibility review uses its registry, atomic input and result validation',async()=>{
  const calls=[];let interrupted=0;
  const client={async createSession(options){calls.push(options);return{id:'session_review'};},async sendEvents(){throw new Error('Duplicate initial input');},async waitForTool(){return{name:'review_assessment',input:{summary:'No visible issues.',limitations:[],suggestions:[]}};},async interrupt(){interrupted++;}};
  const result=await reviewScreensManaged({apiKey:KEY,provider:'openai',mode:'audit',production:image},{storage:{},client,
    resolveAgent:async()=>({ready:true,provider:'openai',environmentId:'none',reviewer:{id:'reviewer',version:1}}),verifyAgent:async()=>{}});
  assert.equal(result.provider,'openai');assert.equal(result.model,'gpt-6.1-sol');assert.equal(calls.length,1);
  assert.ok(calls[0].initialContent.some(block=>block.type==='image'));assert.equal(interrupted,1);
  assert.ok(result.limitations.some(item=>item.includes('not a WCAG')));
});
