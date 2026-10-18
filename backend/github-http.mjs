import {GitHubError,fail,EXTENSION,UUID} from './github-security.mjs';

function json(res,status,value){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
async function body(req,max=24576){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('invalid_request',415);
  const length=req.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>max))fail('too_large');
  let text;
  if(req.body!==undefined)text=typeof req.body==='string'?req.body:Buffer.isBuffer(req.body)?req.body.toString('utf8'):JSON.stringify(req.body);
  else{const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>max)fail('too_large');chunks.push(Buffer.from(chunk));}text=Buffer.concat(chunks).toString('utf8');}
  if(!text||Buffer.byteLength(text)>max)fail('too_large');let value;try{value=JSON.parse(text);}catch{fail('invalid_request');}if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_request');return value;
}
function param(url,name,required=true){const all=url.searchParams.getAll(name);if(all.length>1||(required&&!all[0]))fail('invalid_request');return all[0];}
function credential(req){const m=/^Bearer ([a-f0-9-]{36}\.[A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization||'');if(!m)fail('unauthorized');return m[1];}
export function createGitHubHandler({getServices,allowedExtensionIds=[],rateLimit=async()=>true,configured=()=>true}){
  const extensions=new Set(allowedExtensionIds.filter(v=>EXTENSION.test(v)));
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");res.setHeader('Vary','Origin');
    const origin=req.headers.origin,id=typeof origin==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(origin)?origin.slice(19):null;
    let api;
    try{
      if(origin&&(!id||!extensions.has(id)))fail('installation_not_allowed');if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
      if(req.method==='OPTIONS'){if(!origin)fail('access_denied');res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.statusCode=204;return res.end();}
      const url=new URL(req.url,'https://diffuse.invalid'),path=url.pathname;
      if(req.method==='GET'&&path==='/github/health')return json(res,200,{service:'Diffuse GitHub connection service',status:'online'});
      if(req.method==='GET'&&path==='/github/v1/config')return json(res,200,{configured:configured(),scopes:{public:'public_repo',private:'repo'},privateRepositoryAccessOptional:true,expiringTokens:true});
      const routes={'/github/v1/oauth/start':['POST'],'/github/v1/oauth/complete':['POST'],'/github/oauth/callback':['GET'],'/github/v1/connection':['GET','DELETE'],'/github/v1/pull':['GET'],'/github/v1/reviews':['GET'],'/github/v1/reviews/prepare':['POST']};
      const match=/^\/github\/v1\/reviews\/([a-f0-9-]{36})(?:\/(chunks|publish|events)(?:\/(\d{1,2}))?)?$/i.exec(path);
      const validMatch=match&&UUID.test(match[1])&&(!match[3]||match[2]==='chunks');
      const methods=routes[path]||(validMatch?(match[3]||!match[2]?['GET']:['POST']):null);
      if(!methods)fail('not_found');if(!methods.includes(req.method))fail('invalid_request',405);
      if(!await rateLimit(req,path))fail('rate_limited');
      const services=await getServices(),{auth,reviews}=services;api=services.api;
      if(path==='/github/v1/oauth/start'){const input=await body(req);if(id&&id!==input.extensionId)fail('installation_not_allowed');return json(res,200,await auth.start(input));}
      if(path==='/github/v1/oauth/complete')return json(res,200,await auth.complete(await body(req)));
      if(path==='/github/oauth/callback'){
        const result=await auth.callback({state:param(url,'state'),code:param(url,'code',false),error:param(url,'error',false)}),target=new URL(result.redirectUrl);
        if(target.protocol!=='https:'||target.port||target.username||target.password||target.hash||target.pathname!=='/github'||!extensions.has(target.hostname.replace(/\.chromiumapp\.org$/,''))||!target.hostname.endsWith('.chromiumapp.org'))fail('invalid_state');
        res.statusCode=302;res.setHeader('Location',target.href);return res.end();
      }
      const token=credential(req);
      if(path==='/github/v1/connection')return json(res,200,req.method==='DELETE'?await auth.disconnect(token):{connection:await auth.authenticate(token)});
      const input=req.method==='POST'?await body(req,match?.[2]==='chunks'?720*1024:match?.[2]==='events'?3*1024*1024:24576):null;
      return json(res,200,await auth.withAccessToken(token,async(accessToken,connection)=>{
        if(path==='/github/v1/pull'){const pull=await api.getPull(accessToken,param(url,'url'));return {pull,installationUrl:api.installationUrl,deployments:await api.deployments(accessToken,pull)};}
        if(path==='/github/v1/reviews')return reviews.list({accessToken,pullUrl:param(url,'pullUrl')});
        if(path==='/github/v1/reviews/prepare')return reviews.prepare({accessToken,connection,input});
        const [,reviewId,operation,index]=match,args={id:reviewId,accessToken,connection,input};
        if(req.method==='GET')return reviews.get({...args,index:index===undefined?undefined:Number(index)});
        if(operation==='chunks')return reviews.putChunk(args);
        if(operation==='publish')return reviews.publish(args);
        return reviews.event(args);
      }));
    }catch(error){
      const e=error instanceof GitHubError?error:new GitHubError('unavailable');
      return json(res,e.status,{error:e.message,code:e.code,...(e.code==='repository_unavailable'&&api?.installationUrl?{installationUrl:api.installationUrl}:{})});
    }
  };
}
