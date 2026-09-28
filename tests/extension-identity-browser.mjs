import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const source = process.env.EXTENSION_IDENTITY_SOURCE || join(project, 'extension');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const stableId = 'gdoidkknjbnfmeikloaafdohpjlafgbj';
const temp = await mkdtemp(join(tmpdir(), 'diffuse-identity-'));
const artifacts = join(project, 'artifacts', 'extension-identity');
const checks = [];
let context;
let browserVersion;
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };

async function copyFixture(name, withKey = true) {
  const path = join(temp, name);
  await cp(source, path, {recursive: true});
  const fixtureManifest = {...manifest};
  if (!withKey) delete fixtureManifest.key;
  await writeFile(join(path, 'manifest.json'), JSON.stringify(fixtureManifest));
  const workerFile = join(path, 'background.js');
  const worker = await readFile(workerFile, 'utf8');
  const marker = "import * as reviews from './review-store.mjs';";
  assert.ok(worker.includes(marker));
  await writeFile(workerFile, worker.replace(marker, `${marker}\nimport * as transfer from './review-transfer.mjs';\nglobalThis.__identityFixture = {reviews, transfer};`));
  return path;
}

async function launch(profile, extensions) {
  context = await chromium.launchPersistentContext(join(temp, profile), {
    executablePath: chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`, '--use-mock-keychain', '--password-store=basic']
  });
  browserVersion = context.browser().version();
  const start = Date.now();
  while (context.serviceWorkers().length < extensions.length) {
    assert.ok(Date.now() - start < 12000, 'Extension workers did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return context.serviceWorkers();
}

async function close() { await context.close(); context = null; }
const idOf = worker => new URL(worker.url()).host;
const saved = worker => worker.evaluate(async () => ({
  local: await chrome.storage.local.get('identityFixture'),
  reviews: await globalThis.__identityFixture.reviews.listReviews()
}));
async function seed(worker) {
  return worker.evaluate(async () => {
    const {reviews, transfer} = globalThis.__identityFixture;
    const createdAt = new Date().toISOString();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBikAAAAASUVORK5CYII=';
    await chrome.storage.local.set({identityFixture: 'legacy settings stay in the legacy installation'});
    await reviews.putDraft({
      id: 'identity-draft', reviewId: 'identity-review', createdAt,
      context: {production: {url: 'https://example.test/review'}},
      evidence: {production: {dataUrl, width: 1, height: 1, capturedAt: createdAt}}
    }, {id: 'identity-review', title: 'Portable identity fixture', productionUrl: 'https://example.test/review', createdAt});
    await reviews.addComment('identity-draft', {comment: 'Preserve this saved observation and screenshot.', state: 'Migration fixture'});
    return transfer.createReviewBundle(await reviews.getReview('identity-review'));
  });
}

try {
  assert.ok(manifest.key, 'The distributed extension must contain its public key');
  const legacy = await copyFixture('legacy-installation', false);
  const first = await copyFixture('download-laptop-one');
  const second = await copyFixture('different-folder-laptop-two');
  let [legacyWorker] = await launch('migration-profile', [legacy]);
  const legacyId = idOf(legacyWorker);
  assert.notEqual(legacyId, stableId);
  const bundle = await seed(legacyWorker);
  await close();

  const workers = await launch('migration-profile', [legacy, first]);
  legacyWorker = workers.find(worker => idOf(worker) === legacyId);
  let stableWorker = workers.find(worker => idOf(worker) === stableId);
  assert.ok(legacyWorker && stableWorker);
  assert.equal((await saved(legacyWorker)).reviews.length, 1);
  assert.deepEqual(await saved(stableWorker), {local: {}, reviews: []});
  pass('Installing the keyed release separately retains the legacy installation and its saved review');
  const migrated = await stableWorker.evaluate(async bundle => {
    const {reviews} = globalThis.__identityFixture;
    const imported = await reviews.importReview(bundle);
    return reviews.getReview(imported.review.id);
  }, bundle);
  assert.equal(migrated.comments[0].fields.comment, bundle.review.comments[0].fields.comment);
  assert.deepEqual(migrated.comments[0].evidence, bundle.review.comments[0].evidence);
  assert.deepEqual((await saved(stableWorker)).local, {});
  pass('Review export/import preserves observation text and screenshot bytes without copying account settings');
  await close();

  stableWorker = (await launch('migration-profile', [legacy, second])).find(worker => idOf(worker) === stableId);
  assert.ok(stableWorker);
  assert.equal((await saved(stableWorker)).reviews[0].id, migrated.id);
  pass('A keyed release loaded from a second folder has the same ID and keeps the migrated review');
  await close();

  [stableWorker] = await launch('fresh-laptop-profile', [second]);
  assert.equal(idOf(stableWorker), stableId);
  assert.deepEqual(await saved(stableWorker), {local: {}, reviews: []});
  pass('A fresh Chrome profile uses the same distributed ID with independent local storage');
  await close();

  const unsafe = await copyFixture('unsafe-in-place-upgrade', false);
  [legacyWorker] = await launch('in-place-profile', [unsafe]);
  const unsafeOldId = idOf(legacyWorker);
  await seed(legacyWorker);
  await close();
  await writeFile(join(unsafe, 'manifest.json'), JSON.stringify(manifest));
  [stableWorker] = await launch('in-place-profile', [unsafe]);
  assert.equal(idOf(stableWorker), stableId);
  assert.notEqual(unsafeOldId, stableId);
  assert.deepEqual(await saved(stableWorker), {local: {}, reviews: []});
  pass('Adding a key in place changes the identity and cannot access legacy review/settings storage');
  await close();

  await mkdir(artifacts, {recursive: true});
  await writeFile(join(artifacts, 'verification.json'), JSON.stringify({
    browserVersion, version: manifest.version, stableId,
    fixture: 'Disposable Chrome profiles; synthetic review and 1px screenshot; no accounts or Jira writes',
    migration: 'Export reviews, install the keyed release separately while retaining the legacy copy, import reviews, configure accounts again',
    checks
  }, null, 2) + '\n');
} finally {
  if (context) await close();
  await rm(temp, {recursive: true, force: true});
}
