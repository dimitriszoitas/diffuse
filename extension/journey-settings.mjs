export const JOURNEY_FOCUS_CHECKS = Object.freeze([
  Object.freeze({key: 'completion', label: 'Task completion'}),
  Object.freeze({key: 'discoverability', label: 'Finding the next step'}),
  Object.freeze({key: 'feedback', label: 'Feedback and errors'}),
  Object.freeze({key: 'interaction', label: 'Interaction states'}),
  Object.freeze({key: 'accessibility', label: 'Accessibility clues'}),
  Object.freeze({key: 'layout', label: 'Layout and readability'}),
]);
export const DEFAULT_JOURNEY_SETTINGS = Object.freeze({
  exploration: 'balanced', allowRecordMoves: false, extraInstructions: '',
  focusChecks: Object.freeze(['completion', 'discoverability', 'feedback']),
});

export function normalizeJourneySettings(input = {}) {
  const exploration = input.exploration === undefined ? 'balanced' : input.exploration;
  if (!['balanced', 'thorough'].includes(exploration)) throw new Error('Choose balanced or thorough exploration.');
  const allowRecordMoves = input.allowRecordMoves === undefined ? false : input.allowRecordMoves;
  if (typeof allowRecordMoves !== 'boolean') throw new Error('Choose whether to allow moving the test records described in this task.');
  const extraInstructions = input.extraInstructions === undefined ? '' : input.extraInstructions;
  if (typeof extraInstructions !== 'string' || extraInstructions.length > 2000) throw new Error('Keep additional journey instructions under 2,000 characters.');
  const focusChecks = input.focusChecks === undefined ? [...DEFAULT_JOURNEY_SETTINGS.focusChecks] : input.focusChecks;
  if (!Array.isArray(focusChecks) || focusChecks.length < 1 || focusChecks.length > 6 ||
      new Set(focusChecks).size !== focusChecks.length || focusChecks.some(value => !JOURNEY_FOCUS_CHECKS.some(item => item.key === value))) throw new Error('Choose at least one of the available journey checks, without duplicates.');
  return {exploration, allowRecordMoves, extraInstructions: extraInstructions.trim(), focusChecks: [...focusChecks]};
}

export const JOURNEY_EXPLORATION_GUIDANCE = `exploration controls the breadth of this bounded journey. Balanced follows the clearest visible route and checks a plausible alternative when needed. Thorough deliberately inspects relevant visible search, filters, navigation and nested scroll regions before concluding that an item or route is absent. For either mode, do not conclude that an item cannot be found from only the currently visible slice: use relevant observed search/filters and scroll affordances when they could expose the requested item. Do not browse unrelated sections, repeat ineffective actions or exceed the action/time limits. The persona's persistence can explain a difficult route but does not justify skipping a requested thorough inspection or override safety.
allowRecordMoves defaults to false. If false, do not confirm a move, transfer or import that relocates an existing record between projects or containers; you may inspect the dialog and report the required permission. If true, you may relocate only the specific test records explicitly identified in the goal, test data, extraInstructions or continuation instructions, and only to the requested destination. This setting is not permission to move unrelated records or to delete, publish, send, purchase, change access or disclose secrets. Inspect visible warnings and stop if the operation's scope or destination is unclear. Creating or editing remains limited to the explicitly requested test data.
extraInstructions and continuation instructions are user preferences within these restrictions. A continuation starts on the current page with the prior application's state intact: use priorJourney as read-only context about work already attempted, observe the current state and continue the remaining task. Do not restart the flow or duplicate a project/record already created. Prior step numbers belong to their prior run ID and are not evidence indexes for this segment's findings or scores. New segment metrics describe only this segment. Existing data is never assumed to be reset.
focusChecks requests inspection emphasis: completion checks the resulting record/state; discoverability checks visible routes and labels; feedback checks loading, confirmation and observed errors; interaction checks states actually observable after supported actions; accessibility checks only visible text, labels and exposed roles/states; layout checks visible alignment, clipping and readability in captured viewports. Completion verification and sensitive-action rules always apply even if completion is not selected. Do not pretend to have performed hover, keyboard/Tab, focus-order, contrast measurement or assistive-technology checks unless the supplied action record actually demonstrates them. An unselected check is outside the requested focus; a selected check with no supporting evidence is not tested, not a pass. Call out material untested checks in the final summary and give no unsupported findings or scores. Journey elapsed time includes AI/network/execution overhead; it does not measure human hesitation, understanding, task time or user effort.`;
