import {createHmac} from 'node:crypto';
import {createDatabasePool} from './database.mjs';
import {createGitHubApi} from './github-api.mjs';
import {createGitHubAuth} from './github-auth.mjs';
import {createGitHubStore} from './github-store.mjs';
import {createGitHubReviews} from './github-reviews.mjs';
import {fail} from './github-security.mjs';

export const githubAllowedExtensionIds=(process.env.ALLOWED_EXTENSION_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);
let services,database;
const names=['GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_OAUTH_CLIENT_ID','GITHUB_OAUTH_CLIENT_SECRET','GITHUB_APP_ID','GITHUB_APP_PRIVATE_KEY','GITHUB_APP_SLUG','PUBLIC_ORIGIN','DATABASE_URL','TOKEN_ENCRYPTION_KEY','ALLOWED_EXTENSION_IDS'];
export function githubConfigured(){return names.every(name=>Boolean(process.env[name]?.trim()));}
export function getGitHubServices(){
  if(services)return services;if(!githubConfigured())fail('invalid_configuration');
  database||=createDatabasePool(process.env.DATABASE_URL);
  const api=createGitHubApi({clientId:process.env.GITHUB_CLIENT_ID,clientSecret:process.env.GITHUB_CLIENT_SECRET,oauthClientId:process.env.GITHUB_OAUTH_CLIENT_ID,oauthClientSecret:process.env.GITHUB_OAUTH_CLIENT_SECRET,appId:process.env.GITHUB_APP_ID,privateKey:process.env.GITHUB_APP_PRIVATE_KEY,appSlug:process.env.GITHUB_APP_SLUG,publicOrigin:process.env.PUBLIC_ORIGIN});
  const store=createGitHubStore({pool:database}),cryptoKey=process.env.TOKEN_ENCRYPTION_KEY;
  services={api,store,auth:createGitHubAuth({store,api,cryptoKey,allowedExtensionIds:githubAllowedExtensionIds}),reviews:createGitHubReviews({store,api,cryptoKey})};return services;
}
export async function githubRateLimit(req,path){
  getGitHubServices();const now=Date.now(),window=Math.floor(now/60000),address=String(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown').slice(0,256);
  const kind=path.includes('oauth')?'oauth':'api',bucket=createHmac('sha256',process.env.TOKEN_ENCRYPTION_KEY).update(`github:${kind}:${window}:${address}`).digest('hex');
  const limit=kind==='oauth'?20:180;
  const rows=await database.query('INSERT INTO diffuse_github_request_limits(bucket,count,expires_at) VALUES($1,1,$2) ON CONFLICT(bucket) DO UPDATE SET count=diffuse_github_request_limits.count+1 WHERE diffuse_github_request_limits.count<$3 RETURNING count',[bucket,new Date((window+2)*60000),limit]);
  await services.store.cleanup(now);return Boolean(rows.rows.length);
}
