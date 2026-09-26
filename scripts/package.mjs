import {cp, mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const project = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(project, 'extension/manifest.json'), 'utf8'));
const releases = join(project, 'releases');
const staging = await mkdtemp(join(tmpdir(), 'diffuse-release-'));
try {
  await mkdir(releases, {recursive: true});
  await cp(join(project, 'extension'), join(staging, 'Diffuse'), {recursive: true});
  await cp(join(project, 'QUICKSTART.md'), join(staging, 'START-HERE.md'));
  await cp(join(project, 'README.md'), join(staging, 'Diffuse', 'README.md'));
  const archive = join(releases, `Diffuse-${manifest.version}.zip`);
  await rm(archive, {force: true});
  execFileSync('zip', ['-qr', archive, 'Diffuse', 'START-HERE.md'], {cwd: staging});
  // Keep the unpacked installation path stable so Reload retains the extension ID.
  await cp(join(staging, 'Diffuse'), join(releases, 'Diffuse'), {recursive: true, force: true});
  await cp(join(staging, 'START-HERE.md'), join(releases, 'START-HERE.md'));
  console.log(`Packaged Diffuse ${manifest.version}: ${archive}`);
} finally { await rm(staging, {recursive: true, force: true}); }
