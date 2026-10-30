import {journeyTargetAssessment} from './journey-outcome.mjs';
import {JourneyError, validateJourneyDecision, journeyControlBounds, journeyControlScroll} from './journey-ai.mjs';
import {journeyAssistance} from './journey-assistance.mjs';
import {journeyExecutionFailure} from './journey-executor.mjs';

const ACTIVE = new Set(['running', 'paused']);
const MAX_EVIDENCE_BYTES = 24 * 1024 * 1024;
const clone = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const cancelled = () => new JourneyError('JOURNEY_CANCELLED', 'The journey was interrupted.');

function interruptible(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function inputText(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new JourneyError('JOURNEY_INPUT', 'Enter a journey goal and keep each instruction field under 4,000 characters.');
  return value.trim();
}
function cleanObservation(value) {
  if (!value || typeof value.url !== 'string' || value.url.length > 2048 || !Array.isArray(value.controls) || value.controls.length > 250) throw new JourneyError('JOURNEY_OBSERVATION', 'Could not read the page to continue this journey.');
  let url;
  try { url = new URL(value.url); } catch { throw new JourneyError('JOURNEY_OBSERVATION', 'The observed page address is invalid.'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new JourneyError('JOURNEY_BLOCKED', 'This page cannot be reviewed by a journey.');
  const result = {
    url: value.url, title: String(value.title || '').slice(0, 300), text: String(value.text || '').slice(0, 16000),
    controls: value.controls.map(control => ({
      id: String(control.id || '').slice(0, 120), role: String(control.role || '').slice(0, 60), label: String(control.label || '').slice(0, 300),
      ...(control.type ? {type: String(control.type).slice(0, 40)} : {}),
      ...(control.disabled === true ? {disabled: true} : {}),
      ...(control.blockedReason ? {blockedReason: String(control.blockedReason).slice(0, 300)} : {}),
      ...(typeof control.checked === 'boolean' ? {checked: control.checked} : {}),
      ...journeyControlBounds(control.bounds),
      ...journeyControlScroll(control.scroll),
      ...(!['password', 'file'].includes(control.type) && control.value !== undefined ? {value: String(control.value).slice(0, 2000)} : {}),
      ...(Array.isArray(control.options) ? {options: control.options.slice(0, 100).map(option => typeof option === 'string' ? option.slice(0, 500) : {value: String(option.value || '').slice(0, 500), label: String(option.label || '').slice(0, 300)})} : {}),
    })),
  };
  if (new Set(result.controls.map(control => control.id)).size !== result.controls.length || result.controls.some(control => !control.id)) throw new JourneyError('JOURNEY_OBSERVATION', 'The page controls could not be identified reliably.');
  if (value.screenshot?.dataUrl?.length <= 8 * 1024 * 1024) result.screenshot = clone(value.screenshot);
  if (value.context && typeof value.context === 'object') {
    // Only small JSON context from the executor is retained; never functions or
    // arbitrary page objects. The AI client uses only rendered text and controls.
    const serialized = JSON.stringify(value.context);
    if (serialized.length <= 4000) result.context = JSON.parse(serialized);
  }
  return result;
}

function fingerprint(observation) {
  // Control IDs can be regenerated on every observation, so compare visible
  // control identity and values instead. Screenshots/video pixels can animate.
  return JSON.stringify([observation.url, observation.text, observation.context?.scroll,
    observation.controls.map(({role, label, type, value, checked, scroll}) => [role, label, type, value, checked, scroll?.x, scroll?.y])]);
}

export function createJourneyRunner({observe, execute, decide, onUpdate = () => {}, maxDurationMs = null} = {}) {
  if (![observe, execute, decide, onUpdate].every(value => typeof value === 'function')) throw new TypeError('Journey runner requires observe, execute and decide functions.');
  let state = null, controller = null, generation = 0, wake = null, activePromise = null, deadlineTimer = null, updates = Promise.resolve(), persistenceError = null;
  let lastFingerprint = null, unchanged = 0, previousUrl = null, startedAt = 0, lastObservedActions = 0;
  const getState = () => state ? clone(state) : null;
  const notify = () => {
    state.updatedAt = stamp();
    state.metrics.elapsedMs = Math.max(0, Date.now() - startedAt);
    state.targetAssessment = journeyTargetAssessment(state);
    const snapshot = getState();
    updates = updates.then(() => {
      if (!persistenceError) return onUpdate(snapshot);
    }).catch(() => {
      persistenceError = new JourneyError('JOURNEY_STORAGE', 'Diffuse could not save the journey evidence. The run stopped before performing more actions.');
      state.status = 'inconclusive'; state.summary = persistenceError.message;
      state.stopReason = {source: 'storage', code: 'JOURNEY_STORAGE', message: persistenceError.message};
      state.targetAssessment = journeyTargetAssessment(state);
      state.updatedAt = stamp(); generation++; controller?.abort(); wake?.(); wake = null;
    });
    return updates;
  };
  const finish = (status, summary, reason) => {
    if (!state || !ACTIVE.has(state.status)) return;
    state.status = status; state.summary = summary;
    state.stopReason = reason || {source: 'runner', code: 'JOURNEY_INTERRUPTED', message: summary};
    state.updatedAt = stamp();
    if (status === 'blocked') state.assistance = journeyAssistance(state);
    generation++; controller?.abort(); wake?.(); wake = null; notify();
  };
  const pause = () => {
    if (state?.status !== 'running') return getState();
    state.status = 'paused'; generation++; controller?.abort(); notify(); return getState();
  };
  const resume = () => {
    if (state?.status !== 'paused') return getState();
    state.status = 'running'; generation++; wake?.(); wake = null; notify(); return getState();
  };
  const stop = () => {
    const message = 'Stopped by the reviewer. The task outcome was not verified.';
    finish('stopped', message, {source: 'reviewer', code: 'JOURNEY_STOPPED', message});
    return getState();
  };
  function retainEvidence() {
    let bytes = state.steps.reduce((total, step) => total + (step.observation.screenshot?.dataUrl?.length || 0), 0);
    for (const step of state.steps) {
      if (bytes <= MAX_EVIDENCE_BYTES) break;
      bytes -= step.observation.screenshot?.dataUrl?.length || 0;
      if (step.observation.screenshot) { delete step.observation.screenshot; step.evidenceOmitted = true; }
    }
  }
  function countObservation(observation) {
    if (!state.metrics.pagesVisited.includes(observation.url)) state.metrics.pagesVisited.push(observation.url);
    if (previousUrl !== null && previousUrl !== observation.url) state.metrics.navigations++;
    previousUrl = observation.url;
  }
  function countAction(action) {
    state.metrics.actions++;
    const key = {click: 'clicks', type: 'typing', select: 'selects', scroll: 'scrolls', back: 'backtracks', wait: 'waits'}[action.type];
    if (key) state.metrics[key]++;
  }
  async function loop(input) {
    while (ACTIVE.has(state.status)) {
      await updates;
      if (!ACTIVE.has(state.status)) break;
      if (state.status === 'paused') { await new Promise(resolve => { wake = resolve; }); continue; }
      const version = generation;
      controller = new AbortController();
      const currentController = controller;
      try {
        const observation = cleanObservation(await interruptible(observe({signal: currentController.signal}), currentController.signal));
        if (version !== generation || state.status !== 'running') continue;
        countObservation(observation);
        const nextFingerprint = fingerprint(observation);
        unchanged = nextFingerprint !== lastFingerprint ? 0 : state.metrics.actions > lastObservedActions ? unchanged + 1 : unchanged;
        lastFingerprint = nextFingerprint;
        lastObservedActions = state.metrics.actions;
        // Capture the resulting screen even when a no-progress guard ends
        // the run. This is evidence, not an invented application failure.
        if (unchanged >= 3) {
          state.steps.push({index: state.steps.length + 1, observation, action: null, reason: 'No observed progress after three actions.', result: null, createdAt: stamp()});
          retainEvidence();
          const message = 'Stopped after three actions without an observed page change. This may be an app or automation limitation; the task outcome was not verified.';
          finish('inconclusive', message, {source: 'runner', code: 'JOURNEY_NO_PROGRESS', message, stepIndex: state.steps.length});
          break;
        }
        const decision = validateJourneyDecision(await interruptible(decide({
          goal: input.goal, successCriteria: input.successCriteria, testData: input.testData, actionTarget: input.actionTarget,
          history: clone(state.steps), observation: clone(observation), signal: currentController.signal,
        }), currentController.signal), {observation, history: state.steps});
        if (version !== generation || state.status !== 'running') continue;
        const step = {index: state.steps.length + 1, observation, ...decision, result: null, createdAt: stamp()};
        state.steps.push(step); retainEvidence();
        if (decision.action.type === 'finish') {
          state.findings = decision.action.findings; state.scores = decision.action.scores;
          finish(decision.action.outcome, decision.action.summary, {source: 'agent', code: `JOURNEY_${decision.action.outcome.toUpperCase()}`, message: decision.action.summary, stepIndex: step.index}); break;
        }
        countAction(decision.action); step.executionStatus = 'running'; await notify();
        if (version !== generation || state.status !== 'running') {
          step.executionStatus = 'interrupted';
          state.steps.pop();
          state.metrics.actions--;
          const metric = {click: 'clicks', type: 'typing', select: 'selects', scroll: 'scrolls', back: 'backtracks', wait: 'waits'}[decision.action.type];
          if (metric) state.metrics[metric]--;
          await notify();
          continue;
        }
        try {
          const result = await interruptible(execute(clone(decision.action), clone(observation), {signal: currentController.signal}), currentController.signal);
          if (result !== undefined) {
            // Keep only bounded JSON provided by the trusted executor. Arbitrary
            // thrown page/provider messages never enter saved reports.
            const serialized = JSON.stringify(result);
            if (serialized && serialized.length <= 4000) step.result = JSON.parse(serialized);
          }
          step.executionStatus = 'complete';
        } catch (error) {
          step.executionStatus = currentController.signal.aborted ? 'interrupted' : 'error';
          const failure = journeyExecutionFailure(error);
          if (!currentController.signal.aborted && failure) step.executionError = failure;
          throw error;
        }
        await notify();
      } catch (error) {
        if (version !== generation || currentController.signal.aborted) continue;
        const blocked = error?.code === 'JOURNEY_BLOCKED';
        // Tool failures and model/service errors must never become product bugs.
        const knownError = error instanceof JourneyError;
        const executionFailure = journeyExecutionFailure(error);
        const message = executionFailure?.message || (knownError ? error.message : blocked ? 'The next action needs the reviewer’s attention. The journey was stopped before continuing.' : 'Diffuse could not continue this journey. This is an automation limitation; the task outcome was not verified.');
        const reason = executionFailure || {source: knownError && /^(AI_|AGENT_)/.test(error.code) ? 'agent' : 'runner', code: knownError ? error.code : blocked ? 'JOURNEY_BLOCKED' : 'JOURNEY_INTERRUPTED', message};
        finish(blocked ? 'blocked' : 'inconclusive', message, {...reason,
          ...(state.steps.at(-1)?.executionStatus === 'error' ? {stepIndex: state.steps.at(-1).index} : {})});
      }
    }
    await updates;
    if (persistenceError) throw persistenceError;
    return getState();
  }
  function start(input = {}) {
    if (activePromise) return Promise.reject(new JourneyError('JOURNEY_RUNNING', 'A journey is already running.'));
    let config;
    try {
      const startUrl = inputText(input.startUrl || '', 2048, true);
      const parsed = new URL(startUrl);
      if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('unsupported');
      const actionTarget = input.actionTarget ?? input.maxSteps ?? 20;
      if (!Number.isInteger(actionTarget) || actionTarget < 1 || actionTarget > 500) throw new JourneyError('JOURNEY_INPUT', 'Choose an action target between 1 and 500. This is a scoring target, not a stopping limit.');
      config = {
        id: inputText(input.id || globalThis.crypto.randomUUID(), 120, true), goal: inputText(input.goal, 4000, true),
        successCriteria: inputText(input.successCriteria || '', 4000), testData: inputText(input.testData || '', 4000), startUrl, actionTarget,
      };
    } catch (error) { return Promise.reject(error instanceof JourneyError ? error : new JourneyError('JOURNEY_INPUT', 'Choose a supported starting page for the journey.')); }
    startedAt = Date.now(); previousUrl = null; lastFingerprint = null; unchanged = 0; lastObservedActions = 0; persistenceError = null; generation++;
    state = {
      ...config, status: 'running', steps: [], summary: '', findings: [], scores: [], createdAt: stamp(), updatedAt: stamp(),
      metrics: {actions: 0, clicks: 0, typing: 0, selects: 0, scrolls: 0, backtracks: 0, waits: 0, navigations: 0, pagesVisited: [], elapsedMs: 0},
    };
    notify();
    if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) deadlineTimer = setTimeout(() => {
      const message = 'The journey reached its time limit. The task outcome was not verified.';
      finish('inconclusive', message, {source: 'runner', code: 'JOURNEY_TIME_LIMIT', message});
    }, maxDurationMs);
    activePromise = loop(config).finally(() => { clearTimeout(deadlineTimer); controller = null; activePromise = null; });
    return activePromise;
  }
  return {start, pause, resume, stop, getState};
}
