import {readFile, writeFile, mkdir, chmod, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'demo/playground');
const output = resolve(root, '../deliverables/diffuse-playground');
await mkdir(output, {recursive:true});
const [template,css,js] = await Promise.all(['page.html','styles.css','app.js'].map(file => readFile(join(source,file),'utf8')));
for (const variant of ['prototype','production']) {
  const title = variant === 'prototype' ? 'Prototype' : 'Production';
  const html = template.replaceAll('__TITLE__',title).replaceAll('__VERSION__',variant).replaceAll('__OTHER__',variant === 'prototype' ? 'production' : 'prototype').replace('/* INLINE_STYLES */',() => css).replace('/* INLINE_SCRIPT */',() => js);
  await writeFile(join(output,variant + '.html'),html);
}
for (const file of ['server.mjs','START-MAC.command','START-WINDOWS.bat']) await writeFile(join(output,file),await readFile(join(source,file)));
await chmod(join(output,'START-MAC.command'),0o755);
if (!process.argv.includes('--pages-only')) {
  const archive = resolve(output,'..','Diffuse-playground.zip');
  await rm(archive,{force:true});
  execFileSync('zip',['-qr',archive,'diffuse-playground/prototype.html','diffuse-playground/production.html','diffuse-playground/server.mjs','diffuse-playground/START-MAC.command','diffuse-playground/START-WINDOWS.bat','diffuse-playground/README.md','diffuse-playground/DIFFERENCES.md'],{cwd:resolve(output,'..')});
  console.log('Download: ' + archive);
}
console.log('Demo pages: ' + output);
