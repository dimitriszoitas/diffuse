// Actual Chrome identity API, temporary extension/profile, fictional one-use
// authorization codes. No user cookies, GitHub credentials, or production calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-real-identity-')),extension=join(temp,'extension'),profile=join(temp,'profile');
const official=JSON.parse(await readFile(join(project,'extension/manifest.json'),'utf8'));
await mkdir(extension);
await writeFile(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Diffuse isolated identity check',version:'1.0',key:official.key,permissions:['identity'],background:{service_worker:'identity-worker.js'}}));
await writeFile(join(extension,'identity-worker.js'),'globalThis.identityReady=true;');
await writeFile(join(extension,'identity.html'),'<!doctype html><title>Real identity fixture</title><button id="connect">Connect fixture</button><output id="result"></output><script src="identity.js"></script>');
await writeFile(join(extension,'identity.js'),`document.querySelector('#connect').onclick=async()=>{
  const result=document.querySelector('#result');result.textContent='pending';
  try {const url=await chrome.identity.launchWebAuthFlow({url:new URL(location.href).searchParams.get('start'),interactive:true});result.textContent=JSON.stringify({ok:true,url,redirect:chrome.identity.getRedirectURL('github')});}
  catch(error){result.textContent=JSON.stringify({ok:false,error:error.message});}
};`);
const issued=new Map(),requests=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');requests.push(url.pathname);
 const code=url.searchParams.get('code'),redirect=url.searchParams.get('redirect');
 if(!issued.has(code)||issued.get(code).used||redirect!==issued.get(code).redirect){res.writeHead(400);res.end('Invalid fixture request');return;}
 issued.get(code).used=true;
 const destination=`${redirect}?code=${encodeURIComponent(code)}`;
 if(url.pathname==='/redirect'){res.writeHead(302,{location:destination});res.end();}
 else if(url.pathname==='/page'){res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Fixture authorization</title><p>Signing in to the isolated fixture.</p><script>setTimeout(()=>location.replace(${JSON.stringify(destination)}),250)</script>`);}
 else{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const child=spawn(process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),['--headless=new','--no-first-run','--no-default-browser-check','--use-mock-keychain','--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let browser;
try{
 let port;const until=Date.now()+20000;
 while(Date.now()<until&&!port){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n')[0];}catch{await pause(80);}}
 assert.ok(port,'Disposable Chromium did not start');
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 const context=browser.contexts()[0];let worker=context.serviceWorkers().find(item=>item.url().endsWith('/identity-worker.js'));
 if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:item=>item.url().endsWith('/identity-worker.js'),timeout:10000});
 const {id,redirect}=await worker.evaluate(()=>({id:chrome.runtime.id,redirect:chrome.identity.getRedirectURL('github')}));
 assert.match(id,/^[a-p]{32}$/);assert.equal(redirect,`https://${id}.chromiumapp.org/github`);
 const page=await context.newPage();
 for(const path of ['/redirect','/page']){
  const code=randomUUID();issued.set(code,{redirect,used:false});
  const start=new URL(`http://127.0.0.1:${server.address().port}${path}`);start.searchParams.set('redirect',redirect);start.searchParams.set('code',code);
  await page.goto(`chrome-extension://${id}/identity.html?start=${encodeURIComponent(start.href)}`);
  await page.getByRole('button',{name:'Connect fixture'}).click();
  await page.waitForFunction(()=>document.querySelector('#result').textContent.startsWith('{'),{},{timeout:20000});
  const result=JSON.parse(await page.locator('#result').textContent());
  assert.equal(result.ok,true,`Actual chrome.identity flow failed: ${result.error}`);
  assert.equal(result.redirect,redirect);assert.equal(result.url,`${redirect}?code=${code}`);assert.equal(issued.get(code).used,true);
  assert.ok(context.pages().every(item=>!new URL(item.url()).hostname.endsWith('.chromiumapp.org')),'Chrome left the intercepted callback as an ordinary browser page');
  console.log(`PASS Actual interactive chrome.identity intercepts ${path==='/redirect'?'HTTP redirect':'loaded-page JavaScript redirect'} at official callback, returns one-use code, and closes auth surface`);
 }
 assert.deepEqual(requests,['/redirect','/page']);
 console.log(`PASS Official extension ID ${id}; separate temporary profile; no identity API replacement or production requests`);
}finally{
 await browser?.close();child.kill('SIGTERM');
 await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();});
 await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}
