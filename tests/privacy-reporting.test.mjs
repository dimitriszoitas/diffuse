import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createPrivacyReportingClient, createPrivacyReportingService, PrivacyReportingError, DEFAULT_PRIVACY_CYCLE_MS} from '../backend/privacy-reporting.mjs';
import {createPostgresPrivacyReportingStore} from '../backend/privacy-reporting-store.mjs';
import {createJiraOAuthClient, JiraOAuthError, JIRA_OAUTH_SCOPES} from '../backend/jira-oauth.mjs';
import {createTokenCipher} from '../backend/security.mjs';

const DAY = 86_400_000, INITIAL = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 63).toString('base64');
const TOKEN = 'private-fixture-access';
const account = (accountId = 'account:one', time = INITIAL - DAY) => ({accountId, updatedAt: new Date(time).toISOString()});
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', ...headers}});
const isCode = code => error => error instanceof PrivacyReportingError && error.code === code && !String(error).includes('private');

function fixture(options = {}) {
  let time = INITIAL, locked = false;
  const connections = new Map(), deliveries = new Map(), pending = new Map(), calls = [], events = [];
  let applyFailures = options.applyFailures || 0;
  const job = {notBefore: 0};
  const cipher = createTokenCipher(KEY);
  function add(accountId, {createdAt = time - DAY, expiresAt = time + DAY} = {}) {
    const id = randomUUID();
    connections.set(id, {id, accountId, displayName: 'Synthetic personal data', createdAt, updatedAt: createdAt,
      nextReportAt: 0, lastReportedAt: null, cycleMs: DEFAULT_PRIVACY_CYCLE_MS,
      tokensCiphertext: cipher.encrypt(id, {accessToken: TOKEN, refreshToken: 'private-fixture-refresh', expiresAt, scopes: [...JIRA_OAUTH_SCOPES]})});
    deliveries.set(id, {description: 'Private synthetic ticket text', chunks: ['private screenshot fixture']});
    return id;
  }
  const grouped = () => {
    const groups = new Map();
    for (const value of connections.values()) {
      const group = groups.get(value.accountId) || {accountId: value.accountId, oldestCollectedAt: value.createdAt, nextReportAt: 0, cycleMs: 0};
      group.oldestCollectedAt = Math.min(group.oldestCollectedAt, value.createdAt);
      group.nextReportAt = Math.max(group.nextReportAt, value.nextReportAt);
      group.cycleMs = Math.max(group.cycleMs, value.cycleMs);
      groups.set(value.accountId, group);
    }
    return [...groups.values()];
  };
  const erase = id => { const existed = connections.delete(id); deliveries.delete(id); return Number(existed); };
  const store = {
    async withSweepLock(action) { if (locked) return {acquired: false}; locked = true; try { return {acquired: true, value: await action()}; } finally { locked = false; } },
    async getJobState() { return structuredClone(job); },
    async startRun(now) { job.startedAt = now; },
    async listDueAccounts({now, limit}) { return grouped().filter(row => row.nextReportAt <= now && !pending.has(row.accountId)).sort((a,b) => a.nextReportAt - b.nextReportAt || a.accountId.localeCompare(b.accountId)).slice(0, limit); },
    async existingAccounts(ids) { return grouped().filter(row => ids.includes(row.accountId)); },
    async listAccountConnections(accountId) { return [...connections.values()].filter(row => row.accountId === accountId).map(row => row.id); },
    async eraseConnection(id) { events.push('erase-connection'); return erase(id); },
    async eraseAccounts(ids) { let count = 0; for (const row of [...connections.values()]) if (ids.includes(row.accountId)) count += erase(row.id); return count; },
    async reserveAccounts({accountIds, now}) {
      events.push('reserve');
      const groups = grouped();
      for (const row of connections.values()) if (accountIds.includes(row.accountId)) {
        row.lastAttemptAt = now; row.nextReportAt = now + groups.find(group => group.accountId === row.accountId).cycleMs;
      }
    },
    async stageReportResult({accountIds, eraseAccountIds, now, cycleMs}) {
      events.push('stage-response');
      for(const accountId of accountIds) pending.set(accountId,{accountId,now,cycleMs,erase:eraseAccountIds.includes(accountId)});
    },
    async applyPendingReports({limit}) {
      const batch=[...pending.values()].slice(0,limit);
      if(batch.length && applyFailures>0){applyFailures--;throw new Error('Synthetic database deletion failure');}
      let erasedConnections=0,erasedAccounts=0;
      for(const result of batch){
        if(result.erase){erasedAccounts++;erasedConnections+=await store.eraseAccounts([result.accountId]);}
        else for (const row of connections.values()) if (result.accountId===row.accountId) {
          row.lastReportedAt = result.now; row.nextReportAt = result.now + result.cycleMs; row.cycleMs = result.cycleMs;
        }
        pending.delete(result.accountId);job.lastSuccessAt=result.now;
      }
      return {applied:batch.length,erasedAccounts,erasedConnections};
    },
    async recordFailure({accountIds, now, errorCode, retryAfterMs}) {
      job.lastError = errorCode;
      if (retryAfterMs != null) {
        job.notBefore = Math.max(job.notBefore, now + retryAfterMs);
        for (const row of connections.values()) if (accountIds.includes(row.accountId)) row.nextReportAt = now + retryAfterMs;
      }
    },
    async finishRun({now, status, counts}) { Object.assign(job, {finishedAt: now, status, counts: structuredClone(counts)}); }
  };
  const connectionStore = {
    async cleanupExpired() {},
    async withConnectionLock(id, action) {
      const result = await action(structuredClone(connections.get(id)), {async updateTokens(values) { Object.assign(connections.get(id), values); events.push('persist-refresh'); }});
      events.push('commit-refresh'); return result;
    }
  };
  const oauth = {async refreshTokens() { return {accessToken: 'rotated-private-token', refreshToken: 'rotated-private-refresh', expiresIn: 3600, scopes: [...JIRA_OAUTH_SCOPES]}; }, ...options.oauth};
  const client = options.client || {async report(input) {
    calls.push(structuredClone(input)); events.push('report');
    return {eraseAccountIds: options.erase || [], cycleMs: options.cycleMs || DEFAULT_PRIVACY_CYCLE_MS};
  }};
  const service = createPrivacyReportingService({store, connectionStore, oauth, client, cryptoKey: KEY, clock: () => time});
  return {service, store, connectionStore, connections, deliveries, pending, calls, events, job, add, cipher, oauth, setTime(value) {time = value;}, now: () => time};
}

test('3LO reporting uses fixed endpoint, bearer, oldest date, bounded accounts and no other metadata', async () => {
  const calls = [];
  const client = createPrivacyReportingClient({fetchImpl: async (url, init) => { calls.push({url, init}); return new Response(null, {status: 204}); }});
  assert.deepEqual(await client.report({accessToken: TOKEN, accounts: [{...account(), displayName: 'not transmitted'}]}), {eraseAccountIds: [], cycleMs: 7 * DAY});
  assert.equal(calls[0].url, 'https://api.atlassian.com/app/report-accounts/');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {accounts: [account()]});
  assert.equal(calls[0].init.redirect, 'error');
  for (const accounts of [[], Array.from({length: 91}, (_, i) => account(`account:${i}`)), [account('unknown')], [account(), account()], [account('x'.repeat(129))]]) {
    await assert.rejects(client.report({accessToken: TOKEN, accounts}), isCode('invalid_configuration'));
  }
  assert.equal(calls.length, 1);
});

test('200 accepts only unique closed/updated accounts from the submitted batch; Cycle-Period is days', async () => {
  const client = createPrivacyReportingClient({fetchImpl: async () => json({accounts: [{accountId:'account:one', status:'closed'}, {accountId:'account:two', status:'updated'}]}, 200, {'Cycle-Period': '14'})});
  assert.deepEqual(await client.report({accessToken: TOKEN, accounts: [account(), account('account:two')]}), {eraseAccountIds:['account:one','account:two'], cycleMs: 14 * DAY});
  for (const response of [
    {accounts: [{accountId: 'someone-else', status: 'closed'}]},
    {accounts: [{accountId: 'account:one', status: 'active'}]},
    {accounts: [{accountId: 'account:one', status: 'closed'}, {accountId: 'account:one', status: 'updated'}]},
    {accounts: 'private diagnostic'}
  ]) {
    const bad = createPrivacyReportingClient({fetchImpl: async () => json(response)});
    await assert.rejects(bad.report({accessToken: TOKEN, accounts: [account()]}), isCode('invalid_response'));
  }
});

test('provider failures are redacted, and 429 honors both seconds and HTTP-date retry headers', async () => {
  for (const status of [401,403,400,500,503]) {
    const client = createPrivacyReportingClient({fetchImpl: async () => json({error: `private ${TOKEN}`}, status)});
    await assert.rejects(client.report({accessToken: TOKEN, accounts: [account()]}), isCode([401,403].includes(status) ? 'authorization_failed' : status === 400 ? 'rejected' : 'unavailable'));
  }
  for (const value of ['3600', new Date(INITIAL + 3600_000).toUTCString()]) {
    const client = createPrivacyReportingClient({clock: () => INITIAL, fetchImpl: async () => new Response(null, {status:429, headers:{'Retry-After':value}})});
    await assert.rejects(client.report({accessToken:TOKEN, accounts:[account()]}), error => isCode('rate_limited')(error) && error.retryAfterMs === 3600_000);
  }
});

test('malformed cycles, redirects, oversized bodies and unresponsive fetch never produce a successful report', async () => {
  for (const value of ['0', '-1', 'a week', '999999999999']) {
    const client = createPrivacyReportingClient({fetchImpl: async () => new Response(null, {status:204, headers:{'Cycle-Period':value}})});
    await assert.rejects(client.report({accessToken:TOKEN, accounts:[account()]}), isCode('invalid_response'));
  }
  const redirected = createPrivacyReportingClient({fetchImpl: async () => ({redirected:true, status:200})});
  await assert.rejects(redirected.report({accessToken:TOKEN, accounts:[account()]}), isCode('invalid_response'));
  const oversized = createPrivacyReportingClient({fetchImpl: async () => json({accounts: [], padding: 'x'.repeat(70_000)})});
  await assert.rejects(oversized.report({accessToken:TOKEN, accounts:[account()]}), isCode('invalid_response'));
  const timeout = createPrivacyReportingClient({timeoutMs:10, fetchImpl: async () => new Promise(() => {})});
  await assert.rejects(timeout.report({accessToken:TOKEN, accounts:[account()]}), isCode('timeout'));
});

test('accounts are grouped once using oldest collection, persisted due times survive runs and new connections', async () => {
  const app = fixture({cycleMs: 14 * DAY});
  app.add('account:one', {createdAt: INITIAL - 5 * DAY});
  app.add('account:one', {createdAt: INITIAL - DAY});
  assert.equal((await app.service.run()).reported, 1);
  assert.deepEqual(app.calls[0].accounts, [account('account:one', INITIAL - 5 * DAY)]);
  assert.ok(app.events.indexOf('reserve') < app.events.indexOf('report'));
  assert.ok([...app.connections.values()].every(row => row.lastReportedAt === INITIAL && row.nextReportAt === INITIAL + 14 * DAY));
  app.add('account:one');
  app.setTime(INITIAL + 7 * DAY);
  assert.equal((await app.service.run()).status, 'idle');
  assert.equal(app.calls.length, 1);
  app.setTime(INITIAL + 14 * DAY);
  assert.equal((await app.service.run()).reported, 1);
  assert.equal(app.calls.length, 2);
});

test('closed and updated erase all associated connections and delivery data while preserving other accounts', async () => {
  const app = fixture({erase:['account:closed','account:updated']});
  const closed = app.add('account:closed'), alsoClosed = app.add('account:closed'), updated = app.add('account:updated'), active = app.add('account:active');
  const result = await app.service.run();
  assert.equal(result.reported, 3); assert.equal(result.erasedAccounts, 2); assert.equal(result.erasedConnections, 3);
  assert.deepEqual([...app.connections.keys()], [active]);
  for (const id of [closed, alsoClosed, updated]) assert.ok(!app.deliveries.has(id));
  assert.ok(app.deliveries.has(active));
  assert.doesNotMatch(JSON.stringify(result), /account:|private|displayName|accessToken/);
});

test('sweeps resume bounded batches, never send more than 90 and do not overlap', async () => {
  const app = fixture();
  for (let i = 0; i < 181; i++) app.add(`account:${String(i).padStart(3,'0')}`);
  const [first, overlap] = await Promise.all([app.service.run({maxAccounts: 91}), app.service.run()]);
  assert.equal(first.reported, 91); assert.equal(overlap.status, 'busy');
  assert.deepEqual(app.calls.map(call => call.accounts.length), [90,1]);
  assert.equal((await app.service.run()).reported, 90);
  assert.equal((await app.service.run()).status, 'idle');
});

test('refreshes are persisted and committed before reporting; invalid_grant erases only unusable connection', async () => {
  const app = fixture();
  const id = app.add('account:one', {expiresAt: INITIAL});
  assert.equal((await app.service.run()).reported, 1);
  assert.ok(app.events.indexOf('persist-refresh') < app.events.indexOf('commit-refresh'));
  assert.ok(app.events.indexOf('commit-refresh') < app.events.indexOf('report'));
  assert.equal(app.calls[0].accessToken, 'rotated-private-token');
  assert.equal(app.cipher.decrypt(id, app.connections.get(id).tokensCiphertext).refreshToken, 'rotated-private-refresh');

  const revoked = fixture({oauth:{async refreshTokens() { throw new JiraOAuthError('grant_revoked'); }}});
  const invalid = revoked.add('account:one', {expiresAt:INITIAL});
  const valid = revoked.add('account:one');
  const result = await revoked.service.run();
  assert.equal(result.erasedConnections, 1); assert.equal(result.reported, 1);
  assert.ok(!revoked.connections.has(invalid)); assert.ok(!revoked.deliveries.has(invalid)); assert.ok(revoked.connections.has(valid));
});

test('reporting 403 and refresh/network uncertainty preserve connection data and never claim success', async () => {
  const denied = fixture({client:createPrivacyReportingClient({fetchImpl:async () => json({error:'private'},403)})});
  denied.add('account:one');
  const result = await denied.service.run();
  assert.equal(result.status,'failed'); assert.equal(result.reported,0); assert.equal(result.failed,1);
  assert.deepEqual(result.errors,['authorization_failed']);
  assert.equal(denied.connections.size,1); assert.equal(denied.deliveries.size,1);
  assert.equal([...denied.connections.values()][0].lastReportedAt,null);
  assert.equal((await denied.service.run()).status,'deferred');
  assert.equal(denied.job.notBefore,INITIAL+3600_000);
  denied.setTime(INITIAL+3600_000);
  assert.equal((await denied.service.run()).status,'failed', 'Explicit rejection can retry after an hour');
  for (const error of [new Error('private network failure'), new JiraOAuthError('access_denied'), new JiraOAuthError('authorization_rejected')]) {
    const app = fixture({oauth:{async refreshTokens(){throw error;}}});
    app.add('account:one',{expiresAt:INITIAL});
    assert.equal((await app.service.run()).status,'failed');
    assert.equal(app.connections.size,1); assert.equal(app.deliveries.size,1); assert.equal(app.calls.length,0);
  }
});

test('uncertain network report outcomes keep durable cycle reservation without erasing data or recording success', async () => {
  const app = fixture({client:{async report(){throw new Error('private network response was lost');}}});
  app.add('account:one');
  const result = await app.service.run();
  assert.equal(result.status,'failed'); assert.equal(result.reported,0);
  const row = [...app.connections.values()][0];
  assert.equal(row.lastReportedAt,null);assert.equal(row.nextReportAt,INITIAL+DEFAULT_PRIVACY_CYCLE_MS);
  app.setTime(INITIAL+3600_000);
  assert.equal((await app.service.run()).status,'idle');assert.equal(app.connections.size,1);assert.equal(app.deliveries.size,1);
});

test('a saved erasure response survives failed deletion and is applied next sweep without another report', async () => {
  const app=fixture({erase:['account:one'],applyFailures:1});
  app.add('account:one');
  const first=await app.service.run();
  assert.equal(first.status,'failed');assert.equal(first.reported,1);assert.deepEqual(first.errors,['persistence_failed']);
  assert.equal(app.pending.size,1);assert.equal(app.connections.size,1);assert.equal(app.deliveries.size,1);
  assert.equal(app.calls.length,1);
  const next=await app.service.run();
  assert.equal(next.recovered,1);assert.equal(next.erasedAccounts,1);assert.equal(next.erasedConnections,1);
  assert.equal(app.pending.size,0);assert.equal(app.connections.size,0);assert.equal(app.deliveries.size,0);
  assert.equal(app.calls.length,1,'Applying a pending response must not make a second provider request');
});

test('soft work budget stops before a refresh/report when finalization headroom is unavailable', async () => {
  const app=fixture();app.add('account:one',{expiresAt:INITIAL});
  const result=await app.service.run({maxRunMs:30_000});
  assert.equal(result.status,'partial');assert.equal(app.calls.length,0);assert.ok(!app.events.includes('persist-refresh'));
  assert.equal([...app.connections.values()][0].nextReportAt,0);
});

test('429 persists Retry-After globally across new accounts, then resumes the rejected batch', async () => {
  let requests = 0;
  const client = createPrivacyReportingClient({clock:()=>INITIAL, fetchImpl:async()=> ++requests === 1 ? new Response(null,{status:429,headers:{'Retry-After':'3600'}}) : new Response(null,{status:204})});
  const app = fixture({client}); app.add('account:one');
  assert.equal((await app.service.run()).status,'failed');
  assert.equal(app.job.notBefore,INITIAL+3600_000);
  app.add('account:two'); app.setTime(INITIAL+1800_000);
  assert.equal((await app.service.run()).status,'deferred'); assert.equal(requests,1);
  app.setTime(INITIAL+3600_000);
  assert.equal((await app.service.run()).reported,2); assert.equal(requests,2);
});

test('unknown and malformed stored account identifiers are erased, never reported', async () => {
  const app = fixture(); app.add('unknown'); app.add('x'.repeat(129)); app.add('account:valid');
  const result = await app.service.run();
  assert.equal(result.erasedAccounts,2); assert.equal(result.reported,1);
  assert.deepEqual(app.calls[0].accounts.map(value=>value.accountId),['account:valid']);
});

test('an injected malformed reporting result cannot erase an unreported account', async () => {
  const app = fixture({client:{async report(){return {eraseAccountIds:['foreign'],cycleMs:DAY};}}});
  app.add('account:one');
  assert.equal((await app.service.run()).status,'failed'); assert.equal(app.connections.size,1);
});

test('OAuth identifies revoked refresh grants only from the explicit bounded invalid_grant response', async () => {
  const config = {clientId:'fixture',clientSecret:'private-client-secret',publicOrigin:'https://example.test'};
  for (const [detail, code] of [[{error:'invalid_grant'},'grant_revoked'],[{error:'invalid_client'},'authorization_rejected'],[{error_description:'private token'},'authorization_rejected']]) {
    const oauth = createJiraOAuthClient({...config,fetchImpl:async()=>json(detail,400)});
    await assert.rejects(oauth.refreshTokens({refreshToken:'private-refresh',grantedScopes:JIRA_OAUTH_SCOPES}),error=>error instanceof JiraOAuthError && error.code===code && !String(error).includes('private'));
  }
  const oauth = createJiraOAuthClient({...config,fetchImpl:async()=>json({error:'invalid_grant'},400)});
  await assert.rejects(oauth.exchangeCode({code:'authorization-code'}),error=>error.code==='authorization_rejected');
});

test('Postgres sweep locks use one dedicated transaction and release safely on success, contention and failure', async () => {
  for (const kind of ['success','busy','failure']) {
    const calls=[];const client=new EventEmitter();
    client.query=async sql=>{calls.push(sql);return {rows:[{acquired:kind!=='busy'}]};};
    client.release=discard=>calls.push(['release',discard]);
    const store=createPostgresPrivacyReportingStore({pool:{query:async()=>({rows:[]}),connect:async()=>client}});
    const operation=()=>store.withSweepLock(async()=>{calls.push('work');if(kind==='failure')throw new Error('fixture failure');return 1;});
    if(kind==='failure')await assert.rejects(operation());else assert.equal((await operation()).acquired,kind!=='busy');
    assert.equal(calls[0],'BEGIN');assert.match(calls[1],/pg_try_advisory_xact_lock/);
    assert.equal(calls.at(-2),kind==='success'?'COMMIT':'ROLLBACK');
    assert.deepEqual(calls.at(-1),['release',false]);
    assert.equal(client.listenerCount('error'),0);
  }
});

test('Postgres saves response separately and erases account connections with queue removal in one transaction', async () => {
  const calls=[];const client=new EventEmitter();
  client.query=async(sql,values)=>{calls.push({sql,values});return {rows:sql.includes('FOR UPDATE SKIP LOCKED')?[{account_id:'account:one',reported_at:new Date(INITIAL),cycle_ms:DAY,erase:false},{account_id:'account:two',reported_at:new Date(INITIAL),cycle_ms:DAY,erase:true}]:[],rowCount:2};};client.release=()=>{};
  const store=createPostgresPrivacyReportingStore({pool:{query:client.query,connect:async()=>client}});
  await store.stageReportResult({accountIds:['account:one','account:two'],eraseAccountIds:['account:two'],now:INITIAL,cycleMs:DAY});
  assert.match(calls[0].sql,/INSERT INTO diffuse_jira_privacy_pending/);
  assert.deepEqual(await store.applyPendingReports({limit:90}),{applied:2,erasedAccounts:1,erasedConnections:2});
  assert.equal(calls[1].sql,'BEGIN');assert.equal(calls.at(-1).sql,'COMMIT');
  const erased=calls.find(call=>call.sql.startsWith('DELETE'));assert.deepEqual(erased.values,[['account:two']]);assert.ok(!erased.sql.includes('account:two'));
  const updated=calls.find(call=>call.sql.includes('privacy_last_reported_at'));assert.deepEqual(updated.values,[['account:one','account:two']]);
  assert.ok(calls.findIndex(call=>call.sql.startsWith('DELETE FROM diffuse_jira_privacy_pending'))>calls.indexOf(erased));
  const schema=await readFile(new URL('../backend/delivery-schema.sql',import.meta.url),'utf8');
  assert.match(schema,/REFERENCES diffuse_jira_connections\(id\) ON DELETE CASCADE/);
  assert.match(schema,/REFERENCES diffuse_jira_deliveries\(id\) ON DELETE CASCADE/);
});
