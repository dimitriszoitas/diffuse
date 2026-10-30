import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyTargetAssessment, journeyOutcomeContext, selectJourneyContextSteps, nextJourneyStep} from '../extension/journey-outcome.mjs';

test('the action target affects a completed attempt score without changing its outcome', () => {
  const run = {status: 'completed', actionTarget: 20, metrics: {actions: 25}, scores: [{dimension: 'clarity', score: 4}]};
  const before = structuredClone(run);
  assert.deepEqual(journeyTargetAssessment(run), {actionTarget: 20, actionCount: 25, overBy: 5, withinTarget: false, efficiencyScore: 80, verifiedComplete: true, scope: 'journey'});
  assert.deepEqual(run, before);
  for (const actions of [1, 10, 20]) assert.equal(journeyTargetAssessment({...run, metrics: {actions}}).efficiencyScore, 100);
  assert.equal(journeyTargetAssessment({...run, metrics: {actions: 30}}).efficiencyScore, 67);
});

test('incomplete and zero-action attempts never receive an efficiency score', () => {
  for (const status of ['running', 'paused', 'stopped', 'blocked', 'failed', 'inconclusive']) {
    const result = journeyTargetAssessment({status, actionTarget: 20, metrics: {actions: 10}});
    assert.equal(result.efficiencyScore, null);
    assert.equal(result.verifiedComplete, false);
  }
  assert.equal(journeyTargetAssessment({status: 'completed', metrics: {actions: 0}}).efficiencyScore, null);
});

test('legacy targets, missing metrics and continuation scope remain explicit', () => {
  const run = {status: 'completed', maxSteps: 30, steps: [
    {action: {type: 'click'}, executionStatus: 'complete'}, {action: {type: 'scroll'}, executionStatus: 'error'},
    {action: null}, {action: {type: 'finish'}},
  ]};
  assert.equal(journeyTargetAssessment(run).actionCount, 2, 'Recorded attempts include a failed action.');
  assert.equal(journeyTargetAssessment(run).actionTarget, 30);
  assert.equal(journeyTargetAssessment({...run, actionTarget: 12}).actionTarget, 12);
  assert.equal(journeyTargetAssessment({input: {maxSteps: 25}}).actionTarget, 25);
  assert.equal(journeyTargetAssessment({}).actionTarget, 20);
  assert.equal(journeyTargetAssessment({...run, continuation: {parentRunId: 'parent'}}).scope, 'segment');
  assert.equal(journeyTargetAssessment({...run, fork: {parentRunId: 'parent'}}).scope, 'journey');
  for (const actionTarget of [0, -1, 501, Infinity, '20']) assert.equal(journeyTargetAssessment({actionTarget}).actionTarget, 20);
});

test('outcome context keeps the authoritative ending and omits video contents', () => {
  const run = {status: 'blocked', summary: 'Return to the original tab.', stopReason: {source: 'browser', code: 'JOURNEY_BLOCKED', message: 'Return to the original tab.'},
    error: 'The tab lost focus.', metrics: {actions: 20}, actionTarget: 30,
    video: {stopReason: 'manual', dataUrl: 'data:video/webm;base64,private', bytes: 42, durationMs: 202000}, recording: {status: 'saved'}};
  const result = journeyOutcomeContext(run);
  assert.deepEqual(result.stopReason, run.stopReason);
  assert.equal(result.summary, run.summary);
  assert.equal(result.error, run.error);
  assert.deepEqual(result.metrics, run.metrics);
  assert.deepEqual(result.recording, {status: 'saved', stopReason: 'manual', message: '', partial: false, bytes: 42, durationMs: 202000});
  assert.equal(JSON.stringify(result).includes('base64'), false);
  result.stopReason.message = 'Changed';
  assert.equal(run.stopReason.message, 'Return to the original tab.', 'Returned metadata does not alias the saved run.');
});

test('an older generic recording ending is explained only by an explicit saved cause', () => {
  const run = {status: 'inconclusive', summary: 'The recording ended before the journey finished. Review the captured steps and video; the task outcome was not verified.', metrics: {actions: 20}, maxSteps: 30};
  for (const [reason, code] of [['size-limit', 'JOURNEY_RECORDING_SIZE_LIMIT'], ['time-limit', 'JOURNEY_RECORDING_TIME_LIMIT'], ['capture-ended', 'JOURNEY_CAPTURE_ENDED'], ['capture-error', 'JOURNEY_CAPTURE_ERROR']]) {
    const result = journeyOutcomeContext({...run, video: {stopReason: reason, durationMs: 202000}});
    assert.equal(result.stopReason.code, code);
    assert.equal(result.stopReason.source, 'recording');
    assert.equal(result.summary, run.summary, 'Preserve the original summary.');
  }
  for (const stopReason of [undefined, 'manual', 'unknown', '<script>not a cause</script>']) {
    const result = journeyOutcomeContext({...run, video: {stopReason, durationMs: 600000}});
    assert.equal(result.stopReason, '', 'Duration and completed actions cannot establish a cause.');
  }
  assert.equal(journeyOutcomeContext({...run, summary: 'Stopped after 20 actions.', video: {stopReason: 'size-limit'}}).stopReason, '');
  const explicit = {source: 'browser', code: 'TAB_CLOSED', message: 'The reviewed tab closed.'};
  assert.deepEqual(journeyOutcomeContext({...run, stopReason: explicit, video: {stopReason: 'size-limit'}}).stopReason, explicit);
});

test('partial recordings are separate from the final journey outcome', () => {
  const notice = 'The video reached its size limit. The journey continues with screenshots and notes; the video covers only the earlier steps.';
  const result = journeyOutcomeContext({status: 'completed', summary: 'The new record is visible.', metrics: {actions: 40}, recordingNotice: notice,
    recording: {status: 'saved', stopReason: 'size-limit', partial: true}});
  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, '');
  assert.equal(result.recording.stopReason, 'size-limit');
  assert.equal(result.recording.message, notice);
  assert.equal(result.recording.partial, true);
  assert.equal(journeyOutcomeContext({recordingNotice: {reason: 'capture-error', message: 'Capture failed.'}}).recording.stopReason, 'capture-error');
});

test('large journey contexts retain the selected step, start, recent evidence and errors without modifying the ledger', () => {
  const steps = Array.from({length: 1000}, (_, index) => ({index: index + 1, action: {type: 'click'}, executionStatus: 'complete'}));
  steps[299].executionStatus = 'error'; steps[399].executionStatus = 'interrupted';
  steps[499].action = {type: 'finish'};
  const before = structuredClone(steps);
  const result = selectJourneyContextSteps(steps, {selectedStep: 70});
  assert.equal(result.steps.length, 32);
  assert.equal(result.totalSteps, 1000);
  assert.equal(result.omittedStepCount, 968);
  const indexes = result.steps.map(step => step.index);
  for (const index of [1, 2, 3, 4, 70, 300, 400, 500, ...Array.from({length: 20}, (_, index) => index + 981)]) assert.ok(indexes.includes(index), `Include ${index}`);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  assert.deepEqual(steps, before);
  assert.equal(result.steps.find(step => step.index === 70), steps[69]);
});

test('context selection handles small and empty ledgers and honors a smaller bound', () => {
  const steps = Array.from({length: 4}, (_, index) => ({index: index + 1}));
  assert.deepEqual(selectJourneyContextSteps(steps), {steps, totalSteps: 4, omittedStepCount: 0});
  assert.deepEqual(selectJourneyContextSteps(undefined), {steps: [], totalSteps: 0, omittedStepCount: 0});
  assert.deepEqual(selectJourneyContextSteps(steps, {selectedStep: 4, max: 1}).steps, [steps[3]]);
  assert.equal(selectJourneyContextSteps(steps, {max: 0}).omittedStepCount, 4);
});

test('next step indexes support large, sparse ledgers without spreading an array', () => {
  assert.equal(nextJourneyStep(), 1);
  assert.equal(nextJourneyStep([{index: 4}, {index: 2}, {index: 70}]), 71);
  assert.equal(nextJourneyStep(Array.from({length: 150000}, (_, index) => ({index: index + 1}))), 150001);
  assert.equal(nextJourneyStep([{index: '50'}, {index: NaN}, {index: -10}, null, {index: 5}]), 6);
});
