import {AIReviewError, buildReviewRequest, validateReview} from './ai-client.mjs';
import {createManagedAgentsClient, ManagedAgentError} from './claude-agents-client.mjs';
import {readReviewAgent, verifyReviewAgent} from './review-agent-config.mjs';
import {createOpenAIAgentsClient} from './openai-agents-client.mjs';
import {readOpenAIReviewAgent, verifyOpenAIReviewAgent, OPENAI_AGENT_MODEL} from './openai-agent-config.mjs';
import {REVIEW_AGENT_MODEL, REVIEW_KNOWLEDGE_REVISION, REVIEW_KNOWLEDGE_CHECKED_AT, REVIEW_KNOWLEDGE_RULES, REVIEW_KNOWLEDGE_SOURCES, REVIEW_ASSESSMENTS} from './review-agent-definitions.mjs';

const rules = new Map(REVIEW_KNOWLEDGE_RULES.map(rule => [rule.id, rule]));
const sources = new Map(REVIEW_KNOWLEDGE_SOURCES.map(source => [source.id, source]));
const fail = (code, message) => { throw new AIReviewError(code, message); };
const SCOPE_LIMITATION = 'Screenshot review only: DOM semantics, keyboard behavior, measured contrast, responsive states and assistive technology were not tested. This is not a WCAG conformance audit.';

export function validateManagedReview(value, mode, {hasDesignReference = false, apiKey = ''} = {}) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('AI_OUTPUT', 'The reviewer returned an invalid result.'); }
  if (!serialized || serialized.length > 256000 || (apiKey && serialized.includes(apiKey)) || !value || typeof value !== 'object' || !Array.isArray(value.suggestions)) fail('AI_OUTPUT', 'The reviewer returned invalid or credential-like content.');
  const metadata = value.suggestions.map(item => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.ruleIds) || item.ruleIds.length > 4 || new Set(item.ruleIds).size !== item.ruleIds.length || item.ruleIds.some(id => typeof id !== 'string' || !rules.has(id)) || !REVIEW_ASSESSMENTS.includes(item.assessment) || (item.category !== 'design-mismatch' && item.ruleIds.length === 0)) fail('AI_OUTPUT', 'The reviewer returned unsupported rule references or an invalid assessment.');
    const referencedRules = item.ruleIds.map(id => rules.get(id));
    // This reviewer receives pixels, not DOM or interaction evidence. Never
    // let a model label a nonvisual accessibility check as an observed failure.
    const missingEvidence = referencedRules.some(rule => rule.verification && rule.verification !== 'visual');
    const heuristic = referencedRules.some(rule => !rule.verification);
    const assessment = missingEvidence ? 'needs-verification' : item.assessment === 'observed' && heuristic ? 'heuristic' : item.assessment;
    const sourceIds = [...new Set(referencedRules.flatMap(rule => rule.sourceIds))];
    if (sourceIds.some(id => !sources.has(id))) fail('AI_OUTPUT', 'The reviewer reference library is incomplete. Update Diffuse before reviewing.');
    return {ruleIds: [...item.ruleIds], assessment, sources: sourceIds.map(id => { const source = sources.get(id); return {title: source.title, url: source.url}; })};
  });
  const stripped = {...value, suggestions: value.suggestions.map(({ruleIds, assessment, ...item}) => item)};
  const validated = validateReview(stripped, mode, {hasDesignReference});
  return {...validated, limitations: [...validated.limitations.filter(item => item !== SCOPE_LIMITATION).slice(0, 7), SCOPE_LIMITATION],
    suggestions: validated.suggestions.map((item, index) => ({...item, ...metadata[index]}))};
}

function safeError(cause) {
  if (cause instanceof AIReviewError) return cause;
  if (cause instanceof ManagedAgentError) {
    const message = cause.message.replaceAll('The journey stopped', 'The review stopped').replaceAll('this journey', 'this review').replaceAll('the journey', 'the review');
    const result = new AIReviewError(cause.code, message);
    if (cause.status) result.status = cause.status;
    if (cause.requestId) result.requestId = cause.requestId;
    return result;
  }
  return new AIReviewError('AI_SERVICE', 'The UX & Accessibility Reviewer could not complete this review. No findings were added.');
}

export async function reviewScreensManaged(args, {client, storage = chrome.storage.local, signal: suppliedSignal, timeoutMs = 240000, resolveAgent, verifyAgent} = {}) {
  const prepared = buildReviewRequest(args);
  const {apiKey, provider, mode, content, hasDesignReference} = prepared;
  const openai = provider === 'openai';
  const consoleName = openai ? 'OpenAI Platform' : 'Claude Console';
  if (JSON.stringify(content).includes(apiKey)) fail('AI_CONFIG', 'Remove API credentials from review evidence.');
  const budgetUsd = args.budgetUsd ?? 2;
  if (!Number.isFinite(budgetUsd) || budgetUsd < .1 || budgetUsd > 20 || Math.abs(budgetUsd * 100 - Math.round(budgetUsd * 100)) > 1e-6) fail('AI_CONFIG', 'Choose a review spending limit between $0.10 and $20, in whole cents.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) fail('AI_CONFIG', 'The reviewer timeout must be between 1 millisecond and 4 minutes.');
  client ||= openai ? createOpenAIAgentsClient({apiKey, storage}) : createManagedAgentsClient({apiKey});
  resolveAgent ||= openai ? readOpenAIReviewAgent : readReviewAgent;
  verifyAgent ||= openai ? verifyOpenAIReviewAgent : verifyReviewAgent;
  const signals = [...new Set([args.signal, suppliedSignal].filter(Boolean))];
  const lifetime = new AbortController();
  let sessionId = null, timedOut = false, timer, creationPending = false;
  const interrupted = new Set();
  async function interruptOnce(id) {
    if (interrupted.has(id)) return;
    interrupted.add(id);
    const cleanup = new AbortController();
    let cleanupTimer;
    try {
      await Promise.race([client.interrupt(id, {signal: cleanup.signal}), new Promise(resolve => { cleanupTimer = setTimeout(() => { cleanup.abort(); resolve(); }, 5000); })]);
    } catch { /* The inference budget remains bounded even if cleanup fails. */ }
    finally { clearTimeout(cleanupTimer); }
  }
  const abort = () => lifetime.abort();
  const failure = () => new AIReviewError(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED', (timedOut ? 'The UX & Accessibility Reviewer timed out. No findings were added.' : 'The AI review was cancelled.') + (creationPending ? ` Session creation is unconfirmed; check Sessions in ${consoleName} before starting another review.` : ''));
  const ensureActive = () => { if (lifetime.signal.aborted) throw failure(); };
  const race = operation => {
    ensureActive();
    let rejectAbort;
    const abortPromise = new Promise((resolve, reject) => { rejectAbort = () => reject(failure()); lifetime.signal.addEventListener('abort', rejectAbort, {once: true}); });
    return Promise.race([Promise.resolve().then(() => { ensureActive(); return operation(); }), abortPromise]).finally(() => lifetime.signal.removeEventListener('abort', rejectAbort));
  };
  for (const signal of signals) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true}); }
  timer = setTimeout(() => { timedOut = true; lifetime.abort(); }, timeoutMs);
  try {
    ensureActive();
    const agent = await race(() => resolveAgent(apiKey, {storage}));
    if (!agent.ready) fail('REVIEW_SETUP', agent.reason || 'Set up the UX & Accessibility Reviewer in AI settings first.');
    if (agent.provider && agent.provider !== provider) fail('REVIEW_SETUP', 'The reviewer belongs to another provider. Check the selected provider in AI settings.');
    await race(() => verifyAgent(agent, {client, signal: lifetime.signal}));
    ensureActive();
    try {
      // One session per deliberate review, no retry. A lost response may have
      // created a session, so expose that uncertainty instead of spending again.
      creationPending = true;
      await race(async () => {
        const session = await client.createSession({agentId: agent.reviewer.id, agentVersion: agent.reviewer.version, environmentId: agent.environmentId, budgetUsd, signal: lifetime.signal, ...(openai ? {initialContent: content} : {})});
        if (typeof session?.id !== 'string' || !(openai ? /^[A-Za-z][A-Za-z0-9_-]{1,160}$/ : /^sesn_[A-Za-z0-9_-]{1,120}$/).test(session.id)) fail('REVIEW_SESSION_UNCERTAIN', `The provider did not confirm review session creation. Check Sessions in ${consoleName} before starting another review.`);
        sessionId = session.id; creationPending = false;
        // A transport that resolves after cancellation can still reveal the
        // session identifier. Stop that late session without issuing a message.
        if (lifetime.signal.aborted) await interruptOnce(sessionId);
      });
    } catch (cause) {
      if (cause.ambiguous === true || cause.status >= 500 || (!cause.status && cause.code !== 'AI_CANCELLED' && cause.code !== 'AI_TIMEOUT')) fail('REVIEW_SESSION_UNCERTAIN', `The provider did not confirm review session creation. Check Sessions in ${consoleName} before starting another review; no second session was requested.`);
      throw cause;
    }
    if (!openai) await race(() => client.sendEvents(sessionId, [{type: 'user.message', content}], {signal: lifetime.signal}));
    const result = await race(() => client.waitForTool(sessionId, {toolNames: ['review_assessment'], signal: lifetime.signal, timeoutMs}));
    ensureActive();
    if (result.name !== 'review_assessment') fail('AI_OUTPUT', 'The reviewer requested an unsupported action. No findings were added.');
    const review = validateManagedReview(result.input, mode, {hasDesignReference, apiKey});
    return {...review, provider, model: openai ? OPENAI_AGENT_MODEL : REVIEW_AGENT_MODEL, mode, knowledgeRevision: REVIEW_KNOWLEDGE_REVISION, checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT, sessionId};
  } catch (cause) {
    if (lifetime.signal.aborted) throw failure();
    throw safeError(cause);
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener('abort', abort);
    if (sessionId) {
      // Do not acknowledge the result tool: that could launch another inference
      // turn. Interrupt independently of the cancelled review signal instead.
      await interruptOnce(sessionId);
    }
  }
}
