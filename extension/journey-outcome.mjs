const recordingReasons = new Set(['manual', 'size-limit', 'time-limit', 'capture-ended', 'capture-error']);
const copy = value => value === undefined ? undefined : structuredClone(value);
const text = value => typeof value === 'string' ? value : '';

// This is a transparent comparison with the reviewer's target, not a model's
// usability rating or a measurement of how quickly a person would finish.
export function journeyTargetAssessment(run = {}) {
  const candidate = run.actionTarget ?? run.input?.actionTarget ?? run.maxSteps ?? run.input?.maxSteps ?? 20;
  const actionTarget = Number.isInteger(candidate) && candidate >= 1 && candidate <= 500 ? candidate : 20;
  const recorded = run.metrics?.actions;
  const actionCount = Number.isSafeInteger(recorded) && recorded >= 0 ? recorded
    : (Array.isArray(run.steps) ? run.steps : []).reduce((count, step) => count + (step?.action?.type && step.action.type !== 'finish' ? 1 : 0), 0);
  const verifiedComplete = run.status === 'completed';
  return {
    actionTarget, actionCount, overBy: Math.max(0, actionCount - actionTarget), withinTarget: actionCount <= actionTarget,
    efficiencyScore: verifiedComplete && actionCount > 0 ? Math.round(100 * Math.min(1, actionTarget / actionCount)) : null,
    verifiedComplete, scope: run.continuation ? 'segment' : 'journey',
  };
}

function recordingContext(run) {
  const candidates = [run.video?.stopReason, run.recording?.stopReason, run.recordingNotice?.stopReason, run.recordingNotice?.reason, run.recordingNotice];
  const stopReason = candidates.find(value => typeof value === 'string' && recordingReasons.has(value)) || null;
  const recording = {
    status: text(run.recording?.status) || (run.video ? 'saved' : ''), stopReason,
    message: text(run.recordingNotice?.message) || text(run.recordingNotice),
    partial: run.recording?.partial === true,
  };
  for (const field of ['durationMs', 'bytes']) {
    if (Number.isFinite(run.video?.[field]) && run.video[field] >= 0) recording[field] = run.video[field];
  }
  return recording;
}

function legacyRecordingStop(run, recording) {
  const summary = text(run.summary) || text(run.summary?.text);
  if (!/^The recording ended before the journey finished\./i.test(summary.trim())) return null;
  const reasons = {
    'size-limit': ['JOURNEY_RECORDING_SIZE_LIMIT', 'The recording reached its size limit and ended this older journey. The task outcome was not verified.'],
    'time-limit': ['JOURNEY_RECORDING_TIME_LIMIT', 'The recording reached its time limit and ended this older journey. The task outcome was not verified.'],
    'capture-ended': ['JOURNEY_CAPTURE_ENDED', 'Browser video capture ended unexpectedly and ended this older journey. The task outcome was not verified.'],
    'capture-error': ['JOURNEY_CAPTURE_ERROR', 'Video capture failed and ended this older journey. The task outcome was not verified.'],
  };
  const reason = reasons[recording.stopReason];
  return reason ? {source: 'recording', code: reason[0], message: reason[1]} : null;
}

// Keep authoritative termination metadata outside the bounded step selection.
// Old recording-only endings can be explained only when their saved video has
// an explicit cause. Duration and action counts never establish that cause.
export function journeyOutcomeContext(run = {}) {
  const targetAssessment = journeyTargetAssessment(run);
  const recording = recordingContext(run);
  return {
    status: run.status || '', summary: copy(run.summary) ?? '',
    stopReason: copy(run.stopReason) || legacyRecordingStop(run, recording) || '', error: copy(run.error) ?? '',
    metrics: copy(run.metrics) ?? {}, actionTarget: targetAssessment.actionTarget, targetAssessment, recording,
  };
}

// Send a bounded selection, with explicit omission counts, while leaving the
// full saved ledger intact for evidence lookups and exact index validation.
export function selectJourneyContextSteps(steps, {selectedStep, max = 32} = {}) {
  const source = Array.isArray(steps) ? steps : [];
  const limit = Number.isSafeInteger(max) && max >= 0 ? Math.min(max, source.length) : Math.min(32, source.length);
  const selected = new Set();
  const add = position => { if (position >= 0 && position < source.length && selected.size < limit) selected.add(position); };
  if (selectedStep !== undefined) add(source.findIndex(step => step?.index === selectedStep));
  for (let position = 0; position < Math.min(4, source.length); position++) add(position);
  for (let position = Math.max(0, source.length - 20); position < source.length; position++) add(position);
  for (let position = source.length - 1; position >= 0; position--) {
    const step = source[position];
    if (step?.executionStatus === 'error' || step?.executionStatus === 'interrupted' || step?.executionError || step?.action?.type === 'finish') add(position);
  }
  for (let position = source.length - 1; position >= 0 && selected.size < limit; position--) add(position);
  const positions = [...selected].sort((a, b) => {
    const first = Number.isSafeInteger(source[a]?.index) ? source[a].index : a;
    const second = Number.isSafeInteger(source[b]?.index) ? source[b].index : b;
    return first - second || a - b;
  });
  return {steps: positions.map(position => source[position]), omittedStepCount: source.length - positions.length, totalSteps: source.length};
}

export function nextJourneyStep(history = []) {
  return (Array.isArray(history) ? history : []).reduce((highest, step) => Number.isSafeInteger(step?.index) && step.index > highest ? step.index : highest, 0) + 1;
}
