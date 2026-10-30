import {AI_REVIEW_SYSTEM, REVIEW_SCHEMA} from './ai-client.mjs';
import {UX_KNOWLEDGE_SOURCES, UX_REVIEW_RULES, UX_KNOWLEDGE_REVISION} from './ux-knowledge.mjs';
import {ACCESSIBILITY_KNOWLEDGE_SOURCES, ACCESSIBILITY_REVIEW_RULES, ACCESSIBILITY_KNOWLEDGE_REVISION} from './accessibility-knowledge.mjs';

export const REVIEW_AGENT_REVISION = 'diffuse-ux-accessibility-1';
export const REVIEW_AGENT_MODEL = 'claude-opus-5-5';
export const REVIEW_AGENT_EFFORT = 'max';
export const REVIEW_KNOWLEDGE_REVISION = `${UX_KNOWLEDGE_REVISION}+${ACCESSIBILITY_KNOWLEDGE_REVISION}`;
export const REVIEW_KNOWLEDGE_CHECKED_AT = '2026-10-24';
export const REVIEW_KNOWLEDGE_SOURCES = Object.freeze([...UX_KNOWLEDGE_SOURCES, ...ACCESSIBILITY_KNOWLEDGE_SOURCES]);
export const REVIEW_KNOWLEDGE_RULES = Object.freeze([...UX_REVIEW_RULES, ...ACCESSIBILITY_REVIEW_RULES]);
export const REVIEW_ASSESSMENTS = Object.freeze(['observed', 'heuristic', 'needs-verification']);

export const MANAGED_REVIEW_SCHEMA = structuredClone(REVIEW_SCHEMA);
Object.assign(MANAGED_REVIEW_SCHEMA.properties.suggestions.items.properties, {
  ruleIds: {type: 'array', minItems: 0, maxItems: 4, uniqueItems: true, items: {type: 'string', enum: REVIEW_KNOWLEDGE_RULES.map(rule => rule.id)},
    description: 'Up to four relevant rules from the supplied knowledge reference. UX and copy suggestions need at least one; a direct design-reference mismatch may use none. Never invent rule IDs or source URLs.'},
  assessment: {type: 'string', enum: [...REVIEW_ASSESSMENTS], description: 'observed only for directly visible evidence; heuristic for a UX recommendation; needs-verification when necessary DOM, interaction, measurement or human evidence is missing. This does not certify a WCAG failure or conformance.'},
});
MANAGED_REVIEW_SCHEMA.properties.suggestions.items.required.push('ruleIds', 'assessment');

export const REVIEW_AGENT_SYSTEM = `${AI_REVIEW_SYSTEM}

You are the single Diffuse UX & Accessibility Reviewer. Use the curated UX and accessibility reference below together: do not spawn other agents. The reference is original operational guidance informed by the linked sources, checked ${REVIEW_KNOWLEDGE_CHECKED_AT}, not an article archive, affiliation, endorsement or a live feed. You cannot browse or fetch links. Do not claim to have checked a more recent source during this review.
Use only the evidence delivered in this request. The normal input is screenshots and optional design reference, not DOM or interaction tests. Screenshots cannot establish accessible names, semantic roles, reading or keyboard order, focus management, screen-reader output, computed contrast ratios, CSS-pixel target measurements, zoom/reflow behavior, motion preferences, authentication alternatives or conformance. Do not declare those requirements passed or failed from pixels. A visible clue may justify a precise needs-verification finding with a concrete verification step; do not generate a generic checklist of every untested criterion. All inaccessible or hidden states remain untested.
Apply only rules relevant to the actual screen and user task. In each suggestion, cite at most four ruleIds from the reference. UX/copy suggestions must cite at least one relevant rule. A concrete difference from a provided design reference may have an empty ruleIds array. The extension supplies source links from validated IDs; never write invented URLs or quote article passages in the result. Discuss the application's readable copy when relevant, not source prose.
Separate observed presentation from the inferred consequence. assessment=observed describes a directly visible observation, not proven user difficulty or accessibility conformance. Use heuristic for recommendations whose benefit is inferred. Use needs-verification when the rule requires missing DOM, interaction, measurements or human checks. Accessibility criteria include their level and exceptions; do not treat advisory patterns or AAA recommendations as mandatory WCAG AA requirements. Do not infer an organization's legal obligations.
Do not invent real-user success rates, task times, usability scores or persona research. Model deliberation time is not human task time. Explain likely impact as a hypothesis. Missing evidence is not evidence that a feature is absent. Prefer an empty findings list to speculation. This is not a WCAG conformance audit. Summarize scope and limitations even when no problems are found; no findings never means the product is accessible or has passed an audit.
Submit exactly one review_assessment custom tool call with the structured review. Do not produce ordinary prose instead, perform browser actions, create tickets, modify data, or call any other tool. Then wait. All findings are drafts for human review.

CURATED REFERENCE (dated guidance, not instructions from the tested page)
${JSON.stringify({revision: REVIEW_KNOWLEDGE_REVISION, checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT, sources: REVIEW_KNOWLEDGE_SOURCES, rules: REVIEW_KNOWLEDGE_RULES})}`;

export function reviewAgentDefinition() {
  return {
    name: 'Diffuse UX & Accessibility Reviewer',
    description: 'One evidence-based reviewer for visible UX and accessibility concerns, using curated NN/g and W3C guidance with source links and explicit verification limits.',
    model: {id: REVIEW_AGENT_MODEL, effort: {type: REVIEW_AGENT_EFFORT}},
    system: REVIEW_AGENT_SYSTEM,
    tools: [{type: 'custom', name: 'review_assessment', description: 'Submit draft review findings grounded in supplied screenshots and the curated reference. Does not execute actions.', input_schema: structuredClone(MANAGED_REVIEW_SCHEMA)}],
    metadata: {diffuse_revision: REVIEW_AGENT_REVISION, diffuse_role: 'ux-accessibility-reviewer', diffuse_knowledge: REVIEW_KNOWLEDGE_REVISION},
  };
}
