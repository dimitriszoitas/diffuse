import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyAgentDefinitions, JOURNEY_AGENT_REVISION, JOURNEY_ACTOR_SYSTEM, JOURNEY_EVALUATOR_SYSTEM} from '../extension/journey-agent-definitions.mjs';

test('revision three uses Opus 5.5 Max and custom tools while allowing evidence beyond step 31', () => {
  const definitions = journeyAgentDefinitions();
  assert.equal(JOURNEY_AGENT_REVISION, 'diffuse-journeys-3');
  for (const definition of Object.values(definitions)) {
    assert.deepEqual(definition.model, {id: 'claude-opus-5-5', effort: {type: 'max'}});
    assert.equal(definition.metadata.diffuse_revision, JOURNEY_AGENT_REVISION);
    assert.ok(definition.tools.every(tool => tool.type === 'custom'));
  }
  const evidence = definitions.evaluator.tools.find(tool => tool.name === 'journey_evidence').input_schema.properties.stepIndex;
  assert.equal(evidence.minimum, 1);
  assert.equal(evidence.maximum, undefined);
});

test('agent instructions distinguish scoring targets, bounded context and authoritative stop causes', () => {
  assert.match(JOURNEY_ACTOR_SYSTEM, /actionTarget.*never an action limit/);
  assert.match(JOURNEY_ACTOR_SYSTEM, /contextCoverage.*omitted/);
  assert.match(JOURNEY_EVALUATOR_SYSTEM, /status, summary, stopReason, error and recording fields are authoritative/);
  assert.match(JOURNEY_EVALUATOR_SYSTEM, /partial recording does not imply the journey ended/);
  assert.match(JOURNEY_EVALUATOR_SYSTEM, /targetAssessment.*separate from qualitative usability/);
  assert.match(JOURNEY_EVALUATOR_SYSTEM, /scope is segment/);
});
