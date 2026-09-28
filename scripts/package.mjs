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
  await mkdir(join(staging, 'Diffuse', 'docs', 'releases'), {recursive: true});
  for (const name of ['PRIVACY.md', 'TERMS.md', 'jira-integration.md']) await cp(join(project, 'docs', name), join(staging, 'Diffuse', 'docs', name));
  await cp(join(project, 'docs', 'releases', `${manifest.version}.md`), join(staging, 'Diffuse', 'docs', 'releases', `${manifest.version}.md`));
  const archive = join(releases, `Diffuse-${manifest.version}.zip`);
  await rm(archive, {force: true});
  execFileSync('zip', ['-qr', archive, 'Diffuse', 'START-HERE.md'], {cwd: staging});
  // Never overwrite a legacy unkeyed installation: its reviews belong to its old ID.
  // Official keyed releases share their identity regardless of extraction path.
  await cp(join(staging, 'Diffuse'), join(releases, `Diffuse-${manifest.version}`), {recursive: true, force: true});
  await cp(join(staging, 'START-HERE.md'), join(releases, 'START-HERE.md'));
  console.log(`Packaged Diffuse ${manifest.version}: ${archive}`);
} finally { await rm(staging, {recursive: true, force: true}); }
