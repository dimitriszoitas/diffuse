import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAuthService } from '../backend/auth-service.mjs';
import { JiraOAuthError } from '../backend/jira-oauth.mjs';
import { createPostgresStore } from '../backend/store.mjs';
import { createTokenCipher, JiraAuthError, randomSecret, secretHash, verifierChallenge } from '../backend/security.mjs';

const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const KEY = Buffer.alloc(32, 71).toString('base64');
const SITE = { id: '1324a887-45db-1bf4-1e99-ef0ff456d421', name: 'Demo team', url: 'https://demo.atlassian.net' };
const PAIR = { accessToken: 'fixture-private-access', refreshToken: 'fixture-private-refresh', expiresIn: 3600, scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'] };
const USER = { accountId: 'account:example', displayName: 'Designer', active: true };
const clone = value => structuredClone(value);
const hasCode = code => error => error instanceof JiraAuthError && error.code === code && !String(error).includes('private');

// A transactional fake deliberately models row-lock serialization and rollback.
// Production must use the SQL adapter; this fake never leaves this test file.
function memoryStore() {
  const states = new Map();
  const connections = new Map();
  const handoffs = new Map();
  const locks = new Map();
  const stats = { refreshWrites: 0 };
  const store = {
    async putState(value) { states.set(value.stateHash, clone(value)); },
    async consumeState({ stateHash, now }) {
      const value = states.get(stateHash);
      if (!value || value.expiresAt <= now) return null;
      states.delete(stateHash);
      return clone(value);
    },
    async createConnectionWithHandoff({ connection, handoff }) {
      connections.set(connection.id, { ...clone(connection), credentialHash: null, pendingExpiresAt: handoff.expiresAt, updatedAt: connection.createdAt });
      handoffs.set(handoff.codeHash, { ...clone(handoff), connectionId: connection.id });
    },
    async completeHandoff({ codeHash, challenge, credentialHash, allowedExtensionIds, now }) {
      const handoff = handoffs.get(codeHash);
      if (!handoff || handoff.challenge !== challenge || handoff.expiresAt <= now) return null;
      const item = connections.get(handoff.connectionId);
      if (!item || item.credentialHash || item.pendingExpiresAt <= now || !allowedExtensionIds.includes(item.extensionId)) return null;
      handoffs.delete(codeHash);
      Object.assign(item, { credentialHash, pendingExpiresAt: null, updatedAt: now });
      return clone(item);
    },
    async getConnection(id) { return clone(connections.get(id) || null); },
    async deleteConnection({ id, credentialHash }) {
      if (connections.get(id)?.credentialHash !== credentialHash) return false;
      connections.delete(id);
      return true;
    },
    async withConnectionLock(id, action) {
      const previous = locks.get(id) || Promise.resolve();
      let release;
      const next = new Promise(resolve => { release = resolve; });
      locks.set(id, next);
      await previous;
      const before = clone(connections.get(id));
      try {
        return await action(clone(before || null), { async updateTokens({ tokensCiphertext, updatedAt }) {
          stats.refreshWrites++;
          Object.assign(connections.get(id), { tokensCiphertext, updatedAt });
        } });
      } catch (error) {
        if (before) connections.set(id, before);
        throw error;
      } finally {
        if (locks.get(id) === next) locks.delete(id);
        release();
      }
    }
  };
  return { store, states, connections, handoffs, stats };
}

function fixture(options = {}) {
  let time = 1_800_000_000_000;
  const data = memoryStore();
  const calls = [];
  const oauth = {
    authorizationUrl({ state }) { return `https://auth.atlassian.com/authorize?state=${state}`; },
    async exchangeCode(value) { calls.push(['exchange', value]); return clone(PAIR); },
    async discoverResources(value) { calls.push(['sites', value]); return [clone(SITE)]; },
    async getCurrentUser(value) { calls.push(['user', value]); return clone(USER); },
    async refreshTokens(value) { calls.push(['refresh', value]); return { ...clone(PAIR), accessToken: 'fixture-private-new-access', refreshToken: 'fixture-private-new-refresh' }; },
    ...options.oauth
  };
  const service = createAuthService({ store: data.store, oauth, cryptoKey: KEY, allowedExtensionIds: [EXTENSION], clock: () => time, ...options.service });
  async function begin(verifier = randomSecret()) {
    const { authorizationUrl } = await service.start({ challenge: verifierChallenge(verifier), extensionId: EXTENSION });
    const state = new URL(authorizationUrl).searchParams.get('state');
    return { state, verifier };
  }
  async function callback(started = null) {
    const step = started || await begin();
    const { redirectUrl } = await service.callback({ state: step.state, code: 'fixture-private-oauth-code' });
    return { ...step, redirectUrl, code: new URL(redirectUrl).searchParams.get('code') };
  }
  async function connected() {
    const { code, verifier } = await callback();
    return (await service.complete({ code, verifier })).connection;
  }
  return { ...data, service, oauth, calls, begin, callback, connected, advance: ms => { time += ms; }, now: () => time };
}

test('start binds an unpredictable hashed state to a verifier challenge and allowlisted extension', async () => {
  const app = fixture();
  const { state, verifier } = await app.begin();
  assert.deepEqual(app.states.get(secretHash(state)), {
    stateHash: secretHash(state), challenge: verifierChallenge(verifier), extensionId: EXTENSION, expiresAt: app.now() + 600_000
  });
  assert.ok(!JSON.stringify([...app.states.values()]).includes(state));
  assert.ok(!JSON.stringify([...app.states.values()]).includes(verifier));
  await assert.rejects(app.service.start({ challenge: verifierChallenge(verifier), extensionId: OTHER_EXTENSION }), hasCode('installation_not_allowed'));
  assert.equal(app.states.size, 1, 'Rejected installations must not create an OAuth state');
  for (const request of [undefined, {},
    { challenge: 'wrong', extensionId: EXTENSION }, { challenge: verifierChallenge(verifier), extensionId: `${EXTENSION}.evil.example` }]) {
    await assert.rejects(app.service.start(request), hasCode('invalid_request'));
  }
});

test('callback consumes state once, encrypts tokens and only returns a bound Chrome handoff', async () => {
  const app = fixture();
  const result = await app.callback();
  assert.equal(app.states.size, 0);
  assert.equal(new URL(result.redirectUrl).origin, `https://${EXTENSION}.chromiumapp.org`);
  assert.equal(new URL(result.redirectUrl).pathname, '/jira');
  assert.deepEqual([...new URL(result.redirectUrl).searchParams.keys()], ['code']);
  const item = [...app.connections.values()][0];
  const stored = JSON.stringify(item);
  for (const secret of [PAIR.accessToken, PAIR.refreshToken, result.state, result.code]) assert.ok(!stored.includes(secret));
  assert.equal(item.credentialHash, null);
  assert.equal(item.pendingExpiresAt, app.now() + 120_000);
  assert.equal(createTokenCipher(KEY).decrypt(item.id, item.tokensCiphertext).refreshToken, PAIR.refreshToken);
  await assert.rejects(app.service.callback({ state: result.state, code: 'again' }), hasCode('invalid_state'));
  assert.equal(app.calls.filter(([name]) => name === 'exchange').length, 1);
});

test('concurrent callbacks atomically claim a state only once', async () => {
  const app = fixture();
  const { state } = await app.begin();
  const results = await Promise.allSettled([
    app.service.callback({ state, code: 'first' }), app.service.callback({ state, code: 'second' })
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(app.connections.size, 1);
  assert.equal(app.calls.filter(([name]) => name === 'exchange').length, 1);
});

test('expired or malformed state never exchanges code, and denial consumes only a matching valid state', async () => {
  const app = fixture();
  const { state } = await app.begin();
  app.advance(600_000);
  await assert.rejects(app.service.callback({ state, code: 'private' }), hasCode('invalid_state'));
  await assert.rejects(app.service.callback({ state: `${state}&redirect=elsewhere`, code: 'private' }), hasCode('invalid_state'));
  const fresh = await app.begin();
  const denied = await app.service.callback({ state: fresh.state, error: 'private-provider-message&redirect=evil' });
  assert.equal(denied.redirectUrl, `https://${EXTENSION}.chromiumapp.org/jira?error=access_denied`);
  await assert.rejects(app.service.callback({ state: fresh.state, code: 'private' }), hasCode('invalid_state'));
  assert.equal(app.calls.length, 0);
});

test('handoff completion requires the original verifier, claims once, and exposes no provider tokens', async () => {
  const app = fixture();
  const { code, verifier } = await app.callback();
  await assert.rejects(app.service.complete({ code, verifier: randomSecret() }), hasCode('invalid_handoff'));
  assert.equal(app.handoffs.size, 1, 'An intercepted code cannot burn the real verifier-bound handoff');
  const { connection } = await app.service.complete({ code, verifier });
  assert.deepEqual(Object.keys(connection).sort(), ['accountId', 'credential', 'displayName', 'id', 'sites']);
  assert.equal(connection.accountId, USER.accountId);
  assert.deepEqual(connection.sites, [SITE]);
  assert.ok(!JSON.stringify(connection).includes('private'));
  const stored = app.connections.get(connection.id);
  assert.equal(stored.pendingExpiresAt, null);
  assert.ok(!JSON.stringify(stored).includes(connection.credential.split('.')[1]));
  await assert.rejects(app.service.complete({ code, verifier }), hasCode('invalid_handoff'));
  assert.equal(app.handoffs.size, 0);
  const profile = await app.service.authenticate(connection.credential);
  assert.deepEqual(profile, { id: connection.id, accountId: USER.accountId, displayName: USER.displayName, sites: [SITE] });
});

test('concurrent handoff completion returns exactly one credential', async () => {
  const app = fixture();
  const { code, verifier } = await app.callback();
  const results = await Promise.allSettled([
    app.service.complete({ code, verifier }), app.service.complete({ code, verifier })
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
});

test('expired handoffs and revoked extension allowlists cannot activate a connection', async () => {
  const app = fixture();
  const { code, verifier } = await app.callback();
  app.advance(120_000);
  await assert.rejects(app.service.complete({ code, verifier }), hasCode('invalid_handoff'));
  assert.equal([...app.connections.values()][0].credentialHash, null);
  const fresh = fixture();
  const pending = await fresh.callback();
  const revoked = createAuthService({ store: fresh.store, oauth: fresh.oauth, cryptoKey: KEY, allowedExtensionIds: ['p'.repeat(32)], clock: fresh.now });
  await assert.rejects(revoked.complete(pending), hasCode('invalid_handoff'));
  assert.equal([...fresh.connections.values()][0].credentialHash, null);
});

test('credentials cannot access another connection or act while the handoff is pending', async () => {
  const app = fixture();
  await app.callback();
  const pending = [...app.connections.values()][0];
  await assert.rejects(app.service.authenticate(`${pending.id}.${randomSecret()}`), hasCode('unauthorized'));
  const one = await app.connected();
  const two = await app.connected();
  const forged = `${one.id}.${two.credential.split('.')[1]}`;
  let called = false;
  await assert.rejects(app.service.authenticate(forged), hasCode('unauthorized'));
  await assert.rejects(app.service.disconnect(forged), hasCode('unauthorized'));
  await assert.rejects(app.service.withAccessToken(forged, () => { called = true; }), hasCode('unauthorized'));
  assert.equal(called, false);
  assert.equal((await app.service.authenticate(one.credential)).id, one.id);
});

test('fresh tokens are used without refresh and actions receive only the public connection context', async () => {
  const app = fixture();
  const connection = await app.connected();
  const result = await app.service.withAccessToken(connection.credential, async (token, internal) => {
    assert.equal(token, PAIR.accessToken);
    assert.deepEqual(Object.keys(internal).sort(), ['accountId', 'displayName', 'id', 'sites']);
    return { created: true };
  });
  assert.deepEqual(result, { created: true });
  assert.equal(app.calls.filter(([name]) => name === 'refresh').length, 0);
});

test('concurrent expiring-token requests serialize and atomically save a rotated pair before actions', async () => {
  const app = fixture();
  const connection = await app.connected();
  app.advance(3_550_000);
  const seen = [];
  const results = await Promise.all(Array.from({ length: 6 }, () => app.service.withAccessToken(connection.credential, token => {
    const persisted = createTokenCipher(KEY).decrypt(connection.id, app.connections.get(connection.id).tokensCiphertext);
    assert.equal(persisted.accessToken, token);
    assert.equal(persisted.refreshToken, 'fixture-private-new-refresh');
    seen.push(token);
    return 'done';
  })));
  assert.deepEqual(results, Array(6).fill('done'));
  assert.deepEqual(seen, Array(6).fill('fixture-private-new-access'));
  assert.equal(app.stats.refreshWrites, 1);
  assert.equal(app.calls.filter(([name]) => name === 'refresh').length, 1);
});

test('downstream API failures never roll back rotated tokens and remain available to the HTTP error boundary', async () => {
  const app = fixture();
  const connection = await app.connected();
  app.advance(3_550_000);
  const downstream = new Error('fixture downstream API error');
  await assert.rejects(app.service.withAccessToken(connection.credential, () => { throw downstream; }), error => error === downstream);
  assert.equal(await app.service.withAccessToken(connection.credential, token => token), 'fixture-private-new-access');
  assert.equal(app.stats.refreshWrites, 1);
  assert.equal(app.calls.filter(([name]) => name === 'refresh').length, 1);
});

test('refresh and storage failures do not invoke actions or expose provider/database details', async () => {
  const app = fixture({ oauth: { async refreshTokens() { throw new Error('private-refresh-secret in response'); } } });
  const connection = await app.connected();
  const before = app.connections.get(connection.id).tokensCiphertext;
  app.advance(3_550_000);
  let called = false;
  await assert.rejects(app.service.withAccessToken(connection.credential, () => { called = true; }), hasCode('unavailable'));
  assert.equal(called, false);
  assert.equal(app.connections.get(connection.id).tokensCiphertext, before);
  app.store.getConnection = async () => { throw new Error('private PostgreSQL connection string'); };
  await assert.rejects(app.service.authenticate(connection.credential), hasCode('unavailable'));
});

test('disconnect invalidates only the authenticated connection; independent account connections remain usable', async () => {
  const app = fixture();
  const first = await app.connected();
  app.oauth.getCurrentUser = async () => ({ ...USER, accountId: 'second-account', displayName: 'Other designer' });
  const second = await app.connected();
  assert.equal(second.accountId, 'second-account');
  assert.deepEqual(await app.service.disconnect(first.credential), { disconnected: true });
  await assert.rejects(app.service.authenticate(first.credential), hasCode('unauthorized'));
  await assert.rejects(app.service.withAccessToken(first.credential, () => assert.fail()), hasCode('unauthorized'));
  assert.equal((await app.service.authenticate(second.credential)).accountId, 'second-account');
});

test('unavailable sites, inactive users and provider failures close the auth window with a safe error', async () => {
  for (const [oauth, code] of [
    [{ async discoverResources() { return []; } }, 'no_sites'],
    [{ async getCurrentUser() { return { ...USER, active: false }; } }, 'access_denied'],
    [{ async discoverResources() { return [{ ...SITE, url: 'https://user:private@evil.example' }]; } }, 'invalid_response'],
    [{ async exchangeCode() { throw new Error('private-provider-text'); } }, 'unavailable']
  ]) {
    const app = fixture({ oauth });
    const { redirectUrl } = await app.callback();
    assert.equal(redirectUrl, `https://${EXTENSION}.chromiumapp.org/jira?error=${code}`);
    assert.equal(app.connections.size, 0);
    assert.equal(app.states.size, 0);
  }
});

test('callback error redirects use an explicit typed-code allowlist without reflecting provider text', async () => {
  const spoof = Object.assign(new Error('private-provider-body'), { code: 'no_sites' });
  const tamperedTyped = new JiraOAuthError('timeout');
  tamperedTyped.code = 'private-provider-body&redirect=evil';
  for (const [error, code] of [
    [new JiraOAuthError('timeout'), 'timeout'],
    [new JiraOAuthError('rate_limited'), 'rate_limited'],
    [new JiraOAuthError('insufficient_scope'), 'insufficient_scope'],
    [new JiraOAuthError('authorization_rejected'), 'authorization_rejected'],
    [new JiraOAuthError('invalid_configuration'), 'unavailable'],
    [spoof, 'unavailable'], [tamperedTyped, 'unavailable']
  ]) {
    const app = fixture({ oauth: { async exchangeCode() { throw error; } } });
    const { state } = await app.begin();
    const result = await app.service.callback({ state, code: 'private-oauth-code' });
    assert.equal(result.redirectUrl, `https://${EXTENSION}.chromiumapp.org/jira?error=${code}`);
    assert.equal(app.connections.size, 0);
    await assert.rejects(app.service.callback({ state, code: 'private-oauth-code' }), hasCode('invalid_state'));
  }
});

test('callback storage failures redirect only after a valid bound state was consumed', async () => {
  const app = fixture();
  const { state } = await app.begin();
  app.store.createConnectionWithHandoff = async () => { throw new Error('private-database-host'); };
  assert.deepEqual(await app.service.callback({ state, code: 'private-code' }), {
    redirectUrl: `https://${EXTENSION}.chromiumapp.org/jira?error=unavailable`
  });
  app.store.consumeState = async () => { throw new Error('private-database-host'); };
  // With no verified claim, the callback must not trust or redirect to caller input.
  await assert.rejects(app.service.callback({ state: randomSecret(), code: 'private-code' }), hasCode('unavailable'));
});

test('Postgres adapter uses parameterized atomic claims and never interpolates incoming state', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [{ challenge: 'challenge', extension_id: EXTENSION }] }; },
    async connect() { assert.fail('State claims use a single atomic SQL statement'); }
  };
  const store = createPostgresStore({ pool });
  const stateHash = "fixture' OR 1=1 --";
  await store.putState({ stateHash, challenge: 'challenge', extensionId: EXTENSION, expiresAt: 1800000000000 });
  assert.deepEqual(await store.consumeState({ stateHash, now: 1800000000000 }), { challenge: 'challenge', extensionId: EXTENSION });
  assert.match(calls[1].sql, /^DELETE FROM diffuse_jira_oauth_states/);
  assert.match(calls[1].sql, /state_hash = \$1 AND expires_at > \$2 RETURNING/);
  for (const call of calls) { assert.ok(!call.sql.includes(stateHash)); assert.equal(call.params[0], stateHash); }
});

test('Postgres adapter row lock protects updates until commit, rolls back failure and always releases client', async () => {
  const calls = [];
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    release() { calls.push({ sql: 'RELEASE' }); }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  await store.withConnectionLock('fixture-id', async (item, transaction) => {
    assert.equal(item, null);
    await transaction.updateTokens({ tokensCiphertext: 'encrypted-fixture', updatedAt: 1800000000000 });
    assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /WHERE id = \$1 FOR UPDATE$/);
  assert.deepEqual(calls.at(-2), { sql: 'COMMIT', params: undefined });
  assert.equal(calls.at(-1).sql, 'RELEASE');
  const expected = new Error('action failed');
  await assert.rejects(store.withConnectionLock('fixture-id', () => { throw expected; }), error => error === expected);
  assert.equal(calls.at(-2).sql, 'ROLLBACK');
  assert.equal(calls.at(-1).sql, 'RELEASE');
  assert.equal(client.listenerCount('error'), 0);
});

test('Postgres handoff activation matches the verifier and allowlist in the same transaction', async () => {
  const calls = [];
  const row = { id: 'fixture-id', account_id: USER.accountId, display_name: USER.displayName, sites: [SITE], extension_id: EXTENSION,
    tokens_ciphertext: 'encrypted', credential_hash: 'hash', created_at: new Date(1800000000000), updated_at: new Date(1800000000000), pending_expires_at: null };
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: sql.startsWith('DELETE FROM diffuse_jira_handoffs') ? [{ connection_id: row.id }] : sql.startsWith('UPDATE') ? [row] : [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  const result = await store.completeHandoff({ codeHash: 'code-hash', challenge: 'verifier-challenge', credentialHash: 'secret-hash', allowedExtensionIds: [EXTENSION], now: 1800000000000 });
  assert.equal(result.id, row.id);
  assert.match(calls[1].sql, /code_hash = \$1 AND challenge = \$2 AND expires_at > \$3/);
  assert.deepEqual(calls[1].params.slice(0, 2), ['code-hash', 'verifier-challenge']);
  assert.match(calls[2].sql, /extension_id = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(calls[2].params[3], [EXTENSION]);
  assert.equal(calls.at(-2).sql, 'COMMIT');
});

test('Postgres connection and handoff inserts roll back together if the handoff insert fails', async () => {
  const calls = [];
  const expected = new Error('fixture storage failure');
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO diffuse_jira_handoffs')) throw expected;
      return { rows: [] };
    },
    release(discard) { calls.push({ sql: 'RELEASE', discard }); }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  await assert.rejects(store.createConnectionWithHandoff({
    connection: { id: 'fixture-id', accountId: 'fixture-account', displayName: 'Demo', sites: [SITE], extensionId: EXTENSION,
      tokensCiphertext: 'encrypted-fixture', createdAt: 1800000000000 },
    handoff: { codeHash: 'hashed-code', challenge: 'challenge', expiresAt: 1800000120000 }
  }), error => error === expected);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /^INSERT INTO diffuse_jira_connections/);
  assert.match(calls[2].sql, /^INSERT INTO diffuse_jira_handoffs/);
  assert.equal(calls.at(-2).sql, 'ROLLBACK');
  assert.equal(calls.at(-1).discard, false);
  assert.ok(calls.every(call => call.sql !== 'COMMIT'));
});

test('Postgres discards a client whose failed transaction cannot be rolled back', async () => {
  let discarded;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql === 'ROLLBACK') throw new Error('connection no longer usable');
      return { rows: [] };
    },
    release(value) { discarded = value; }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  const original = new Error('original failure');
  await assert.rejects(store.withConnectionLock('fixture-id', () => { throw original; }), error => error === original);
  assert.equal(discarded, true);
});

test('Postgres handles a checked-out client error during an awaited refresh and never commits', async () => {
  const calls = [];
  let discarded;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release(value) { discarded = value; }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  await assert.rejects(store.withConnectionLock('fixture-id', async () => {
    assert.equal(client.listenerCount('error'), 1);
    await new Promise(resolve => setImmediate(() => {
      // Without the transaction listener, EventEmitter throws this exception.
      client.emit('error', new Error('private-database-connection-detail'));
      resolve();
    }));
    return 'must not be returned';
  }), hasCode('unavailable'));
  assert.ok(!calls.includes('COMMIT'));
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(discarded, true);
  assert.equal(client.listenerCount('error'), 0);
});

test('Postgres connection loss during COMMIT also fails safely and discards the client', async () => {
  let discarded;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql === 'COMMIT') this.emit('error', new Error('private-db-error'));
      return { rows: [] };
    },
    release(value) { discarded = value; }
  });
  const store = createPostgresStore({ pool: { query: client.query, async connect() { return client; } } });
  await assert.rejects(store.withConnectionLock('fixture-id', async () => 'done'), hasCode('unavailable'));
  assert.equal(discarded, true);
  assert.equal(client.listenerCount('error'), 0);
});
