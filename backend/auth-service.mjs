import { randomUUID } from 'node:crypto';
import { JiraOAuthError } from './jira-oauth.mjs';
import {
  JiraAuthError, createTokenCipher, equalHash, failAuth, isChallenge, parseCredential,
  randomSecret, secretHash, verifierChallenge
} from './security.mjs';

const STATE_TTL = 10 * 60_000;
const HANDOFF_TTL = 2 * 60_000;
const EXTENSION_ID = /^[a-p]{32}$/;
const CLOUD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CALLBACK_ERRORS = new Set([
  'invalid_request', 'access_denied', 'no_sites', 'invalid_response', 'unavailable',
  'authorization_rejected', 'insufficient_scope', 'unavailable_resource', 'rate_limited', 'timeout'
]);

function callbackErrorCode(error) {
  if ((error instanceof JiraAuthError || error instanceof JiraOAuthError) && CALLBACK_ERRORS.has(error.code)) return error.code;
  return 'unavailable';
}

function safeError(error) {
  if (error instanceof JiraAuthError || error instanceof JiraOAuthError) return error;
  return new JiraAuthError('unavailable');
}

function publicConnection(item) {
  return {
    id: item.id, accountId: item.accountId, displayName: item.displayName,
    sites: item.sites.map(({ id, name, url }) => ({ id, name, url }))
  };
}

function tokenPayload(pair, now) {
  if (!plain(pair) || typeof pair.accessToken !== 'string' || !pair.accessToken || pair.accessToken.length > 16_384 ||
      typeof pair.refreshToken !== 'string' || !pair.refreshToken || pair.refreshToken.length > 16_384 ||
      !Number.isSafeInteger(pair.expiresIn) || pair.expiresIn <= 0 || pair.expiresIn > 31_536_000 ||
      !Array.isArray(pair.scopes) || !pair.scopes.length || pair.scopes.some(scope => typeof scope !== 'string')) failAuth('invalid_response');
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, scopes: [...pair.scopes], expiresAt: now + pair.expiresIn * 1000 };
}

function validateProfile(sites, user) {
  if (!Array.isArray(sites) || sites.length > 1000) failAuth('invalid_response');
  if (!sites.length) failAuth('no_sites');
  for (const site of sites) {
    if (!plain(site) || !CLOUD_ID.test(site.id) || typeof site.name !== 'string' || !site.name || site.name.length > 512 ||
        typeof site.url !== 'string') failAuth('invalid_response');
    let url;
    try { url = new URL(site.url); } catch { failAuth('invalid_response'); }
    if (url.protocol !== 'https:' || url.origin !== site.url || url.username || url.password) failAuth('invalid_response');
  }
  if (!plain(user) || typeof user.accountId !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(user.accountId) ||
      typeof user.displayName !== 'string' || !user.displayName || user.displayName.length > 512) failAuth('invalid_response');
  if (user.active !== true) failAuth('access_denied');
}

/** All tokens remain server-side. Extension credentials are random capabilities:
 * every later operation must authenticate the full id.secret, never a caller's connection ID.
 * Store methods returning one-use claims must be atomic across deployed instances.
 */
export function createAuthService({ store, oauth, cryptoKey, allowedExtensionIds, clock = Date.now } = {}) {
  const requiredStore = ['putState', 'consumeState', 'createConnectionWithHandoff', 'completeHandoff', 'getConnection', 'deleteConnection', 'withConnectionLock'];
  const requiredOAuth = ['authorizationUrl', 'exchangeCode', 'discoverResources', 'getCurrentUser', 'refreshTokens'];
  if (!store || requiredStore.some(name => typeof store[name] !== 'function') || !oauth || requiredOAuth.some(name => typeof oauth[name] !== 'function') ||
      !Array.isArray(allowedExtensionIds) || !allowedExtensionIds.length || allowedExtensionIds.some(id => typeof id !== 'string' || !EXTENSION_ID.test(id)) ||
      typeof clock !== 'function') failAuth('invalid_configuration');
  const extensionIds = new Set(allowedExtensionIds);
  const cipher = createTokenCipher(cryptoKey);
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) failAuth('unavailable');
    return value;
  };
  const requireOwner = (item, hash) => {
    if (!item || !extensionIds.has(item.extensionId) || !equalHash(item.credentialHash, hash) || item.pendingExpiresAt != null) failAuth('unauthorized');
    return item;
  };
  const run = action => async (...args) => {
    try { return await action(...args); } catch (error) { throw safeError(error); }
  };

  return Object.freeze({
    start: run(async ({ challenge, extensionId } = {}) => {
      if (!isChallenge(challenge) || !extensionIds.has(extensionId)) failAuth('invalid_request');
      const state = randomSecret();
      const authorizationUrl = oauth.authorizationUrl({ state });
      await store.putState({ stateHash: secretHash(state), challenge, extensionId, expiresAt: now() + STATE_TTL });
      return { authorizationUrl };
    }),

    callback: run(async ({ state, code, error } = {}) => {
      if (!isChallenge(state)) failAuth('invalid_state');
      const claim = await store.consumeState({ stateHash: secretHash(state), now: now() });
      if (!claim || !extensionIds.has(claim.extensionId) || !isChallenge(claim.challenge)) failAuth('invalid_state');
      // Once state proves the initiating extension, both success and failure must
      // return there so launchWebAuthFlow closes. Unverified state never redirects.
      const redirectBase = `https://${claim.extensionId}.chromiumapp.org/jira`;
      try {
        if (error !== undefined) failAuth('access_denied');
        if (typeof code !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(code)) failAuth('invalid_request');
        const pair = await oauth.exchangeCode({ code });
        const tokens = tokenPayload(pair, now());
        const sites = await oauth.discoverResources({ accessToken: tokens.accessToken });
        if (!Array.isArray(sites)) failAuth('invalid_response');
        if (!sites.length) failAuth('no_sites');
        const user = await oauth.getCurrentUser({ accessToken: tokens.accessToken, cloudId: sites[0]?.id });
        validateProfile(sites, user);
        const id = randomUUID();
        const handoff = randomSecret();
        const timestamp = now();
        await store.createConnectionWithHandoff({
          connection: {
            id, accountId: user.accountId, displayName: user.displayName,
            sites: sites.map(({ id, name, url }) => ({ id, name, url })),
            extensionId: claim.extensionId, tokensCiphertext: cipher.encrypt(id, tokens), createdAt: timestamp
          },
          handoff: { codeHash: secretHash(handoff), challenge: claim.challenge, expiresAt: timestamp + HANDOFF_TTL }
        });
        return { redirectUrl: `${redirectBase}?code=${handoff}` };
      } catch (failure) {
        return { redirectUrl: `${redirectBase}?error=${callbackErrorCode(failure)}` };
      }
    }),

    complete: run(async ({ code, verifier } = {}) => {
      if (!isChallenge(code)) failAuth('invalid_handoff');
      let challenge;
      try { challenge = verifierChallenge(verifier); } catch { failAuth('invalid_handoff'); }
      const secret = randomSecret();
      const item = await store.completeHandoff({ codeHash: secretHash(code), challenge, credentialHash: secretHash(secret), allowedExtensionIds: [...extensionIds], now: now() });
      if (!item || !extensionIds.has(item.extensionId)) failAuth('invalid_handoff');
      return { connection: { ...publicConnection(item), credential: `${item.id}.${secret}` } };
    }),

    authenticate: run(async credential => {
      const { id, hash } = parseCredential(credential);
      return publicConnection(requireOwner(await store.getConnection(id), hash));
    }),

    disconnect: run(async credential => {
      const { id, hash } = parseCredential(credential);
      requireOwner(await store.getConnection(id), hash);
      if (!await store.deleteConnection({ id, credentialHash: hash })) failAuth('unauthorized');
      return { disconnected: true };
    }),

    async withAccessToken(credential, action) {
      const authorize = run(async () => {
        if (typeof action !== 'function') failAuth('invalid_request');
        const { id, hash } = parseCredential(credential);
        // Refresh + token persistence finish under a database row lock before any
        // caller action. A ticket/upload failure can never roll back a rotated pair.
        return store.withConnectionLock(id, async (item, transaction) => {
          requireOwner(item, hash);
          let tokens = cipher.decrypt(id, item.tokensCiphertext);
          if (!plain(tokens) || typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string' ||
              !Number.isSafeInteger(tokens.expiresAt) || !Array.isArray(tokens.scopes)) failAuth('unavailable');
          if (tokens.expiresAt < now() + 60_000) {
            const pair = await oauth.refreshTokens({ refreshToken: tokens.refreshToken, grantedScopes: tokens.scopes });
            const timestamp = now();
            tokens = tokenPayload(pair, timestamp);
            await transaction.updateTokens({ tokensCiphertext: cipher.encrypt(id, tokens), updatedAt: timestamp });
          }
          return { accessToken: tokens.accessToken, connection: publicConnection(item) };
        });
      });
      const authorized = await authorize();
      // The HTTP boundary owns safe serialization of caller-defined API errors.
      return action(authorized.accessToken, authorized.connection);
    }
  });
}
