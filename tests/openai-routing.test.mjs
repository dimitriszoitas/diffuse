import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewScreens, sanitizeAIConfig} from '../extension/ai-client.mjs';
import {requestJourneyDecision, requestJourneyFollowUp, JOURNEY_DIMENSIONS} from '../extension/journey-ai.mjs';
import {generateJiraTitles} from '../extension/jira-titles.mjs';
import {requestOpenAIJSON} from '../extension/openai-client.mjs';

const key = 'sk-proj-openai-routing-fixture-not-a-real-key';
const image = {dataUrl:'data:image/png;base64,aW1hZ2U=',width:1200,height:800};
const observation = {url:'https://example.test/',title:'Ingredients',text:'New ingredient',controls:[{id:'create',role:'button',label:'New ingredient'}],screenshot:image};
const response = value => Response.json({status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const review = {summary:'The captured page is readable.',limitations:['Interactions were not tested.'],suggestions:[]};
const config = {apiKey:key,provider:'openai',model:'gpt-6.1-sol'};

test('OpenAI settings select a matching default and reject cross-provider model IDs',()=>{
  assert.equal(sanitizeAIConfig({provider:'openai'}).model,'gpt-6.1-sol');
  assert.throws(()=>sanitizeAIConfig({provider:'openai',model:'claude-opus-5-5'}));
  assert.throws(()=>sanitizeAIConfig({provider:'anthropic',model:'gpt-6.1-sol'}));
  assert.throws(()=>sanitizeAIConfig({provider:'custom',model:'gpt-6.1-sol'}));
});

test('OpenAI screenshot review sends strict Responses JSON, embedded evidence and headers only credentials',async()=>{
  const calls=[];
  const result=await reviewScreens({...config,production:image,prototype:image},{fetchImpl:async(url,init)=>{
    calls.push({url,...init,body:JSON.parse(init.body)});return response(review);
  }});
  assert.equal(result.provider,'openai');assert.equal(calls.length,1);
  const request=calls[0];assert.equal(request.url,'https://api.openai.com/v1/responses');
  assert.equal(request.headers.authorization,`Bearer ${key}`);assert.equal(request.headers['x-api-key'],undefined);
  assert.equal(request.credentials,'omit');assert.equal(request.redirect,'error');
  assert.equal(request.body.model,'gpt-6.1-sol');assert.equal(request.body.store,false);
  assert.equal(request.body.text.format.type,'json_schema');assert.equal(request.body.text.format.strict,true);
  assert.equal(request.body.input[0].content.filter(item=>item.type==='input_image').length,2);
  assert.equal(request.body.input[0].content.find(item=>item.type==='input_image').image_url,image.dataUrl);
  assert.equal(JSON.stringify(request.body).includes(key),false);
});

test('OpenAI journey decisions and saved-run chat preserve existing local validators',async()=>{
  const calls=[];const fetchImpl=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return response({action:{type:'click',targetId:'create'},reason:'Open the ingredient form.'});};
  const result=await requestJourneyDecision({...config,goal:'Create an ingredient',observation},{fetchImpl});
  assert.equal(result.action.targetId,'create');assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  await assert.rejects(requestJourneyDecision({...config,goal:'Create an ingredient',observation},{fetchImpl:async()=>response({action:{type:'click',targetId:'invented'},reason:'Open form.'})}),error=>error.code==='JOURNEY_OUTPUT');
  const run={provider:'openai',goal:'Create an ingredient',status:'stopped',steps:[{index:1,observation,action:{type:'click',targetId:'create'},reason:'Open form.'}],followUps:[]};
  const answer=await requestJourneyFollowUp({...config,run,question:'Why this control?'},{fetchImpl:async()=>response({answer:'Its label matched the task.',evidenceSteps:[1],routeSuggestion:null})});
  assert.deepEqual(answer.evidenceSteps,[1]);
  let sent=false;
  await assert.rejects(requestJourneyFollowUp({...config,run:{...run,provider:undefined},question:'Why?'},{fetchImpl:async()=>{sent=true;return response({});}}),error=>error.code==='AI_PROVIDER');
  assert.equal(sent,false,'Old Anthropic evidence must not be sent to OpenAI');
});

test('strict journey schemas require nullable optional fields and restore omitted values before validation', async()=>{
  let schema;
  const fetchImpl=async(url,init)=>{schema=JSON.parse(init.body).text.format.schema;return response({action:{type:'scroll',direction:'down',targetId:null},reason:'Look for more ingredients.'});};
  const scroll=await requestJourneyDecision({...config,goal:'Create an ingredient',observation},{fetchImpl});
  assert.deepEqual(scroll.action,{type:'scroll',direction:'down'});
  const check=value=>{
    if(!value||typeof value!=='object')return;
    if(value.type==='object'){
      assert.deepEqual([...value.required].sort(),Object.keys(value.properties).sort());
      assert.equal(value.additionalProperties,false);
    }
    Object.values(value).forEach(check);
  };
  check(schema);
  const completed=await requestJourneyDecision({...config,goal:'Create an ingredient',observation},{fetchImpl:async()=>response({action:{type:'finish',outcome:'inconclusive',summary:'The result is not visible.',findings:[],helpQuestion:null,
    scores:JOURNEY_DIMENSIONS.map(dimension=>({dimension,score:null,reason:'Not tested.',evidenceSteps:[],confidence:0}))},reason:'The saved evidence does not prove completion.'})});
  assert.equal(Object.hasOwn(completed.action,'helpQuestion'),false);
  assert.equal(completed.action.scores[0].score,null,'Required nullable scores remain null');
});

test('Jira title generation uses only OpenAI when selected and never falls back',async()=>{
  const comments=[{id:'1',fields:{comment:'Save looks disabled even after entering a name.'}}];
  const calls=[];
  const result=await generateJiraTitles(comments,config,{fetchImpl:async(url,init)=>{calls.push(url);assert.equal(JSON.stringify(JSON.parse(init.body)).includes('example.test'),false);return response({titles:[{index:0,title:'Clarify when Save is available'}]});}});
  assert.equal(result.titles[0].title,'Clarify when Save is available');
  assert.deepEqual(calls,['https://api.openai.com/v1/responses']);
  const failedCalls=[];
  const failed=await generateJiraTitles(comments,config,{fetchImpl:async url=>{failedCalls.push(url);return Response.json({error:{message:key}},{status:401});}});
  assert.equal(failed.reason,'unavailable');assert.deepEqual(failedCalls,['https://api.openai.com/v1/responses']);
});

test('OpenAI errors, refusals, incomplete and credential-bearing responses remain safe',async()=>{
  for(const [status,code] of [[401,'AI_AUTH'],[403,'AI_PERMISSION'],[404,'AI_MODEL'],[429,'AI_RATE_LIMIT'],[400,'AI_REQUEST'],[503,'AI_SERVICE']]){
    let calls=0;
    await assert.rejects(reviewScreens({...config,production:image,mode:'audit'},{fetchImpl:async()=>{calls++;return Response.json({error:{message:`private evidence ${key}`}},{status});}}),error=>error.code===code&&!error.message.includes(key)&&!error.message.includes('private evidence'));
    assert.equal(calls,1);
  }
  for(const envelope of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:key}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...review,summary:key})}]}]}]){
    await assert.rejects(reviewScreens({...config,production:image,mode:'audit'},{fetchImpl:async()=>Response.json(envelope)}),error=>['AI_OUTPUT','AI_REFUSAL'].includes(error.code)&&!error.message.includes(key));
  }
  let sent=false;const controller=new AbortController();controller.abort();
  await assert.rejects(requestOpenAIJSON({...config,signal:controller.signal,content:[],schema:{},fetchImpl:async()=>{sent=true;}}),error=>error.code==='AI_CANCELLED');assert.equal(sent,false);
});
