import {createSign} from 'node:crypto';
import {fail, GitHubError, SHA, parsePullUrl} from './github-security.mjs';

const API='https://api.github.com';
const MAX_RESPONSE=3*1024*1024;
const integer = value => Number.isSafeInteger(value) && value>0;
export function createGitHubApi({clientId,clientSecret,oauthClientId,oauthClientSecret,publicOrigin,appId,privateKey,appSlug,fetchImpl=fetch,clock=Date.now}={}) {
  let origin; try {origin=new URL(publicOrigin);} catch {fail('invalid_configuration');}
  if(origin.protocol!=='https:'||origin.origin!==publicOrigin||!clientId||!clientSecret||!/^\d+$/.test(String(appId))||!privateKey||!/^[a-z0-9-]{1,100}$/.test(appSlug)) fail('invalid_configuration');
  const callback=`${publicOrigin}/github/oauth/callback`;
  const installationUrl=`https://github.com/apps/${appSlug}/installations/new`;
  async function request(url,{token,method='GET',body,raw=false,maxBytes=MAX_RESPONSE}={}) {
    const target=new URL(url);
    if(!['https://api.github.com','https://github.com','https://uploads.github.com'].includes(target.origin)) fail('invalid_request');
    const upload=target.origin==='https://uploads.github.com';
    const uploadDiagnostic=(status,code)=>{if(upload)console.warn(JSON.stringify({event:'diffuse_github_provider_error',endpoint:'attachment_upload',status,code}));};
    let response;
    try {
      response=await fetchImpl(target.href,{method,redirect:upload?'manual':'error',signal:AbortSignal.timeout(20_000),headers:{Accept:target.origin==='https://github.com'?'application/json':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Diffuse-Review',...(token?{Authorization:`${upload?'token':'Bearer'} ${token}`}:{ }),...(body?{'Content-Type':raw?'application/octet-stream':'application/json'}:{})},...(body?{body:raw?body:JSON.stringify(body)}:{})});
      if(!response.ok){
        uploadDiagnostic(response.status,response.status>=300&&response.status<400?'redirect_blocked':'http_error');
        if(upload){const accepted=response.headers?.get('x-accepted-github-permissions');if(accepted&&/^[a-z_ =,;]{1,512}$/i.test(accepted))console.warn(JSON.stringify({event:'diffuse_github_provider_permissions',endpoint:'attachment_upload',status:response.status,acceptedPermissions:accepted}));}
        if(response.status===401)fail('unauthorized');
        if(response.status===429||response.headers?.get('x-ratelimit-remaining')==='0')fail('rate_limited');
        if(response.status===403||response.status===404)fail('repository_unavailable');
        fail('unavailable');
      }
      if(response.status===204)return null;
      const limit=Number(response.headers?.get('content-length')||0); if(limit>maxBytes)fail('invalid_response');
      let text;
      if(response.body?.getReader){const reader=response.body.getReader(),parts=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel();fail('invalid_response');}parts.push(Buffer.from(value));}text=Buffer.concat(parts).toString('utf8');}finally{reader.releaseLock();}}
      else text=await response.text();
      if(Buffer.byteLength(text)>maxBytes)fail('invalid_response');
      return JSON.parse(text);
    }catch(error){if(error instanceof GitHubError)throw error;uploadDiagnostic(response?.status||0,error?.name==='TimeoutError'?'timeout':'transport_or_response_error');fail('unavailable');}
  }
  async function tokenRequest(body,{provider='github-app',scope}={}){
    if(!['oauth','github-app'].includes(provider))fail('invalid_request');
    const oauth=provider==='oauth';
    if(oauth&&(!oauthClientId||!oauthClientSecret||!['public_repo','repo'].includes(scope)))fail('invalid_configuration');
    const data=await request('https://github.com/login/oauth/access_token',{method:'POST',body:{client_id:oauth?oauthClientId:clientId,client_secret:oauth?oauthClientSecret:clientSecret,...body}});
    if(data?.error)fail('unauthorized');
    if(oauth){
      if(typeof data?.access_token!=='string'||!/^gho_[A-Za-z0-9_]{10,255}$/.test(data.access_token)||data.token_type?.toLowerCase()!=='bearer'||typeof data.scope!=='string')fail('invalid_response');
      const scopes=data.scope.split(/[ ,]+/).filter(Boolean);
      // Request only the selected scope; never silently accept a broader grant
      // when the person chose public repositories.
      if(!scopes.includes(scope)||scopes.some(value=>value!==scope&&value!=='offline_access'))fail('access_denied');
      const pair={kind:'oauth',accessToken:data.access_token,scope};
      if(data.refresh_token!==undefined||data.expires_in!==undefined||data.refresh_token_expires_in!==undefined){
        if(typeof data.refresh_token!=='string'||!/^ghr_[A-Za-z0-9_]{10,255}$/.test(data.refresh_token)||!integer(data.expires_in)||data.expires_in>86400||!integer(data.refresh_token_expires_in))fail('invalid_response');
        Object.assign(pair,{refreshToken:data.refresh_token,expiresAt:clock()+data.expires_in*1000,refreshExpiresAt:clock()+data.refresh_token_expires_in*1000});
      }
      return pair;
    }
    if(typeof data?.access_token!=='string'||!/^ghu_[A-Za-z0-9_]{10,255}$/.test(data.access_token)||typeof data.refresh_token!=='string'||!/^ghr_[A-Za-z0-9_]{10,255}$/.test(data.refresh_token)||!integer(data.expires_in)||data.expires_in>86400||!integer(data.refresh_token_expires_in))fail('invalid_response');
    return {accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:clock()+data.expires_in*1000,refreshExpiresAt:clock()+data.refresh_token_expires_in*1000};
  }
  const repoPath=p=>`/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  function appJwt(){
    const now=Math.floor(clock()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:String(appId)})).toString('base64url');
    const value=`${header}.${payload}`;
    try{const sign=createSign('RSA-SHA256');sign.update(value);return `${value}.${sign.sign(privateKey.replace(/\\n/g,'\n'),'base64url')}`;}catch{fail('invalid_configuration');}
  }
  async function getPull(accessToken,url){
    const p=parsePullUrl(url),base=repoPath(p);
    const [repo,pull]=await Promise.all([request(`${API}${base}`,{token:accessToken}),request(`${API}${base}/pulls/${p.number}`,{token:accessToken})]);
    if(!integer(repo?.id)||!SHA.test(pull?.head?.sha)||pull?.number!==p.number||pull?.base?.repo?.id!==repo.id||!['open','closed'].includes(pull?.state))fail('invalid_response');
    const canonical=parsePullUrl(pull.html_url);
    if(canonical.owner.toLowerCase()!==p.owner.toLowerCase()||canonical.repo.toLowerCase()!==p.repo.toLowerCase()||canonical.number!==p.number)fail('invalid_response');
    const result={...canonical,title:String(pull.title||'').slice(0,1000),headSha:pull.head.sha,state:pull.state,repoId:repo.id,private:repo.private===true,canWrite:repo.permissions?.push===true||repo.permissions?.admin===true||repo.permissions?.maintain===true};
    await getInstallation(result);
    return result;
  }
  async function getInstallation(pull){
    const installation=await request(`${API}${repoPath(pull)}/installation`,{token:appJwt()});
    if(!integer(installation?.id)||installation.app_id!==Number(appId)||installation.suspended_at)fail('repository_unavailable');
    return installation;
  }
  async function installationToken(pull){
    const jwt=appJwt(),installation=await getInstallation(pull);
    const pair=await request(`${API}/app/installations/${installation.id}/access_tokens`,{token:jwt,method:'POST',body:{repository_ids:[pull.repoId],permissions:{pull_requests:'write',metadata:'read'}}});
    if(typeof pair?.token!=='string'||pair.token.length<20||pair.token.length>512)fail('invalid_response');
    return pair.token;
  }
  return {
    installationUrl,
    authorizationUrl({state,challenge,provider='github-app',scope}) {
      if(!['oauth','github-app'].includes(provider))fail('invalid_request');const oauth=provider==='oauth';
      if(oauth&&(!oauthClientId||!oauthClientSecret||!['public_repo','repo'].includes(scope)))fail('invalid_configuration');
      const url=new URL('https://github.com/login/oauth/authorize');url.search=new URLSearchParams({client_id:oauth?oauthClientId:clientId,redirect_uri:callback,state,scope:oauth?`${scope} offline_access`:'offline_access',code_challenge:challenge,code_challenge_method:'S256'}).toString();return url.href;
    },
    exchangeCode({code,verifier,provider='github-app',scope}) {return tokenRequest({code,redirect_uri:callback,code_verifier:verifier},{provider,scope});},
    refreshTokens({refreshToken,provider='github-app',scope}) {return tokenRequest({grant_type:'refresh_token',refresh_token:refreshToken},{provider,scope});},
    async user(accessToken){const value=await request(`${API}/user`,{token:accessToken});if(!integer(value?.id)||!/^[A-Za-z0-9-]{1,39}$/.test(value?.login))fail('invalid_response');return {accountId:String(value.id),login:value.login,displayName:String(value.name||value.login).slice(0,200)};},
    getPull,
    async deployments(accessToken,pull){
      try {
        const deployments=await request(`${API}${repoPath(pull)}/deployments?sha=${pull.headSha}&per_page=10`,{token:accessToken});
        if(!Array.isArray(deployments))return [];
        const rows=await Promise.all(deployments.filter(d=>integer(d?.id)&&d.sha===pull.headSha).slice(0,5).map(async d=>{
          const statuses=await request(`${API}${repoPath(pull)}/deployments/${d.id}/statuses?per_page=10`,{token:accessToken});
          const status=Array.isArray(statuses)?statuses.find(s=>s.state==='success'&&s.environment_url):null;
          let url;try{url=new URL(status?.environment_url);}catch{return null;}
          if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
          return {id:d.id,sha:d.sha,environment:String(d.environment||'Preview').slice(0,100),url:url.href};
        }));return rows.filter(Boolean);
      }catch(error){if(error.code==='repository_unavailable')return [];throw error;}
    },
    async findSummary(pull,marker){
      const token=await installationToken(pull);
      for(let page=1;page<=20;page++){
        const rows=await request(`${API}${repoPath(pull)}/issues/${pull.number}/comments?per_page=100&page=${page}`,{token});
        if(!Array.isArray(rows))fail('invalid_response');
        const found=rows.find(row=>row.performed_via_github_app?.id===Number(appId)&&typeof row.body==='string'&&row.body.startsWith(marker));
        if(found)return {id:found.id,url:found.html_url,body:found.body};
        if(rows.length<100)return null;
      }
      fail('publication_uncertain');
    },
    async writeSummary(pull,{commentId,body}){
      if(typeof body!=='string'||body.length>60000)fail('too_large');
      const token=await installationToken(pull);
      if(commentId){
        const old=await request(`${API}${repoPath(pull)}/issues/comments/${commentId}`,{token});
        if(old?.performed_via_github_app?.id!==Number(appId))fail('access_denied');
      }
      const result=await request(`${API}${repoPath(pull)}/issues/${commentId?`comments/${commentId}`:`${pull.number}/comments`}`,{token,method:commentId?'PATCH':'POST',body:{body}});
      if(!integer(result?.id)||typeof result.html_url!=='string'||!result.html_url.startsWith(`${pull.url}#issuecomment-`))fail('invalid_response');
      return {id:result.id,url:result.html_url};
    },
    async upload(accessToken,pull,{name,contentType,bytes}){
      if(typeof accessToken==='string'&&accessToken.startsWith('ghu_'))fail('reconnect_required');
      if(!pull.canWrite)fail('read_only');
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>10*1024*1024||!/^[a-z0-9_.-]{1,150}$/i.test(name)||!['image/png','image/jpeg','image/webp','video/mp4','video/webm'].includes(contentType))fail('invalid_request');
      const url=new URL('https://uploads.github.com/user-attachments/assets');url.search=new URLSearchParams({name,content_type:contentType,repository_id:String(pull.repoId)}).toString();
      let data;try{data=await request(url.href,{token:accessToken,method:'POST',body:bytes,raw:true});}catch(error){if(['unauthorized','rate_limited'].includes(error.code))throw error;fail('upload_failed');}
      let asset;try{asset=new URL(data?.url);}catch{console.warn(JSON.stringify({event:'diffuse_github_provider_error',endpoint:'attachment_upload',status:200,code:'missing_asset_url'}));fail('upload_failed');}
      if(asset.origin!=='https://github.com'||!/^\/user-attachments\/assets\/[a-f0-9-]{36}$/.test(asset.pathname)||asset.search||asset.hash||asset.username||asset.password){console.warn(JSON.stringify({event:'diffuse_github_provider_error',endpoint:'attachment_upload',status:200,code:'unsupported_asset_url'}));fail('upload_failed');}
      return asset.href;
    }
  };
}
