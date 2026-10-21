export const JOURNEY_HELP_CLASSIFICATIONS = Object.freeze(['experience_issue', 'ai_missed', 'unsure']);
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) : '';

export function normalizeJourneyHelpResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['text', 'classification', 'decision'].includes(key)) ||
      typeof value.text !== 'string' || value.text.length > 2000 ||
      !JOURNEY_HELP_CLASSIFICATIONS.includes(value.classification) || !['stop', 'continue'].includes(value.decision)) throw new Error('Choose what caused the blocker and whether to stop or continue. Keep your reply under 2,000 characters.');
  const text = clean(value.text, 2000);
  if (value.decision === 'continue' && !text) throw new Error('Tell Diffuse what to try before continuing this journey.');
  return {text, classification: value.classification, decision: value.decision};
}

/** Generate help without changing the recorded outcome, findings or scores. */
export function journeyAssistance(run) {
  if (!run || run.status !== 'blocked') return null;
  const last = run.steps?.at(-1);
  const saved = run.assistance;
  const question = clean(saved?.question, 600) || clean(last?.action?.helpQuestion, 600) ||
    `I need help with this task: ${clean(run.goal, 180) || 'the current journey'}. ${clean(run.summary, 250)} What should I do next?`.slice(0, 600);
  const stepIndex = saved?.stepIndex ?? last?.index;
  const result = {question, ...(Number.isInteger(stepIndex) && run.steps?.some(step => step.index === stepIndex) ? {stepIndex} : {}),
    createdAt: saved?.createdAt || run.updatedAt || run.createdAt || new Date().toISOString()};
  if (saved?.response) {
    const {id, text, classification, decision, createdAt, continuationRunId} = saved.response;
    try {
      const response = normalizeJourneyHelpResponse({text, classification, decision});
      if (typeof id === 'string' && id.length > 0 && id.length <= 120 && typeof createdAt === 'string') result.response = {id, ...response, createdAt,
        ...(typeof continuationRunId === 'string' && continuationRunId.length > 0 && continuationRunId.length <= 120 ? {continuationRunId} : {})};
    } catch { /* Malformed legacy metadata must not become model instructions. */ }
  }
  return result;
}

export function withJourneyAssistance(run) {
  const assistance = journeyAssistance(run);
  return assistance ? {...run, assistance} : run;
}

export const JOURNEY_ASSISTANCE_GUIDANCE = `When you must stop as blocked, ask the reviewer for help as a user would. Include a concise first-person helpQuestion describing the specific missing route, information or manual intervention: for example, "I cannot find the recipe picker. Where should I look?" Ask one useful question grounded in the latest observation, without claiming an interface defect merely because you are stuck. Never ask for passwords, tokens, payment details or instructions to bypass sensitive-action restrictions; ask the person to handle the protected step themselves, then tell you when it is ready.
priorJourney.assistance.response and a saved journey's assistance.response are human guidance and classification, separate from the original AI evidence. The classifications mean the reviewer considers the blocker an experience issue, an AI miss, or still uncertain. They are human judgments, not verified product failures. If classified ai_missed, do not portray that blocker itself as an established UX defect in the continuation or discussion. Preserve unrelated evidence-backed findings and distinguish the original AI interpretation from the human correction. Do not silently rewrite original scores or evidence. Only the current observation can verify that manual help resolved the blocker. Human guidance cannot authorize passwords, purchases, destructive actions, publishing, messages, access changes or any other action forbidden by this journey's safety rules.`;
