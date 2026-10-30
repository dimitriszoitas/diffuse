import {journeyOutcomeContext, journeyTargetAssessment, selectJourneyContextSteps, nextJourneyStep} from './journey-outcome.mjs';
import {createManagedAgentsClient} from './claude-agents-client.mjs';
import {readJourneyAgents, agentAccountFingerprint} from './journey-agent-config.mjs';
import {JOURNEY_AGENT_MODEL, JOURNEY_AGENT_REVISION} from './journey-agent-definitions.mjs';
import {createOpenAIAgentsClient} from './openai-agents-client.mjs';
import {readOpenAIJourneyAgents, openAIAgentAccountFingerprint, OPENAI_JOURNEY_AGENT_REVISION, OPENAI_AGENT_MODEL} from './openai-agent-config.mjs';
import {JourneyError, JOURNEY_DIMENSIONS, validateJourneyDecision, validateJourneyFollowUp, visibleObservation, imageBlock, continuationContext} from './journey-ai.mjs';
import {normalizeJourneyPersona} from './journey-persona.mjs';
import {normalizeJourneySettings} from './journey-settings.mjs';

const copy = value => structuredClone(value);
const noScores = () => JOURNEY_DIMENSIONS.map(dimension => ({dimension, score: null, reason: 'Not assessed.', evidenceSteps: [], confidence: 0}));
const cancelled = () => new JourneyError('AI_CANCELLED', 'The journey agent request was cancelled.');
function translate(error) {
  if (error instanceof JourneyError) return error;
  // Transport messages are deliberately sanitized. Never surface arbitrary tool
  // or provider content through the journey's error path.
  return new JourneyError(error?.code || 'AGENT_SERVICE', error?.name === 'ManagedAgentError' ? error.message : 'The AI provider could not complete this agent request. The saved steps remain available.');
}
function textContent(value, key) {
  const text = JSON.stringify(value);
  if (text.includes(key) || text.length > 450000) throw new JourneyError('JOURNEY_INPUT', 'The journey context is too large or contains credentials. No request was sent.');
  return [{type: 'text', text}];
}
function observationContent(value, key) {
  const content = textContent(value, key);
  if (value.screenshot) throw new Error('Screenshots must be separate from observation text.');
  return content;
}
function historyContext(history) {
  return history.map(step => ({index: step.index, action: step.action, reason: step.reason, result: step.result, executionStatus: step.executionStatus, executionError: step.executionError || '',
    observation: visibleObservation({...step.observation, controls: []}, 2000),
    actionTarget: step.observation.controls?.find(control => control.id === step.action?.targetId)?.label || null}));
}
// Only evidence actually delivered to this evaluator session can support a
// citation. A saved ledger is available to fetch, but is not itself model input.
function evaluatorEvidence(metadata, sessionId, steps, supplied) {
  const recorded = new Set(steps.map(step => step.index));
  const prior = metadata.evaluatorEvidenceSessionId === sessionId && Array.isArray(metadata.evaluatorEvidenceSteps) ? metadata.evaluatorEvidenceSteps : [];
  return new Set([...prior, ...supplied.map(step => step.index)].filter(index => Number.isSafeInteger(index) && recorded.has(index)));
}
function evidenceMetadata(sessionId, availableEvidence) {
  return {evaluatorEvidenceSessionId: sessionId, evaluatorEvidenceSteps: [...availableEvidence].sort((a, b) => a - b)};
}
function toolResult(toolUseId, content, isError = false) {
  return {type: 'user.custom_tool_result', custom_tool_use_id: toolUseId, content, is_error: isError};
}
function checkBudget(value) {
  if (!Number.isFinite(value) || value < .1 || value > 20) throw new JourneyError('AGENT_BUDGET', 'Choose a journey budget between $0.10 and $20 in AI settings.');
  const cents = Math.round(value * 100);
  return {actor: Math.floor(cents * .75) / 100, evaluator: (cents - Math.floor(cents * .75)) / 100};
}
function assertToolInput(input, key) {
  if (!input || typeof input !== 'object' || JSON.stringify(input).includes(key)) throw new JourneyError('JOURNEY_OUTPUT', 'The agent returned an invalid result. No action was performed.');
}

// Reserve a single evaluator session for both assessment and discussion. A lost
// creation response must not grant a second spending allowance on the next Send.
async function createEvaluatorSession({client, agent, environmentId, budgetUsd, signal, save, initialContent}) {
  try { await save({evaluatorSessionCreationPending: true, ...(initialContent ? {evaluatorRequestInFlight: true} : {})}); }
  catch (error) {
    // No provider request has been made yet. Clear the in-memory intent too,
    // so later run finalization cannot persist a reservation that never began.
    await save({evaluatorSessionCreationPending: false}).catch(() => {});
    throw error;
  }
  try {
    const result = await client.createSession({agentId: agent.id, agentVersion: agent.version, environmentId, budgetUsd, signal, ...(initialContent ? {initialContent} : {})});
    await save({evaluatorSessionId: result.id, evaluatorSessionCreationPending: false, evaluatorSessionCreationUncertain: false});
    return result.id;
  } catch (error) {
    const uncertain = error.ambiguous === true || !error.status || error.status >= 500;
    await save({evaluatorSessionCreationPending: false, evaluatorSessionCreationUncertain: uncertain}).catch(() => {});
    throw error;
  }
}

export async function createManagedJourneyDriver({config, onMetadata = async () => {}, client, agents} = {}) {
  const provider = config.provider || 'anthropic', openai = provider === 'openai';
  if (!['anthropic', 'openai'].includes(provider)) throw new JourneyError('AI_PROVIDER', 'Choose Anthropic or OpenAI in AI settings.');
  const model = openai ? OPENAI_AGENT_MODEL : JOURNEY_AGENT_MODEL, revision = openai ? OPENAI_JOURNEY_AGENT_REVISION : JOURNEY_AGENT_REVISION;
  const consoleName = openai ? 'OpenAI Platform' : 'Claude Console';
  client ||= openai ? createOpenAIAgentsClient({apiKey: config.apiKey}) : createManagedAgentsClient({apiKey: config.apiKey});
  agents ||= await (openai ? readOpenAIJourneyAgents : readJourneyAgents)(config.apiKey);
  if (!agents.ready) throw new JourneyError('AGENT_SETUP', 'Open Settings → AI → Journey testing and set up the selected provider’s agents first.');
  if ((agents.provider && agents.provider !== provider) || (agents.revision && agents.revision !== revision) || (agents.model && agents.model !== model)) {
    throw new JourneyError('AGENT_SETUP', 'Update the journey agents in AI settings before starting a new attempt. Earlier attempts keep their original evaluator.');
  }
  const budget = checkBudget(config.journeyBudgetUsd ?? 2);
  let metadata = {engine: 'managed', provider, revision, model, effort: 'max', account: agents.account,
    budgetUsd: config.journeyBudgetUsd ?? 2, evaluatorStatus: 'not-started', evaluatorAgent: copy(agents.evaluator), environmentId: agents.environmentId,
    evaluatorReservationVersion: 1};
  let closed = false, pending = null, queue = Promise.resolve();
  const busy = {actor: false, evaluator: false};
  const lifetime = new AbortController();
  const save = async update => { metadata = {...metadata, ...update}; await onMetadata(copy(metadata)); };
  const ensureOpen = signal => { if (closed || signal?.aborted) throw cancelled(); };
  const newSession = async (role, initialContent) => {
    if (role === 'evaluator') {
      if (metadata.evaluatorSessionCreationPending || metadata.evaluatorSessionCreationUncertain) throw new JourneyError('AGENT_SESSION', `The provider has not confirmed evaluator setup. Check the session in ${consoleName} before retrying; no second spending allowance was created.`);
      return createEvaluatorSession({client, agent: agents.evaluator, environmentId: agents.environmentId, budgetUsd: budget.evaluator, signal: lifetime.signal, save, ...(openai ? {initialContent} : {})});
    }
    const result = await client.createSession({agentId: agents[role].id, agentVersion: agents[role].version, environmentId: agents.environmentId,
      budgetUsd: budget[role], signal: lifetime.signal, ...(openai ? {initialContent} : {})});
    await save({[`${role}SessionId`]: result.id});
    return result.id;
  };
  async function evaluate(args, actorDecision) {
    ensureOpen(args.signal);
    // A pause never grants another budget. Reuse the same evaluator session
    // and pinned agent for the entire attempt, including reconsidered finishes.
    if (metadata.evaluatorInterrupted) throw new JourneyError('AGENT_SESSION', 'The separate evaluation was interrupted. Start a new journey to evaluate a new attempt.');
    let sessionId = metadata.evaluatorSessionId;
    const creatingSession = !sessionId;
    await save({evaluatorStatus: 'reviewing'});
    const index = nextJourneyStep(args.history);
    const steps = [...args.history, {index, observation: args.observation, ...actorDecision}];
    const context = selectJourneyContextSteps(steps, {max: 40});
    const targetAssessment = journeyTargetAssessment({status: actorDecision.action.outcome, steps: args.history, actionTarget: args.actionTarget, continuation: args.continuation});
    const payload = {targetAssessment, contextCoverage: {totalSteps: context.totalSteps, omittedStepCount: context.omittedStepCount}, request: 'Evaluate this recorded attempt with journey_assessment. The action target is a separate measured benchmark; do not conflate it with UX scores. Ask journey_evidence for omitted steps if needed.', goal: args.goal, successCriteria: args.successCriteria,
      persona: normalizeJourneyPersona(args.persona), ...normalizeJourneySettings(args), actorOutcome: actorDecision.action,
      ...continuationContext(args.continuation || null, args.priorJourney || null),
      steps: historyContext(context.steps), screenshotStep: index};
    const content = textContent(payload, config.apiKey);
    if (args.observation.screenshot) content.push(imageBlock(args.observation.screenshot));
    busy.evaluator = true;
    sessionId ||= await newSession('evaluator', content);
    const availableEvidence = evaluatorEvidence(metadata, sessionId, steps, context.steps);
    const events = metadata.evaluatorPendingToolId ? [toolResult(metadata.evaluatorPendingToolId, content)] : [{type: 'user.message', content}];
    await save({evaluatorRequestInFlight: true, evaluatorPendingToolId: null});
    if (!openai || !creatingSession) await client.sendEvents(sessionId, events, {signal: lifetime.signal});
    await save(evidenceMetadata(sessionId, availableEvidence));
    const result = await waitWithEvidence({client, sessionId, toolName: 'journey_assessment', steps, availableEvidence, apiKey: config.apiKey,
      signal: lifetime.signal, after: metadata.evaluatorCursor, save: update => save(update)});
    busy.evaluator = false;
    await save({evaluatorCursor: result.cursor, evaluatorPendingToolId: result.toolUseId, evaluatorRequestInFlight: false});
    assertToolInput(result.input, config.apiKey);
    const decision = validateJourneyDecision(result.input, {observation: args.observation, history: args.history.filter(step => availableEvidence.has(step.index))});
    if (decision.action.type !== 'finish' ||
        (actorDecision.action.outcome !== 'completed' && decision.action.outcome === 'completed') ||
        (actorDecision.action.outcome === 'blocked' && decision.action.outcome !== 'blocked' && decision.action.outcome !== 'failed')) {
      throw new JourneyError('JOURNEY_OUTPUT', 'The evaluator returned an unsupported outcome. The original attempt is retained.');
    }
    if (decision.action.outcome === 'blocked' && !decision.action.helpQuestion) decision.action.helpQuestion = actorDecision.action.helpQuestion;
    await save({evaluatorStatus: 'complete', evaluatorCursor: result.cursor, evaluatorPendingToolId: result.toolUseId});
    ensureOpen(args.signal);
    return {action: decision.action, reason: actorDecision.reason};
  }
  async function decide(args) {
    ensureOpen(args.signal);
    const currentStep = nextJourneyStep(args.history);
    let sessionId = metadata.actorSessionId;
    const creatingSession = !sessionId;
    ensureOpen(args.signal);
    const observationToken = crypto.randomUUID();
    const context = selectJourneyContextSteps(args.history, {max: 24});
    const payload = {actionTarget: args.actionTarget ?? 20, targetGuidance: 'Action target is a scoring benchmark, not a stopping rule. Continue beyond it to verify the goal.', contextCoverage: {totalSteps: context.totalSteps, omittedStepCount: context.omittedStepCount}, currentStep, observationToken, goal: args.goal, successCriteria: args.successCriteria || '', testData: args.testData || '',
      persona: normalizeJourneyPersona(args.persona), ...normalizeJourneySettings(args), routePreferences: args.routePreferences || '',
      ...continuationContext(args.continuation || null, args.priorJourney || null),
      observation: visibleObservation(args.observation),
      // The persistent session keeps earlier screenshots. The explicit ledger
      // also makes actual execution (including interruption) authoritative.
      history: historyContext(context.steps)};
    const content = observationContent(payload, config.apiKey);
    if (args.observation.screenshot) content.push(imageBlock(args.observation.screenshot));
    busy.actor = true;
    sessionId ||= await newSession('actor', content);
    if (pending) {
      const executed = args.history.find(step => step.index === pending.step && step.action?.type !== 'finish');
      content.unshift(...textContent({previousProposal: executed ? {executionStatus: executed.executionStatus, result: executed.result}
        : {executionStatus: 'not-executed', reason: 'The proposal was paused or interrupted. Reconsider using the fresh observation.'}}, config.apiKey));
      await client.sendEvents(sessionId, [toolResult(pending.toolUseId, content)], {signal: lifetime.signal});
      pending = null;
    } else if (!openai || !creatingSession) await client.sendEvents(sessionId, [{type: 'user.message', content}], {signal: lifetime.signal});
    const result = await client.waitForTool(sessionId, {after: metadata.actorCursor, toolNames: ['journey_step'], signal: lifetime.signal, timeoutMs: 240000});
    busy.actor = false;
    // Pause cancels the runner's wait, not this bookkeeping. Capture any pending
    // proposal, then refuse to execute it until a new observation is supplied.
    pending = {toolUseId: result.toolUseId, step: currentStep};
    await save({actorCursor: result.cursor, actorPendingToolId: result.toolUseId});
    ensureOpen(args.signal); assertToolInput(result.input, config.apiKey);
    if (result.input.observationStep !== currentStep || result.input.observationToken !== observationToken || Object.keys(result.input).some(key => !['action', 'reason', 'observationStep', 'observationToken'].includes(key))) {
      throw new JourneyError('JOURNEY_OUTPUT', 'The agent used an outdated observation. No action was performed.');
    }
    const input = {action: copy(result.input.action), reason: result.input.reason};
    if (input.action?.type === 'finish') {
      if (!['completed', 'blocked', 'inconclusive'].includes(input.action.outcome) || 'findings' in input.action || 'scores' in input.action) throw new JourneyError('JOURNEY_OUTPUT', 'The journey agent returned an invalid completion.');
      input.action.findings = []; input.action.scores = noScores();
    }
    const decision = validateJourneyDecision(input, {observation: args.observation, history: args.history});
    if (decision.action.type !== 'finish') return decision;
    await save({actorOutcome: copy(decision.action)});
    try { return await evaluate(args, decision); }
    catch (error) {
      // Keep a completed assessment through a pause. Its tool result remains
      // pending until the next freshly observed request, without a second run.
      if (metadata.evaluatorStatus !== 'complete') {
        if (busy.evaluator && metadata.evaluatorSessionId) {
          await client.interrupt(metadata.evaluatorSessionId).catch(() => {});
          busy.evaluator = false;
          await save({evaluatorInterrupted: true, evaluatorPendingToolId: null});
        }
        await save({evaluatorStatus: 'unavailable', evaluatorError: translate(error).message, evaluatorBudgetExhausted: error.code === 'AGENT_BUDGET'});
      }
      ensureOpen(args.signal);
      return decision; // A failed evaluation never discards the recorded attempt.
    }
  }
  return {
    get metadata() { return copy(metadata); },
    decide(args) {
      const task = queue.catch(() => {}).then(() => decide(args)).catch(error => { throw translate(error); });
      queue = task;
      return task;
    },
    async close() {
      closed = true; lifetime.abort();
      // A custom-tool handoff is idle and costs no further inference. Preserve
      // it for chat; interrupt only work that is still in flight on Stop/error.
      await Promise.allSettled(['actor', 'evaluator'].filter(role => busy[role] && metadata[`${role}SessionId`]).map(role => client.interrupt(metadata[`${role}SessionId`])));
      // Finish all metadata writes before the service saves the final movie.
      // Without draining, a late evaluation failure could replace that record.
      await queue.catch(() => {});
      if (metadata.evaluatorStatus !== 'complete') await save({evaluatorStatus: 'unavailable',
        evaluatorError: metadata.evaluatorError || 'This attempt ended before a separate evaluation completed. You can still discuss the recorded steps.'});
    },
  };
}

async function waitWithEvidence({client, sessionId, toolName, steps, availableEvidence, apiKey, signal, after, save}) {
  let cursor = after;
  for (let reads = 0; reads <= 8; reads++) {
    const tool = await client.waitForTool(sessionId, {after: cursor, toolNames: [toolName, 'journey_evidence'], signal, timeoutMs: 240000});
    cursor = tool.cursor;
    if (tool.name === toolName) return tool;
    if (reads === 8) throw new JourneyError('AGENT_LIMIT', 'The evaluator reached its evidence-reading limit.');
    assertToolInput(tool.input, apiKey);
    if (Object.keys(tool.input).length !== 1 || !Number.isInteger(tool.input.stepIndex)) throw new JourneyError('JOURNEY_OUTPUT', 'The evaluator requested invalid evidence.');
    const step = steps.find(item => item.index === tool.input.stepIndex);
    const content = step ? textContent(historyContext([step])[0], apiKey) : textContent({error: 'This step was not recorded.'}, apiKey);
    if (step?.observation?.screenshot) content.push(imageBlock(step.observation.screenshot));
    else content.push({type: 'text', text: 'No screenshot is retained for this step.'});
    await client.sendEvents(sessionId, [toolResult(tool.toolUseId, content, !step)], {signal});
    if (step) availableEvidence.add(step.index);
    await save({evaluatorCursor: cursor, ...evidenceMetadata(sessionId, availableEvidence)});
  }
  throw new JourneyError('AGENT_LIMIT', 'The evaluator reached its evidence-reading limit.');
}

export async function requestManagedJourneyFollowUp({apiKey, provider = 'anthropic', run, question, stepIndex, signal, onMetadata = async () => {}, client, resolveAgents}) {
  let metadata = copy(run.managed);
  if ((metadata?.provider || run.provider || 'anthropic') !== provider) throw new JourneyError('AI_PROVIDER', 'Switch back to this journey’s original AI provider in Settings before discussing its saved steps.');
  const openai = provider === 'openai', consoleName = openai ? 'OpenAI Platform' : 'Claude Console';
  const fingerprint = openai ? openAIAgentAccountFingerprint : agentAccountFingerprint;
  if (!metadata || metadata.account !== await fingerprint(apiKey)) throw new JourneyError('AGENT_SESSION', `Use the same ${openai ? 'OpenAI' : 'Anthropic'} API key as this journey to discuss its saved steps.`);
  client ||= openai ? createOpenAIAgentsClient({apiKey}) : createManagedAgentsClient({apiKey});
  resolveAgents ||= openai ? readOpenAIJourneyAgents : readJourneyAgents;
  if (!metadata.evaluatorSessionId && metadata.evaluatorReservationVersion !== 1 && metadata.actorOutcome) throw new JourneyError('AGENT_SESSION', 'This older journey attempted an evaluation but did not save its session identifier. Check Claude Console before continuing; no second spending allowance was created.');
  if (metadata.evaluatorSessionCreationPending || metadata.evaluatorSessionCreationUncertain) throw new JourneyError('AGENT_SESSION', `The provider has not confirmed evaluator setup. Check the session in ${consoleName}; no second spending allowance was created.`);
  if (metadata.evaluatorBudgetExhausted || /budget|spending|cost limit/i.test(metadata.evaluatorError || '')) throw new JourneyError('AGENT_BUDGET', 'This journey’s evaluator reached its spending limit. Its saved steps remain available; no additional budget was started.');
  if (metadata.evaluatorInterrupted || metadata.evaluatorRequestInFlight) throw new JourneyError('AGENT_SESSION', `The evaluator’s last request was interrupted or its result is unconfirmed. Check the session in ${consoleName} before continuing. Your recorded steps are still available.`);
  if (!['completed', 'failed', 'blocked', 'inconclusive', 'stopped'].includes(run.status)) throw new JourneyError('JOURNEY_INPUT', 'Pause or finish browser actions before discussing this recorded attempt.');
  if (typeof question !== 'string' || !question.trim() || question.length > 2000 || !Array.isArray(run.steps)  ||
      (stepIndex !== undefined && !run.steps.some(step => step.index === stepIndex))) throw new JourneyError('JOURNEY_INPUT', 'Choose an existing journey step and ask a question under 2,000 characters.');
  const save = async update => { metadata = {...metadata, ...update}; await onMetadata(copy(metadata)); };
  const context = selectJourneyContextSteps(run.steps, {selectedStep: stepIndex, max: 40});
  const payload = {contextCoverage: {totalSteps: context.totalSteps, omittedStepCount: context.omittedStepCount}, request: 'Answer this follow-up with journey_answer. Do not operate the browser. Use the explicit stopReason and recording details when explaining a stop; never infer a step cutoff from action count. The targetAssessment is a separate measured AI-action benchmark, not a UX score. Ask journey_evidence for omitted steps if needed.', question: question.trim(), selectedStep: stepIndex ?? null,
    goal: run.goal, successCriteria: run.successCriteria || '', persona: normalizeJourneyPersona(run.persona), ...journeyOutcomeContext(run), assistance: run.assistance || null,
    evaluation: {status: metadata.evaluatorStatus, completed: metadata.evaluatorStatus === 'complete',
      limitation: metadata.evaluatorStatus === 'complete' ? '' : 'No separate usability assessment completed. Explain only what the saved evidence supports; do not invent scores or a missing stop reason.'},
    steps: historyContext(context.steps), followUps: run.followUps || []};
  const content = textContent(payload, apiKey);
  const screenshot = run.steps.find(step => step.index === stepIndex)?.observation?.screenshot;
  if (screenshot) content.push(imageBlock(screenshot));
  let sessionId = metadata.evaluatorSessionId;
  const creatingSession = !sessionId;
  if (!sessionId) {
    // Older 0.17.0 runs did not save the pinned definition. Resolve only the
    // matching account/revision, never silently use another model or account.
    let agent = metadata.evaluatorAgent, environmentId = metadata.environmentId;
    if (!agent || !environmentId) {
      const agents = await resolveAgents(apiKey, {revision: metadata.revision});
      if (!agents.ready || agents.account !== metadata.account || agents.revision !== metadata.revision) throw new JourneyError('AGENT_SETUP', 'The original evaluator configuration is unavailable. Check the journey agents in AI settings.');
      agent = agents.evaluator; environmentId = agents.environmentId;
    }
    const budget = checkBudget(metadata.budgetUsd);
    if (!agent?.id || !Number.isInteger(agent.version) || agent.version < 1 || !environmentId) throw new JourneyError('AGENT_SETUP', 'The saved evaluator configuration is incomplete. Check the journey agents in AI settings.');
    if (signal?.aborted) throw cancelled();
    await save({evaluatorAgent: copy(agent), environmentId, evaluatorReservationVersion: 1});
    try { sessionId = await createEvaluatorSession({client, agent, environmentId, budgetUsd: budget.evaluator, signal, save, ...(openai ? {initialContent: content} : {})}); }
    catch (error) { throw translate(error); }
  }
  const availableEvidence = evaluatorEvidence(metadata, sessionId, run.steps, context.steps);
  let started = false, received = false;
  try {
    const events = metadata.evaluatorPendingToolId ? [toolResult(metadata.evaluatorPendingToolId, content)] : [{type: 'user.message', content}];
    // Persist intent before the network mutation. A worker shutdown or a lost
    // acknowledgement must never replay an old custom-tool result on retry.
    await save({evaluatorRequestInFlight: true, evaluatorPendingToolId: null});
    started = true;
    if (!openai || !creatingSession) await client.sendEvents(sessionId, events, {signal});
    await save(evidenceMetadata(sessionId, availableEvidence));
    const tool = await waitWithEvidence({client, sessionId, toolName: 'journey_answer', steps: run.steps, availableEvidence, apiKey, signal, after: metadata.evaluatorCursor, save});
    received = true;
    await save({evaluatorCursor: tool.cursor, evaluatorPendingToolId: tool.toolUseId, evaluatorRequestInFlight: false});
    assertToolInput(tool.input, apiKey);
    const answer = validateJourneyFollowUp(tool.input, {...run, steps: run.steps.filter(step => availableEvidence.has(step.index))});
    await save({evaluatorCursor: tool.cursor, evaluatorPendingToolId: tool.toolUseId});
    return answer;
  } catch (error) {
    if (started && !received) {
      await client.interrupt(sessionId).catch(() => {});
      await save({evaluatorInterrupted: true, evaluatorPendingToolId: null, evaluatorBudgetExhausted: error.code === 'AGENT_BUDGET', evaluatorError: translate(error).message}).catch(() => {});
    }
    throw translate(error);
  }
}
