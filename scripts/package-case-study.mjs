import {cp, mkdir, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve, relative} from 'node:path';
import {createHash} from 'node:crypto';

const project = resolve(import.meta.dirname, '..');
const destination = resolve(project, '../deliverables/diffuse-case-study');
const media = join(project, 'artifacts/presentation');
const version = JSON.parse(await readFile(join(project, 'extension/manifest.json'), 'utf8')).version;
const copied = [];
async function add(source, target) {
  const output = join(destination, target);
  await mkdir(resolve(output, '..'), {recursive: true});
  await cp(source, output, {force: true});
  const bytes = await readFile(output);
  copied.push({path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
}
for (const name of ['cover', 'live-comparison', 'comment-evidence', 'ai-review', 'report', 'demo-production', 'demo-prototype']) {
  await add(join(media, `${name}.png`), `screenshots/${name}.png`);
}
for (const name of ['comment-pin', 'recording-evidence', 'area-selection']) {
  const source = join(media, `${name}.png`);
  try { await stat(source); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  await add(source, `screenshots/${name}.png`);
}
for (const name of ['diffuse-showcase.mp4', 'diffuse-showcase.vtt', 'diffuse-showcase.srt', 'transcript.md', 'index.html', 'poster.png', 'example-review.html', 'presentation-info.json']) {
  await add(join(media, name), `video/${name}`);
}
for (const name of ['reveal-loop', 'comment-loop', 'recording-loop']) await add(join(media, `${name}.mp4`), `motion/${name}.mp4`);
await add(join(media, 'timeline.json'), 'source/film-timeline.json');
await add(join(project, 'scripts/create-showcase-v2.mjs'), 'source/create-showcase.mjs');
await add(join(project, 'scripts/showcase-render-v2.mjs'), 'source/showcase-render-v2.mjs');
for (const name of ['production', 'report']) {
  await add(join(media, 'footage-v2', `${name}.webm`), `source/footage-v2/${name}.webm`);
}
await add(join(project, 'releases', `Diffuse-${version}.zip`), `extension/Diffuse-${version}.zip`);
await add(join(project, 'QUICKSTART.md'), 'extension/START-HERE.md');
for (const name of ['test-results.json', 'audit-test-results.json', 'accessibility-overlay-results.json']) {
  await add(join(project, 'artifacts', name), `validation/${name}`);
}
for (const name of ['showcase-production.html', 'showcase-prototype.html', 'showcase.css', 'showcase.js']) {
  await add(join(project, 'demo', name), `demo/${name}`);
}
await writeFile(join(destination, 'demo/serve.mjs'), `import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const files = new Map([['/showcase-production.html','text/html'],['/showcase-prototype.html','text/html'],['/showcase.css','text/css'],['/showcase.js','text/javascript']]);
const port = Number(process.env.PORT || 4178);
http.createServer(async (req,res) => {
  const path = new URL(req.url,'http://localhost').pathname;
  if (!files.has(path)) {res.writeHead(404);res.end('Not found');return;}
  try {res.writeHead(200,{'Content-Type':files.get(path),'X-Frame-Options':'DENY'});res.end(await readFile(join(import.meta.dirname,path.slice(1))));}
  catch {res.writeHead(500);res.end('Could not load demo');}
}).listen(port,'127.0.0.1',()=>console.log('Forma demo: http://127.0.0.1:'+port+'/showcase-production.html'));
`);
const storyPath = join(destination, 'case-study.md');
const story = await readFile(storyPath, 'utf8');
await writeFile(storyPath, story.replaceAll('](images/', '](screenshots/').replaceAll('](videos/diffuse.mp4)', '](video/diffuse-showcase.mp4)').replaceAll('](videos/diffuse.vtt)', '](video/diffuse-showcase.vtt)'));
await writeFile(join(destination, 'files.json'), JSON.stringify({version,generatedAt:new Date().toISOString(),assets:copied},null,2)+'\n');

// Whitelist only final, reusable deliverables. Test profiles and temporary captures
// never enter this archive. The portfolio patch is shipped alongside the assets.
const archive = resolve(destination, '..', `Diffuse-case-study-${version}.zip`);
await rm(archive, {force:true});
const include = ['README.md','asset-manifest.md','ACCESSIBILITY.md','case-study.md','files.json','brand','screenshots','video','motion','extension','demo','source','validation'];
for (const item of include) await stat(join(destination,item));
execFileSync('zip',['-qr',archive,...include],{cwd:destination});
execFileSync('zip',['-qr',archive,'portfolio-patch'],{cwd:resolve(destination,'..')});
console.log(`Created ${relative(project,archive)} (${((await stat(archive)).size/1048576).toFixed(1)} MiB)`);
