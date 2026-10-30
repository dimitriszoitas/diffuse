import {BROWSER_AUDIT_ORIGIN, readBrowserAuditConfig, pairBrowserAudit, disconnectBrowserAudit, browserAuditRequest, browserAuditURL, browserAuditChecks, browserAuditId, BrowserAuditError} from './browser-audit-client.mjs';
import {saveBrowserAudit, getBrowserAudit, listBrowserAudits} from './browser-audit-store.mjs';
import {readAISettings} from './ai-config.mjs';
import {aiProviderOrigin} from './ai-providers.mjs';
import {analyzeBrowserAudit} from './browser-audit-ai.mjs';

export const BROWSER_AUDIT_MESSAGES = new Set(['BROWSER_AUDIT_CONFIG','BROWSER_AUDIT_PAIR','BROWSER_AUDIT_CHECK','BROWSER_AUDIT_DISCONNECT','BROWSER_AUDIT_OPEN','BROWSER_AUDIT_STATE','BROWSER_AUDIT_RUN','BROWSER_AUDIT_STOP','BROWSER_AUDIT_ANALYZE','BROWSER_AUDIT_REPORT','BROWSER_AUDIT_ACCEPT']);
const active = audit => ['opening','ready','running'].includes(audit?.status);
const failure = message => { throw new BrowserAuditError('AUDIT_STATE', message); };
const now = () => new Date().toISOString();

export function createBrowserAuditService({chromeApi = chrome, getSession, ensureReview = async () => {}, changed = () => {}, acceptFinding,
  store = {save: saveBrowserAudit, get: getBrowserAudit, list: listBrowserAudits}, request = browserAuditRequest,
  readConfig = readBrowserAuditConfig, pair = pairBrowserAudit, disconnect = disconnectBrowserAudit,
  readAI = readAISettings, analyze = analyzeBrowserAudit} = {}) {
  const analyses = new Map(), syncing = new Map(), accepting = new Map();
  let opening = false, startingAnalysis = false;
  async function config() {
    const connection = await readConfig(), ai = await readAI();
    return {config: connection, ai: {provider: ai.provider, model: ai.model, hasKey: ai.hasKey}};
  }
  async function local(path, options = {}) {
    if (!(await chromeApi.permissions.contains({origins: [BROWSER_AUDIT_ORIGIN]}))) failure('Allow the local browser connection from the audit panel first.');
    const {token} = await readConfig({includeToken: true});
    return request(path, {...options, token});
  }
  const save = async audit => { const result = await store.save(audit); changed(); return result; };
  async function find(id) {
    if (!id) {
      const reviewId = getSession()?.reviewId;
      if (!reviewId) return null;
      id = (await store.list(reviewId))[0]?.id;
      if (!id) return null;
    }
    const audit = await store.get(browserAuditId(id));
    if (!audit) failure('This interactive audit is no longer saved.');
    if (audit.analysisStatus === 'running' && !analyses.has(audit.id)) {
      audit.analysisStatus = 'error'; audit.analysisError = 'Chrome interrupted the analysis. Your local evidence is saved. No automatic retry was sent.';
      await save(audit);
    }
    return audit;
  }
  function helperJob(value) {
    const job = value?.audit || value;
    if (!job || !['opening','ready','running','completed','stopped','error'].includes(job.status) || !Array.isArray(job.steps) || job.steps.length > 200) failure('The local browser returned an invalid audit.');
    browserAuditId(job.id);
    return job;
  }
  async function merge(audit, value) {
    const job = helperJob(value);
    if (job.id !== audit.id) failure('The helper returned another audit. No evidence was replaced.');
    audit = await store.get(audit.id) || audit;
    const remoteTime = Date.parse(job.updatedAt), lastTime = Date.parse(audit.helperUpdatedAt);
    if (Number.isFinite(remoteTime) && Number.isFinite(lastTime) && remoteTime < lastTime) return audit;
    if (!active(audit) && active(job)) return audit;
    // The helper never controls review ownership, provider, or saved AI output.
    return save({...audit, status: job.status, page: job.page || job.evidence?.page || audit.page,
      steps: job.steps, ...(job.evidence ? {evidence: job.evidence} : {}),
      error: typeof job.error === 'string' ? job.error.slice(0, 1000) : job.error?.message?.slice(0, 1000),
      helperUpdatedAt: job.updatedAt || audit.helperUpdatedAt, stopUnconfirmed: false, updatedAt: now(), syncError: null});
  }
  async function sync(audit) {
    if (!audit || (!active(audit) && !audit.stopUnconfirmed)) return audit;
    if (syncing.has(audit.id)) return syncing.get(audit.id);
    const task = (async () => {
      try { return await merge(await store.get(audit.id) || audit, await local(`/audits/${audit.id}${audit.stopUnconfirmed ? '/stop' : ''}`, audit.stopUnconfirmed ? {method: 'POST', body: {}} : {})); }
      catch (error) {
        const fresh = await store.get(audit.id) || audit;
        return save({...fresh, ...(error.code === 'AUDIT_MISSING' ? {status: 'stopped', stopUnconfirmed: false, error: 'The local browser session ended. The last saved steps and measurements are retained.'} : {}), syncError: error.message, updatedAt: now()});
      }
    })().finally(() => syncing.delete(audit.id));
    syncing.set(audit.id, task); return task;
  }
  async function currentAudit(message) { const audit = await find(message.id); if (!audit) failure('Open an interactive audit first.'); return audit; }
  async function handle(message) {
    switch (message.type) {
      case 'BROWSER_AUDIT_CONFIG': return {ok: true, ...await config()};
      case 'BROWSER_AUDIT_PAIR': {
        if (!(await chromeApi.permissions.contains({origins: [BROWSER_AUDIT_ORIGIN]}))) failure('Allow the local browser connection before pairing.');
        const connection = await pair(message.token); return {ok: true, ...await config(), config: connection};
      }
      case 'BROWSER_AUDIT_CHECK': return {ok: true, ...await config(), health: await local('/health')};
      case 'BROWSER_AUDIT_DISCONNECT': {
        if (analyses.size || opening || startingAnalysis) failure('Stop the current operation before disconnecting.');
        const audit = await find();
        if (active(audit)) failure('Stop the browser audit before disconnecting.');
        return {ok: true, config: await disconnect()};
      }
      case 'BROWSER_AUDIT_OPEN': {
        const session = getSession();
        if (!session?.reviewId) failure('Start a review before opening an interactive audit.');
        if (opening) failure('The local audit browser is already opening.');
        opening = true;
        try {
          const url = browserAuditURL(message.url || session.target?.url), checks = browserAuditChecks(message.checks);
          await ensureReview(session);
          if (getSession()?.id !== session.id) failure('The review changed. Open the audit from the current review.');
          const job = helperJob(await local('/audits', {method: 'POST', body: {url, checks}}));
          const audit = await save({id: job.id, reviewId: session.reviewId, status: job.status, createdAt: job.createdAt || now(), updatedAt: now(),
            approvedUrl: url, page: job.page || {url, title: session.target?.title || ''}, checks, steps: job.steps, ...(job.evidence ? {evidence: job.evidence} : {})});
          return {ok: true, audit};
        } finally { opening = false; }
      }
      case 'BROWSER_AUDIT_STATE': return {ok: true, audit: await sync(await find(message.id)), ...await config()};
      case 'BROWSER_AUDIT_RUN': {
        const audit = await currentAudit(message);
        if (audit.status !== 'ready') failure('Open the audit browser and wait until it is ready before collecting.');
        return {ok: true, audit: await merge(audit, await local(`/audits/${audit.id}/run`, {method: 'POST', body: {}}))};
      }
      case 'BROWSER_AUDIT_STOP': {
        let audit = await currentAudit(message);
        analyses.get(audit.id)?.abort();
        if (active(audit) || audit.stopUnconfirmed) {
          try { audit = await merge(audit, await local(`/audits/${audit.id}/stop`, {method: 'POST', body: {}})); }
          catch (error) {
            audit = await store.get(audit.id) || audit;
            audit = await save({...audit, status: 'stopped', stopUnconfirmed: error.code !== 'AUDIT_MISSING', updatedAt: now(),
              error: 'Local tracking stopped. The helper could not confirm that the browser stopped; it may finish its bounded collection. The last saved evidence is retained.', syncError: error.message});
          }
        }
        return {ok: true, audit};
      }
      case 'BROWSER_AUDIT_ANALYZE': {
        const audit = await currentAudit(message);
        if (active(audit)) failure('Finish or stop collecting evidence before analyzing it.');
        if (!audit.evidence) failure('This audit has no measured evidence to analyze yet.');
        if (analyses.size || startingAnalysis) failure('Wait for the current analysis to finish, or stop it.');
        startingAnalysis = true;
        try {
        const ai = await readAI({includeKey: true});
        if (message.expectedProvider !== ai.provider) failure('Your AI provider changed. Check the selected provider, then click Analyze again. No evidence was sent.');
        if (!ai.hasKey || !(await chromeApi.permissions.contains({origins: [aiProviderOrigin(ai.provider)]}))) failure('Connect your selected AI provider in Settings before analyzing evidence.');
        const controller = new AbortController(); analyses.set(audit.id, controller);
        try { await save({...audit, analysisStatus: 'running', analysisError: null, updatedAt: now()}); }
        catch (error) { analyses.delete(audit.id); throw error; }
        // The panel polls state; browser evidence remains available during the
        // one provider request. No automatic retry or provider fallback.
        void (async () => {
          try {
            const analysis = await analyze(audit, {...ai, instructions: message.instructions || '', signal: controller.signal});
            if (controller.signal.aborted) throw new Error('The analysis was stopped. Your local evidence is saved.');
            const fresh = await store.get(audit.id);
            if (fresh) await save({...fresh, analysis, analysisStatus: 'completed', analysisError: null, updatedAt: now()});
          } catch (error) {
            const fresh = await store.get(audit.id);
            const errorText = error?.code?.startsWith('AI_') ? error.message : 'The analysis could not finish. Your local evidence is saved; no retry was sent.';
            if (fresh) await save({...fresh, analysisStatus: 'error', analysisError: errorText, updatedAt: now()});
          } finally { analyses.delete(audit.id); changed(); }
        })().catch(() => {});
        return {ok: true, audit: await store.get(audit.id)};
        } finally { startingAnalysis = false; }
      }
      case 'BROWSER_AUDIT_REPORT': {
        const audit = await currentAudit(message);
        await chromeApi.tabs.create({url: chromeApi.runtime.getURL('browser-audit-report.html') + `?audit=${encodeURIComponent(audit.id)}`});
        return {ok: true};
      }
      case 'BROWSER_AUDIT_ACCEPT': {
        const audit = await currentAudit(message), index = message.findingIndex;
        if (!Number.isInteger(index) || !audit.analysis?.findings?.[index] || !acceptFinding) failure('Choose a finding from this audit’s saved AI analysis.');
        const identity = `${audit.id}:${audit.analysis.createdAt || 'analysis'}:${index}`;
        if (accepting.has(identity)) return accepting.get(identity);
        const task = Promise.resolve().then(() => acceptFinding(audit, index, identity)).then(commentId => ({ok: true, commentId})).finally(() => accepting.delete(identity));
        accepting.set(identity, task); return task;
      }
      default: failure('Unsupported interactive audit action.');
    }
  }
  return {handle, async reviewBusy(reviewId) { return opening || accepting.size > 0 || (await store.list(reviewId)).some(audit => active(audit) || analyses.has(audit.id)); }};
}
