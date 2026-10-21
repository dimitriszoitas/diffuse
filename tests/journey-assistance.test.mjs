import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyAssistance, normalizeJourneyHelpResponse, withJourneyAssistance} from '../extension/journey-assistance.mjs';

const blocked = () => ({id: 'run', status: 'blocked', goal: 'Create an ingredient', summary: 'I cannot find the picker.', updatedAt: '2026-10-22T10:00:00Z',
  findings: [{title: 'Unrelated observed issue'}], scores: [{dimension: 'clarity', score: 3}], steps: [{index: 2, action: {type: 'finish', helpQuestion: 'Where can I find the recipe picker?'}}]});

test('blocked journeys ask a grounded question without changing original evidence or judgments', () => {
  const run = blocked(), original = structuredClone(run), result = withJourneyAssistance(run);
  assert.deepEqual(result.assistance, {question: 'Where can I find the recipe picker?', stepIndex: 2, createdAt: run.updatedAt});
  assert.deepEqual(run, original);
  assert.deepEqual(result.findings, run.findings);
  assert.deepEqual(result.scores, run.scores);
  delete run.steps[0].action.helpQuestion;
  assert.match(journeyAssistance(run).question, /Create an ingredient.*cannot find the picker.*What should I do next/);
  assert.equal(journeyAssistance({...run, status: 'completed'}), null);
  assert.equal(journeyAssistance(null), null);
});

test('help replies require an explicit bounded classification and decision', () => {
  assert.deepEqual(normalizeJourneyHelpResponse({text: '  Look in the saved table.  ', classification: 'ai_missed', decision: 'continue'}), {text: 'Look in the saved table.', classification: 'ai_missed', decision: 'continue'});
  assert.equal(normalizeJourneyHelpResponse({text: '', classification: 'unsure', decision: 'stop'}).text, '');
  for (const response of [null, {}, {text: '', classification: 'unsure', decision: 'continue'}, {text: 'x'.repeat(2001), classification: 'unsure', decision: 'stop'},
    {text: 'x', classification: 'bug', decision: 'continue'}, {text: 'x', classification: 'unsure', decision: 'run'},
    {text: 'x', classification: 'unsure', decision: 'continue', bypassSafety: true}]) assert.throws(() => normalizeJourneyHelpResponse(response));
});

test('saved human interpretation and continuation link are separate and immutable', () => {
  const run = blocked();
  run.assistance = {question: 'Which menu should I use?', stepIndex: 999, createdAt: run.updatedAt, response: {id: 'reply-1', text: 'Use the table.', classification: 'ai_missed', decision: 'continue', createdAt: run.updatedAt, continuationRunId: 'child'}};
  const result = withJourneyAssistance(run);
  assert.equal(result.assistance.question, 'Which menu should I use?');
  assert.equal(result.assistance.stepIndex, undefined);
  assert.equal(result.assistance.response.continuationRunId, 'child');
  assert.deepEqual(result.findings, run.findings);
  assert.equal(result.status, 'blocked');
  run.assistance.response.classification = 'invalid';
  assert.equal(journeyAssistance(run).response, undefined);
});
