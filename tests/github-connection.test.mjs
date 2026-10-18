import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {createGitHubConnectionClient,GitHubConnectionError,GITHUB_BACKEND_ORIGIN} from '../extension/github-connection.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',extensionId='abcdefghijklmnopabcdefghijklmnop',secret='A'.repeat(43);
const connection={id,credential:`${id}.${secret}`,login:'designer',displayName:'Designer'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function setup(options={}) {
 const calls=[],local=structuredClone(options.local||{}),session={};
 const storage=data=>({async setAccessLevel(){},async get(key){return structuredClone(key===null?data:{[key]:data[key]});},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}});
 const auth=new URL('https://github.com/login/oauth/authorize');auth.searchParams.set('client_id','app-client');auth.searchParams.set('state',secret);auth.searchParams.set('redirect_uri',`${GITHUB_BACKEND_ORIGIN}/github/oauth/callback`);
 const chromeApi={runtime:{id:extensionId},storage:{local:storage(local),session:storage(session)},permissions:{request(value){calls.push(['permission',value]);return Promise.resolve(options.permission!==false);}},identity:{async launchWebAuthFlow(value){calls.push(['launch',value]);return options.callback||`https://${extensionId}.chromiumapp.org/github?code=${secret}`;}}};
 const fetchImpl=async(url,init)=>{const path=new URL(url).pathname;const data=init.body?JSON.parse(init.body):undefined;calls.push(['fetch',{url,path,init,data}]);if(options.fetchImpl)return options.fetchImpl(url,init);if(path.endsWith('/oauth/start')){auth.searchParams.set('scope',options.scope||`${data.privateRepositoryAccess?'repo':'public_repo'} offline_access`);return json({authorizationUrl:options.authorizationUrl||auth.href});}if(path.endsWith('/oauth/complete'))return json({connection:options.connection||connection});if(path.endsWith('/connection'))return json({connection,disconnected:true});return json(options.response||{reviews:[]});};
 return {client:createGitHubConnectionClient({chromeApi,fetchImpl,cryptoImpl:webcrypto,timeoutMs:100}),calls,local,session};
}
const saved={['diffuseGitHubConnection:'+id]:connection};
test('GitHub connect requests access in gesture and binds handoff with random SHA-256 proof',async()=>{
 const {client,calls,local,session}=setup();const pending=client.connect();assert.equal(calls[0][0],'permission');const result=await pending;assert.deepEqual(result,{id,login:'designer',displayName:'Designer'});assert.equal(local['diffuseGitHubConnection:'+id].credential,connection.credential);assert.deepEqual(session,{});const requests=calls.filter(([type])=>type==='fetch').map(([,item])=>item);assert.equal(requests[0].data.challenge,createHash('sha256').update(requests[1].data.verifier).digest('base64url'));assert.ok(requests.every(item=>item.init.redirect==='error'&&item.init.credentials==='omit'));
});
test('GitHub rejects substituted provider URL and callback origin',async()=>{
 for(const options of [{authorizationUrl:'https://evil.test/login/oauth/authorize'},{callback:`https://evil.test/github?code=${secret}`},{callback:`https://${extensionId}.chromiumapp.org/jira?code=${secret}`}]){const{client,local}=setup(options);await assert.rejects(client.connect(),{code:'invalid_response'});assert.deepEqual(local,{});}
});
test('OAuth is public by default and private repo access requires explicit opt in',async()=>{
 for(const privateRepositoryAccess of [false,true]){const{client,calls}=setup();await client.connect({privateRepositoryAccess});const start=calls.find(([type,item])=>type==='fetch'&&item.path.endsWith('/oauth/start'))[1];assert.equal(start.data.privateRepositoryAccess,privateRepositoryAccess);const url=new URL(calls.find(([type])=>type==='launch')[1].url);assert.equal(url.searchParams.get('scope'),`${privateRepositoryAccess?'repo':'public_repo'} offline_access`);}
 const{client,calls}=setup();await assert.rejects(client.connect({privateRepositoryAccess:'yes'}),{code:'invalid_input'});assert.equal(calls.length,0);
 const mismatch=setup({scope:'repo offline_access'});await assert.rejects(mismatch.client.connect(),{code:'invalid_response'});assert.equal(mismatch.calls.some(([type])=>type==='launch'),false,'A wider scope cannot silently replace public-only consent');
});
test('GitHub request boundary blocks unlisted routes and body methods before sending credentials',async()=>{
 const {client,calls}=setup({local:saved});
 for(const [path,options]of [['https://evil.test/github/v1/pull',{}],['/github/v1/connection',{}],['/github/v1/reviews',{method:'POST',body:{}}],['/github/v1/pull?url=x&credential=secret',{}],['/github/v1/reviews/'+id+'/events',{method:'GET'}],['/github/v1/reviews/'+id+'/chunks/-1',{}]])await assert.rejects(client.request(id,path,options),{code:'request_not_allowed'});
 assert.equal(calls.length,0);
});
test('GitHub metadata and chunk routes use only saved connection credentials',async()=>{
 const {client,calls}=setup({local:saved});for(const path of ['/github/v1/pull?url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1','/github/v1/reviews?pullUrl=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1',`/github/v1/reviews/${id}`,`/github/v1/reviews/${id}/chunks/0`])await client.request(id,path);
 for(const path of ['/github/v1/reviews/prepare',`/github/v1/reviews/${id}/chunks`,`/github/v1/reviews/${id}/publish`,`/github/v1/reviews/${id}/events`])await client.request(id,path,{method:'POST',body:{x:1}});
 assert.equal(calls.length,8);assert.ok(calls.every(([,request])=>request.init.headers.Authorization===`Bearer ${connection.credential}`));
});
test('GitHub public metadata never returns capabilities from a malformed backend response',async()=>{
 const {client}=setup({local:saved,response:{credential:'private',access_token:'private',nested:{authorization:'private',okay:'visible'}}});assert.deepEqual(await client.request(id,'/github/v1/pull?url=x'),{nested:{okay:'visible'}});
});
test('Revocation removes only that account, transient failures retain it',async()=>{
 for(const status of [401,503]){const{client,local}=setup({local:{...saved,unrelated:'keep'},fetchImpl:async()=>json({code:'unauthorized'},status)});await assert.rejects(client.refresh(id),GitHubConnectionError);assert.equal(local.unrelated,'keep');assert.equal(Boolean(local['diffuseGitHubConnection:'+id]),status!==401);}
});
test('Disconnect revokes capability and removes local account without review deletion',async()=>{const{client,local}=setup({local:{...saved,review:'keep'}});await client.disconnect(id);assert.deepEqual(local,{review:'keep'});});
test('GitHub permission denial never starts sign in',async()=>{const{client,calls}=setup({permission:false});await assert.rejects(client.connect(),{code:'permission_denied'});assert.equal(calls.length,1);});
test('Invalid stored account metadata is ignored, not exposed',async()=>{const{client}=setup({local:{...saved,another:'secret',['diffuseGitHubConnection:bad']:{...connection,login:'<script>'}}});assert.deepEqual(await client.listConnections(),[{id,login:'designer',displayName:'Designer'}]);});

test('Refusing an operation does not revoke an otherwise valid GitHub account',async()=>{for(const code of ['access_denied','author_only','read_only']){const{client,local}=setup({local:saved,fetchImpl:async()=>json({code},code==='access_denied'?401:403)});await assert.rejects(client.request(id,`/github/v1/reviews/${id}/publish`,{method:'POST',body:{}}),{code});assert.ok(local['diffuseGitHubConnection:'+id]);}});

test('Changed feedback preserves the specific recovery code without revoking the connection',async()=>{
 const{client,local}=setup({local:saved,fetchImpl:async()=>json({code:'review_changed'},409)});
 await assert.rejects(client.request(id,`/github/v1/reviews/${id}/publish`,{method:'POST',body:{}}),error=>{
  assert.ok(error instanceof GitHubConnectionError);assert.equal(error.code,'review_changed');assert.equal(error.status,409);assert.match(error.message,/Preview it again/);return true;
 });
 assert.deepEqual(await client.listConnections(),[{id,login:'designer',displayName:'Designer'}]);
 assert.ok(local['diffuseGitHubConnection:'+id]);
});
