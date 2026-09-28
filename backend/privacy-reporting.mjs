import {createTokenCipher} from './security.mjs';
import {JiraOAuthError, JIRA_OAUTH_SCOPES} from './jira-oauth.mjs';

const ENDPOINT = 'https://api.atlassian.com/app/report-accounts/';
const DAY = 86_400_000;
export const DEFAULT_PRIVACY_CYCLE_MS = 7 * DAY;
const MAX_INTERVAL_MS = 36_500 * DAY;
const ACCOUNT = /^[A-Za-z0-9:-]{1,128}$/;
const BEARER = /^[A-Za-z0-9._~+\/-]+=*$/;
const messages = Object.freeze({
  invalid_configuration: 'Privacy reporting is not configured.',
  invalid_response: 'Atlassian returned an invalid privacy-reporting response.',
  authorization_failed: 'Atlassian did not authorize the privacy report.',
  rejected: 'Atlassian rejected the privacy report.',
  rate_limited: 'Atlassian deferred privacy reporting.',
  unavailable: 'Privacy reporting could not complete.',
  timeout: 'Privacy reporting timed out.',
  persistence_failed: 'A privacy reporting result could not be applied to stored data.',
  no_usable_connection: 'Privacy reporting has no usable account connection.'
});
export class PrivacyReportingError extends Error {
  constructor(code, {retryAfterMs} = {}) {
    const safe = Object.hasOwn(messages, code) ? code : 'unavailable';
    super(messages[safe]); this.name = 'PrivacyReportingError'; this.code = safe;
    if (safe === 'rate_limited' && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0) this.retryAfterMs = retryAfterMs;
  }
}
const fail = code => { throw new PrivacyReportingError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validAccount = value => typeof value === 'string' && ACCOUNT.test(value) && value !== 'unknown';
const safeError = error => error instanceof PrivacyReportingError ? error : new PrivacyReportingError('unavailable');
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail('invalid_response');
  return value;
}
function cyclePeriod(value) {
  if (value === null) return DEFAULT_PRIVACY_CYCLE_MS;
  // Atlassian's Cycle-Period is a number of DAYS; Retry-After is seconds.
  // https://community.developer.atlassian.com/t/cycle-period-header-example/26940/2
  if (!/^\d+(?:\.\d+)?$/.test(value)) fail('invalid_response');
  const result = Math.ceil(Number(value) * DAY);
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_INTERVAL_MS) fail('invalid_response');
  return result;
}
function retryAfter(value, now) {
  let result = /^\d+(?:\.\d+)?$/.test(value || '') ? Math.ceil(Number(value) * 1000) : Date.parse(value || '') - now;
  if (!Number.isFinite(result) || result < 0) result = 60_000;
  // Never retry before the provider's date, even if the next cron runs earlier.
  if (result > MAX_INTERVAL_MS) fail('invalid_response');
  return Math.max(1000, result);
}
async function boundedJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body?.getReader) fail('invalid_response');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) fail('invalid_response');
  const reader = response.body.getReader(); let size = 0, text = '';
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength; if (size > 65_536) fail('invalid_response');
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { fail('invalid_response'); }
  finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

export function createPrivacyReportingClient({fetchImpl = globalThis.fetch, timeoutMs = 15_000, clock = Date.now} = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid_configuration');
  return Object.freeze({
    async report({accessToken, accounts, timeoutMs: budget = timeoutMs}) {
      if (typeof accessToken !== 'string' || !BEARER.test(accessToken) || accessToken.length > 16_384 ||
          !Array.isArray(accounts) || !accounts.length || accounts.length > 90 ||
          !Number.isInteger(budget) || budget < 1 || budget > timeoutMs) fail('invalid_configuration');
      const ids = new Set();
      for (const item of accounts) {
        if (!plain(item) || !validAccount(item.accountId) || ids.has(item.accountId) ||
            typeof item.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.updatedAt) ||
            !Number.isFinite(Date.parse(item.updatedAt))) fail('invalid_configuration');
        ids.add(item.accountId);
      }
      const controller = new AbortController(); let timer;
      try {
        return await Promise.race([new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new PrivacyReportingError('timeout')); }, budget);
        }), (async () => {
          const response = await fetchImpl(ENDPOINT, {
            method: 'POST', headers: {Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`},
            body: JSON.stringify({accounts: accounts.map(({accountId, updatedAt}) => ({accountId, updatedAt}))}),
            redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal
          });
          if (response.redirected) fail('invalid_response');
          if (response.status === 401 || response.status === 403) fail('authorization_failed');
          if (response.status === 429) throw new PrivacyReportingError('rate_limited', {retryAfterMs: retryAfter(response.headers.get('retry-after'), clock())});
          if (response.status >= 500) fail('unavailable');
          if (![200, 204].includes(response.status)) fail('rejected');
          const cycleMs = cyclePeriod(response.headers.get('cycle-period'));
          if (response.status === 204) return {eraseAccountIds: [], cycleMs};
          const value = await boundedJson(response, controller.signal);
          if (!plain(value) || !Array.isArray(value.accounts) || value.accounts.length > accounts.length) fail('invalid_response');
          const erased = new Set();
          for (const item of value.accounts) {
            if (!plain(item) || !ids.has(item.accountId) || erased.has(item.accountId) || !['closed', 'updated'].includes(item.status)) fail('invalid_response');
            erased.add(item.accountId);
          }
          return {eraseAccountIds: [...erased], cycleMs};
        })()]);
      } catch (error) { throw safeError(error); }
      finally { clearTimeout(timer); controller.abort(); }
    }
  });
}

/** Server-only scheduled service. It does not require or return an extension
 * credential. Refresh persistence completes under the existing row lock BEFORE
 * calling the reporting API. Only explicit invalid_grant removes an unusable
 * connection; a reporting 403 or an uncertain provider failure erases nothing.
 */
export function createPrivacyReportingService({store, connectionStore, oauth, cryptoKey, client, fetchImpl, clock = Date.now} = {}) {
  const methods = ['withSweepLock', 'getJobState', 'startRun', 'listDueAccounts', 'existingAccounts', 'listAccountConnections', 'eraseConnection',
    'eraseAccounts', 'reserveAccounts', 'stageReportResult', 'applyPendingReports', 'recordFailure', 'finishRun'];
  if (!store || methods.some(method => typeof store[method] !== 'function') || !connectionStore?.withConnectionLock || !oauth?.refreshTokens || typeof clock !== 'function') fail('invalid_configuration');
  const cipher = createTokenCipher(cryptoKey);
  const provider = client || createPrivacyReportingClient({fetchImpl, clock});
  if (typeof provider.report !== 'function') fail('invalid_configuration');
  const now = () => timestamp(clock());

  async function accessToken(id, accountId) {
    return connectionStore.withConnectionLock(id, async (item, tx) => {
      if (!item || item.accountId !== accountId) return null;
      let tokens = cipher.decrypt(item.id, item.tokensCiphertext);
      if (!plain(tokens) || typeof tokens.accessToken !== 'string' || !BEARER.test(tokens.accessToken) ||
          typeof tokens.refreshToken !== 'string' || !tokens.refreshToken || !Array.isArray(tokens.scopes) ||
          !JIRA_OAUTH_SCOPES.every(scope => tokens.scopes.includes(scope))) fail('invalid_response');
      timestamp(tokens.expiresAt);
      if (tokens.expiresAt < now() + 60_000) {
        const pair = await oauth.refreshTokens({refreshToken: tokens.refreshToken, grantedScopes: tokens.scopes});
        if (!plain(pair) || typeof pair.accessToken !== 'string' || !BEARER.test(pair.accessToken) || typeof pair.refreshToken !== 'string' || !pair.refreshToken ||
            !Number.isSafeInteger(pair.expiresIn) || pair.expiresIn <= 0 || pair.expiresIn > 31_536_000 || !Array.isArray(pair.scopes) ||
            !JIRA_OAUTH_SCOPES.every(scope => pair.scopes.includes(scope))) fail('invalid_response');
        const updatedAt = now();
        tokens = {accessToken: pair.accessToken, refreshToken: pair.refreshToken, scopes: pair.scopes, expiresAt: updatedAt + pair.expiresIn * 1000};
        await tx.updateTokens({tokensCiphertext: cipher.encrypt(item.id, tokens), updatedAt});
      }
      return tokens.accessToken;
    });
  }

  return Object.freeze({
    async run({maxAccounts = 90, maxRunMs = 45_000} = {}) {
      if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 900 || !Number.isInteger(maxRunMs) || maxRunMs < 1000 || maxRunMs > 240_000) fail('invalid_configuration');
      const counts = {selected: 0, reported: 0, recovered: 0, erasedAccounts: 0, erasedConnections: 0, failed: 0};
      const errors = new Set();
      try {
        const locked = await store.withSweepLock(async () => {
          const startedAt = now(), deadline = startedAt + maxRunMs;
          // Provider responses awaiting application are retried even while a
          // provider rate-limit delay or an account's cycle is still in force.
          const recovered = await store.applyPendingReports({limit: maxAccounts});
          counts.recovered += recovered.applied;
          counts.erasedAccounts += recovered.erasedAccounts;
          counts.erasedConnections += recovered.erasedConnections;
          const state = await store.getJobState();
          if (state.notBefore > startedAt) return {status: 'deferred', ...counts, retryAt: new Date(state.notBefore).toISOString(), errors: []};
          await store.startRun(startedAt);
          if (connectionStore.cleanupExpired) await connectionStore.cleanupExpired(startedAt);
          const due = await store.listDueAccounts({now: startedAt, limit: maxAccounts});
          counts.selected = due.length;
          let stoppedForBudget = false;
          for (let offset = 0; offset < due.length; offset += 90) {
            if (now() >= deadline) { stoppedForBudget = true; break; }
            const batch = due.slice(offset, offset + 90);
            const invalid = batch.filter(item => !validAccount(item.accountId));
            if (invalid.length) {
              counts.erasedConnections += await store.eraseAccounts(invalid.map(item => item.accountId));
              counts.erasedAccounts += invalid.length;
            }
            let accounts = batch.filter(item => validAccount(item.accountId));
            if (!accounts.length) continue;
            let token;
            for (const account of accounts) {
              const candidates = await store.listAccountConnections(account.accountId);
              for (const id of candidates) {
                // maxRunMs is a soft budget for starting work. Leave room for
                // the 15s OAuth deadline and token-commit/database finalization.
                if (deadline - now() < 35_000) { stoppedForBudget = true; break; }
                try { token = await accessToken(id, account.accountId); }
                catch (error) {
                  if (error instanceof JiraOAuthError && error.code === 'grant_revoked') {
                    counts.erasedConnections += await store.eraseConnection(id);
                  } else {
                    // Permission, configuration, network and malformed-response
                    // failures do not prove revocation and must preserve records.
                    errors.add(safeError(error).code);
                  }
                }
                if (token) break;
              }
              if (token || stoppedForBudget) break;
            }
            accounts = await store.existingAccounts(accounts.map(item => item.accountId));
            if (!accounts.length) continue;
            if (!token) {
              if (!stoppedForBudget) { counts.failed += accounts.length; errors.add('no_usable_connection'); }
              break;
            }
            const remaining = deadline - now();
            if (remaining < 20_000) { stoppedForBudget = true; break; }
            const accountIds = accounts.map(item => item.accountId);
            const payload = accounts.map(item => ({accountId: item.accountId, updatedAt: new Date(timestamp(item.oldestCollectedAt)).toISOString()}));
            await store.reserveAccounts({accountIds, now: now()});
            let result;
            try {
              result = await provider.report({accessToken: token, accounts: payload, timeoutMs: Math.min(15_000, remaining)});
              // Validate injected clients too; no arbitrary returned identity can
              // ever become an account-deletion target.
              if (!plain(result) || !Array.isArray(result.eraseAccountIds) || new Set(result.eraseAccountIds).size !== result.eraseAccountIds.length ||
                  result.eraseAccountIds.some(id => !accountIds.includes(id)) || !Number.isSafeInteger(result.cycleMs) || result.cycleMs <= 0 || result.cycleMs > MAX_INTERVAL_MS) fail('invalid_response');
            } catch (error) {
              const failure = safeError(error); counts.failed += accounts.length; errors.add(failure.code);
              // Explicit 400/401/403 responses establish rejection, so an
              // operator fix can be retried after one hour. An uncertain outcome
              // retains its known cycle reservation to avoid duplicate reports.
              const retryAfterMs = failure.retryAfterMs ?? (['authorization_failed', 'rejected'].includes(failure.code) ? 3_600_000 : undefined);
              await store.recordFailure({accountIds, now: now(), errorCode: failure.code, retryAfterMs});
              break;
            }
            // This is deliberately separate from the provider catch: once the
            // report succeeded, database failures must never discard its action
            // as though the provider had rejected it. Queue commit precedes erase.
            const receivedAt = now();
            let staged = false;
            for (let attempt = 0; attempt < 2 && !staged; attempt++) {
              try {
                await store.stageReportResult({accountIds, eraseAccountIds: result.eraseAccountIds, now: receivedAt, cycleMs: result.cycleMs});
                staged = true;
              } catch { /* Bounded idempotent persistence retry; no provider retry. */ }
            }
            if (!staged) {
              counts.failed += accounts.length; errors.add('persistence_failed'); break;
            }
            counts.reported += accounts.length;
            try {
              const applied = await store.applyPendingReports({limit: maxAccounts});
              counts.erasedAccounts += applied.erasedAccounts;
              counts.erasedConnections += applied.erasedConnections;
            } catch {
              counts.failed += accounts.length; errors.add('persistence_failed'); break;
            }
          }
          const status = counts.failed ? 'failed' : stoppedForBudget ? 'partial' : due.length ? 'complete' : 'idle';
          await store.finishRun({now: now(), status, counts});
          return {status, ...counts, errors: [...errors]};
        });
        return locked.acquired ? locked.value : {status: 'busy', ...counts, errors: []};
      } catch (error) { throw safeError(error); }
    }
  });
}
