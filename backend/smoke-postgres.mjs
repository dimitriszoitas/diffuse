/** Real PostgreSQL smoke, fake providers only. Creates and removes its own rows.
 * Run explicitly: node backend/smoke-postgres.mjs
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createDatabasePool} from './database.mjs';
import {createPostgresStore} from './store.mjs';
import {createAuthService} from './auth-service.mjs';
import {createPostgresDeliveryStore} from './delivery-store.mjs';
import {createDeliveryService, DELIVERY_LIMITS} from './delivery-service.mjs';
import {randomSecret, verifierChallenge} from './security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const cloudId = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const syntheticStates = new Set(), syntheticConnections = new Set();
let pool, phase = 'configuration', success = false;
globalThis.fetch = async () => { throw new Error('Provider calls are disabled in this smoke test.'); };

try {
  if (!process.env.DATABASE_URL) process.loadEnvFile(fileURLToPath(new URL('.env.production.local', import.meta.url)));
  pool = createDatabasePool(process.env.DATABASE_URL);
  phase = 'migrations';
  for (const name of ['schema.sql', 'rate-schema.sql', 'delivery-schema.sql']) {
    await pool.query(await readFile(new URL(name, import.meta.url), 'utf8'));
  }
  const rawStore = createPostgresStore({pool});
  const store = {...rawStore,
    async putState(value) { syntheticStates.add(value.stateHash); return rawStore.putState(value); },
    async createConnectionWithHandoff(value) { syntheticConnections.add(value.connection.id); return rawStore.createConnectionWithHandoff(value); }
  };
  let now = Date.now(), refreshCalls = 0;
  const tokenPair = {accessToken: 'smoke-access-fixture', refreshToken: 'smoke-refresh-fixture', expiresIn: 60,
    scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access']};
  const oauth = {
    authorizationUrl: ({state}) => `https://provider.invalid/authorize?state=${state}`,
    async exchangeCode() { return tokenPair; },
    async discoverResources() { return [{id: cloudId, name: 'Synthetic smoke site', url: 'https://smoke.atlassian.net'}]; },
    async getCurrentUser() { return {accountId: `smoke:${randomUUID()}`, displayName: 'Synthetic smoke identity', active: true}; },
    async refreshTokens() { refreshCalls++; return {...tokenPair, accessToken: 'smoke-rotated-access', refreshToken: 'smoke-rotated-refresh', expiresIn: 3600}; }
  };
  const auth = createAuthService({store, oauth, cryptoKey: randomBytes(32).toString('base64'), allowedExtensionIds: [extensionId], clock: () => now});
  phase = 'OAuth handoff and authentication';
  const verifier = randomSecret();
  const started = await auth.start({challenge: verifierChallenge(verifier), extensionId});
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const callback = await auth.callback({state, code: 'synthetic-oauth-code'});
  const code = new URL(callback.redirectUrl).searchParams.get('code');
  assert.ok(code);
  const {connection} = await auth.complete({code, verifier});
  await assert.rejects(auth.complete({code, verifier}), error => error.code === 'invalid_handoff');
  assert.equal((await auth.authenticate(connection.credential)).id, connection.id);
  await assert.rejects(auth.authenticate(`${connection.id}.${randomSecret()}`), error => error.code === 'unauthorized');
  phase = 'concurrent rotating-token persistence';
  now += 2000;
  const tokens = await Promise.all(Array.from({length: 4}, () => auth.withAccessToken(connection.credential, token => token)));
  assert.deepEqual(tokens, Array(4).fill('smoke-rotated-access'));
  assert.equal(refreshCalls, 1);

  phase = 'delivery preparation with an ADF textarea';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5DkAAAAASUVORK5CYII=', 'base64');
  const webm = Buffer.concat([Buffer.from([26,69,223,163,0x42,0x82,0x84,0x77,0x65,0x62,0x6d,0]), Buffer.alloc(DELIVERY_LIMITS.chunkBytes, 0)]);
  const files = [{filename: 'synthetic.png', mimeType: 'image/png', bytes: png}, {filename: 'synthetic.webm', mimeType: 'video/webm', bytes: webm}];
  const page = values => ({values, startAt: 0, isLast: true, nextStartAt: null});
  let creates = 0, uploads = 0;
  const richText = {type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: 'Required explanatory text.'}]}]};
  const jira = {
    async listProjects() { return page([{id: '10001'}]); },
    async listIssueTypes() { return page([{id: '10002'}]); },
    async getCreateFields() { return page([{fieldId: 'summary', required: true},
      {fieldId: 'customfield_10001', required: true, operations: ['set'], schema: {type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'}}]); },
    async attachmentSettings() { return {enabled: true, uploadLimit: DELIVERY_LIMITS.attachmentBytes}; },
    async createIssue(input) {
      assert.deepEqual(input.fields.customfield_10001, richText);
      creates++; await new Promise(resolve => setTimeout(resolve, 75));
      return {id: '20001', key: 'SMOKE-1'};
    },
    async uploadAttachment(input) {
      assert.equal(input.issueId, '20001');
      assert.deepEqual(input.bytes, files.find(file => file.filename === input.filename).bytes);
      uploads++; await new Promise(resolve => setTimeout(resolve, 75));
      return {id: String(30000 + uploads), filename: input.filename, mimeType: input.mimeType, size: input.bytes.length};
    }
  };
  const deliveryStore = createPostgresDeliveryStore({pool});
  const delivery = createDeliveryService({store: deliveryStore, jira, oauth, clock: () => now});
  const context = {connection, accessToken: tokens[0]};
  const request = {clientDeliveryId: randomUUID(), commentId: randomUUID(), revision: hash(randomSecret()), cloudId,
    projectId: '10001', issueTypeId: '10002', summary: 'Synthetic SQL smoke only', description: richText,
    fields: {customfield_10001: richText}, attachments: files.map(file => ({id: randomUUID(), filename: file.filename, mimeType: file.mimeType, size: file.bytes.length, sha256: hash(file.bytes)}))};
  const prepared = await Promise.all(Array.from({length: 3}, () => delivery.prepare({...context, request: {...request, clientDeliveryId: randomUUID()}})));
  assert.equal(new Set(prepared.map(item => item.id)).size, 1);
  const id = prepared[0].id;
  await assert.rejects(delivery.get({connection: {id: randomUUID()}, id}), error => error.code === 'not_found');
  phase = 'chunk persistence';
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const attachment = request.attachments[fileIndex], bytes = files[fileIndex].bytes;
    for (let index = 0; index < Math.ceil(bytes.length / DELIVERY_LIMITS.chunkBytes); index++) {
      const input = {connection, id, attachmentId: attachment.id, index,
        dataBase64: bytes.subarray(index * DELIVERY_LIMITS.chunkBytes, (index + 1) * DELIVERY_LIMITS.chunkBytes).toString('base64')};
      await delivery.putChunk(input); await delivery.putChunk(input);
    }
  }
  assert.equal((await delivery.get({connection, id})).canSendIssue, true);
  phase = 'concurrent issue claim and receipt';
  await Promise.all(Array.from({length: 3}, () => delivery.sendIssue({...context, id})));
  assert.equal(creates, 1);
  assert.equal((await delivery.get({connection, id})).issue.key, 'SMOKE-1');
  phase = 'concurrent attachment claims and persisted completion';
  for (const attachment of request.attachments) {
    await Promise.all(Array.from({length: 3}, () => delivery.sendAttachment({...context, id, attachmentId: attachment.id})));
  }
  assert.equal(uploads, 2);
  assert.equal((await delivery.get({connection, id})).status, 'complete');
  assert.equal((await delivery.sendIssue({...context, id})).status, 'complete');
  assert.equal(creates, 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM diffuse_jira_delivery_chunks WHERE delivery_id = $1', [id])).rows[0].count), 0);
  phase = 'disconnect cascade';
  await auth.disconnect(connection.credential);
  assert.equal(await rawStore.getConnection(connection.id), null);
  assert.equal(await deliveryStore.get({connectionId: connection.id, id}), null);
  success = true;
} catch {
  console.error(`Postgres smoke failed during ${phase}. No provider calls or credentials were logged.`);
  process.exitCode = 1;
} finally {
  try {
    if (pool) {
      if (syntheticConnections.size) await pool.query('DELETE FROM diffuse_jira_connections WHERE id = ANY($1::uuid[])', [[...syntheticConnections]]);
      if (syntheticStates.size) await pool.query('DELETE FROM diffuse_jira_oauth_states WHERE state_hash = ANY($1::text[])', [[...syntheticStates]]);
      const remaining = await pool.query('SELECT count(*) FROM diffuse_jira_connections WHERE id = ANY($1::uuid[])', [[...syntheticConnections]]);
      assert.equal(Number(remaining.rows[0].count), 0);
    }
  } catch {
    success = false; process.exitCode = 1;
    console.error('Synthetic smoke cleanup could not be verified. No credentials were logged.');
  } finally { await pool?.end(); }
}
if (success) console.log('Postgres smoke passed: OAuth/handoff, concurrent refresh, ADF textarea, deduplication, chunks, concurrent issue/attachment claims, receipts, cascade and synthetic-row cleanup. No real provider calls.');
