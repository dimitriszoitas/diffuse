import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';

const port = Number(process.env.PORT || 4180);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const base = 'http://127.0.0.1:' + port;
const files = new Map([['/prototype.html','prototype.html'],['/production.html','production.html']]);
const server = http.createServer(async(req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  let pathname;
  try {pathname = new URL(req.url,base).pathname;} catch {res.writeHead(400);res.end();return;}
  if (pathname === '/') {res.writeHead(302,{Location:'/prototype.html'});res.end();return;}
  if (!files.has(pathname)) {res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Page not found');return;}
  try {
    const bytes = await readFile(join(import.meta.dirname,files.get(pathname)));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':bytes.length});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {res.writeHead(500);res.end('Could not load the demo page. Keep server.mjs beside both HTML files.');}
});
server.on('error',error => {console.error(error.code === 'EADDRINUSE' ? 'Port ' + port + ' is already in use. Open the demo links if it is already running, or choose another PORT.' : error.message);process.exitCode = 1;});
server.listen(port,'127.0.0.1',() => {
  console.log('\nDiffuse playground is ready.\n\nPrototype:  ' + base + '/prototype.html\nProduction: ' + base + '/production.html\n\nKeep this window open. Press Control+C to stop.\n');
  if (!process.argv.includes('--no-open')) for (const path of ['/prototype.html','/production.html']) {
    const url = base + path;
    if (process.platform === 'darwin') execFile('open',[url],()=>{});
    else if (process.platform === 'win32') execFile('rundll32',['url.dll,FileProtocolHandler',url],()=>{});
    else execFile('xdg-open',[url],()=>{});
  }
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close(() => process.exit(0)));
