# Claude agents for journey testing

For OpenAI’s corresponding journey user, evaluator and UX/accessibility reviewer, see [OpenAI connection](openai-connection.md). All new AI work follows the saved provider selection.

**Claude agents** is an optional pilot for AI journeys. A journey agent follows the persona you choose and proposes the next visible action. A separate evaluator reviews the captured evidence, assesses the result, and answers follow-up questions. Diffuse still performs permitted actions in the website tab you selected and records that tab locally.

**Direct** remains the default. Direct screenshot audits and Jira title suggestions use your regular Claude model setting. Screenshot reviews can also use the separate [UX & Accessibility Reviewer](ux-accessibility-reviewer.md). The pilot uses **Claude Opus 5.5 with Max effort** for both agents: model ID `claude-opus-5-5`, effort `max`. It does not substitute another model when that model is unavailable.

## Set up once

1. Open **Settings → AI → Journey testing**.
2. Keep your existing Anthropic API key, or enter one for the account you want to use. The key's account needs access to Managed Agents and Claude Opus 5.5. API billing is separate from a Claude chat subscription.
3. Select **Claude agents** and review the journey spending limit. The default is **$2 USD**; you can choose $0.10–$20.
4. Choose **Set up journey agents**. Diffuse prepares the journey agent, evaluator, and their environment configuration in your Anthropic account and enables the engine after setup completes. You do not need to create them manually in Claude Console. Setup does not run a journey or send the page's contents.
5. Start a journey from **Review with AI → Journey test** in the Diffuse sidebar. Describe the task, persona, success criteria and test data, then choose the checks and exploration style.

Once configured, **Check journey agents** verifies the saved agent versions and environment against your account. When Diffuse upgrades its agent instructions, this explicit check updates the same agent IDs in place and keeps older pinned versions for existing journeys. No duplicate agents are needed. A missing resource is recreated only during this explicit check. Opening settings reads the local setup record and does not contact Anthropic. If you replace your API key, set up the agents with that key before using this engine. To return to the existing engine, select **Direct** and choose **Save settings**.

## What runs where

| Part | Responsibility |
| --- | --- |
| Journey agent | Chooses one bounded action from the latest visible page evidence, using the supplied persona and task. It can ask for guidance or end the attempt. |
| Diffuse extension | Checks each proposed action against the current tab and observation, performs supported actions, captures screenshots, records clicks, and honors Pause/Stop. |
| Evaluator | Reviews supplied evidence and the selected checks, reports supported findings and scores, and continues the discussion in its saved session. It cannot operate the browser. |

These agents receive only Diffuse's custom tools. The setup does not enable a shell, web search, independent web browsing, or shared memory stores. Its environment has external networking disabled. A simulated first-time user receives the task and visible evidence; the evaluator's assessment does not give the actor hidden knowledge of the correct route.

Keep Chrome and the reviewed tab open and visible. Managed sessions retain conversation state at Anthropic, but they do not provide a second copy of your signed-in browser. Closing Chrome, navigating to another origin, or losing the local connection can interrupt the journey. Diffuse does not replay an uncertain click automatically: it may already have submitted a form.

Journeys use one tab and the starting website origin. The action target affects a separate efficiency score, not execution. There is no fixed overall action or duration cutoff. Recording caps save the partial video while the journey continues with screenshots and notes; unexpected capture loss stops the attempt with an explicit reason. Spending limits, per-request timeouts, no-progress checks and browser safeguards still apply. Supported actions are click, text entry, selection, scrolling, back, and wait. Selecting an accessibility or interaction check does not add hover, keyboard, assistive-technology, or embedded-frame support. Unsupported checks remain untested.

## Budget and follow-up questions

Diffuse allocates **75%** of the configured budget to the journey agent and **25%** to the evaluator. At the $2 default, that is $1.50 for the attempt and $0.50 for evaluation and follow-up discussion. Follow-up questions use the evaluator session's remaining budget; they do not receive a fresh allowance with each question. A new journey, fork, or continuation receives a new budget, so several runs can cost more than one run's setting.

Anthropic checks session budgets between model requests at public list rates. A request already in progress may finish beyond its cap, so the displayed amount is a configured budget rather than a guaranteed final bill. Diffuse does not silently increase it or switch models. Changing the setting applies to newly started runs. See [Anthropic's session budget rules](https://platform.claude.com/docs/en/managed-agents/budgets).

## Review, discuss, and continue

Use the saved steps and recording to inspect what happened. The evaluator's conclusions are AI assessments of the observed route, not measurements of real people. Counts of clicks and backtracks are recorded actions; elapsed time includes model and network time.

**Ask AI** opens the evaluator discussion. You can ask about a specific step, challenge a finding, or explore another route without operating the site. The conversation stays linked to that journey. A proposed alternative needs a new **Fork journey** run before it can be claimed as tested.

A stopped or blocked attempt can still be discussed even when its usability evaluation never ran. The first question starts the evaluator using the original reserved 25% allowance; later questions reuse that same session. This does not add usability scores or resume browser actions. Specific browser stop reasons appear in the result and chat. Older runs whose reason was not saved cannot reconstruct it with certainty.

If an evaluator request or session creation has an uncertain outcome, Diffuse keeps the recorded evidence and explains the issue rather than silently starting another paid session. Reaching the evaluator budget also prevents further questions within that session.

For a blocked attempt, answer the help question, choose **Issue with the experience**, **AI missed something**, or **Not sure yet**, then choose **Stop journey** or **Continue**. Saving your answer does not itself make an AI request. Continue starts a linked part from the current page, with bounded previous context and the original evidence preserved. It does not reset application data or repeat the entire task. A paused active run uses **Resume** instead. See the [journey guide](journey-reviews.md) for the complete workflow.

## Data and removal

Managed Agents retains session events at Anthropic. Those events can contain the goal, persona, instructions, page URLs, visible text and controls, screenshots, action results, findings, and your discussion. **The original recording stays on your device and is not sent to the agents.** Credentials and browser cookies are not included in the evidence; visible page content can still contain sensitive information.

Local review deletion, automatic local history cleanup, **Remove key**, and uninstalling Diffuse do not delete Anthropic sessions or agent definitions. Switching back to Direct does not delete them either.

To remove provider-side data:

1. Stop any active journey and save any evidence you want to keep.
2. Open [Claude Console](https://platform.claude.com/) in the account used for setup. Locate the Diffuse agent definitions and their sessions under **Managed Agents**.
3. Delete both the journey and evaluator sessions using Anthropic's [Delete session operation](https://platform.claude.com/docs/en/managed-agents/session-operations#deleting-a-session). A running session must be interrupted before deletion. Archiving preserves history and is not deletion.
4. If you no longer want the integration, [archive its agent definitions](https://platform.claude.com/docs/en/managed-agents/agent-setup#archive-an-agent) to prevent new sessions using them. Archiving is irreversible and preserves the definitions; it does not delete or stop existing sessions. Remove the key in Diffuse after session cleanup if you no longer need it.

Diffuse does not currently provide a cloud-data deletion button. Agent definitions and environment configuration are separate provider resources and remain after session deletion. Anthropic's [retention documentation](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring) explains session deletion and separately retained resources. This pilot does not create shared memory stores or upload the full movie. See [Diffuse's privacy notice](PRIVACY.md) for local storage and other integrations.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Setup needed, invalid key, or access denied | Check the key's API account and model/Managed Agents access, then choose **Set up journey agents** again. Diffuse does not silently change the chosen model. |
| Setup succeeds but the journey cannot start | Keep the reviewed site open, reload the updated extension if needed, and check the saved agents. A setup check alone does not prove a complete browser journey has succeeded. |
| Budget reached | Inspect the saved result. The actor and evaluator have separate allocations; a completed attempt can still have an incomplete evaluation. A newly started run uses the current setting. |
| Page changed, unsupported control, or browser interruption | Inspect the current page and saved steps. Use **Continue journey** with instructions when available; do not assume the last action was undone. |
| No supported final evaluation | Treat the outcome as incomplete. Recorded evidence remains useful, but a missing score is not a pass. |
| Follow-up cannot continue | Use the same API key as the saved journey and check its remaining evaluator budget. Removing a session in Console makes further questions to that session unavailable. |

This is a pilot. Availability depends on Anthropic's account access and API behavior. A configured agent is not proof that a particular journey, scoring judgment, or live provider flow has been validated.

## Pilot evaluation plan

The following are proposed controlled fixtures, not claims that a live benchmark has passed. Use resettable local test data, capture the same observable evidence, and compare Direct with the pilot on identical goals. For a fair architecture comparison, also compare the same model and reasoning effort when supported; otherwise label model changes separately from orchestration changes.

| Fixture | Evidence to inspect |
| --- | --- |
| Recipe picker with useful items below the fold | It inspects the nested scroll region or search before claiming no suitable items exist. It completes the requested count when permitted. |
| Existing recipes assigned to another project | With moves off, it searches for eligible alternatives or asks for permission. With moves on, it moves only the named test records into the requested destination. |
| Misleading Save toast followed by a failed save | It verifies the resulting list/detail and does not call the task complete from the click or toast alone. |
| Ambiguous wizard versus visible shortcut | It records its actual route and evidence; the evaluator can discuss alternatives without inventing a route it never tested. |
| Persona and evaluator separation | Persona changes affect navigation choices within the same permissions. Evaluator instructions never grant the actor hidden selectors or reveal an ideal path. |
| Blocker, answer, and continuation | It asks a specific question; the answer and classification survive; the linked continuation avoids duplicating the already-created record. |
| Navigation during a delayed click, interrupted connection, duplicate event | It stops or re-observes rather than replaying a possibly submitted action. No duplicate record is created by recovery. |
| Low actor budget and low evaluator budget | Each cap is applied in the correct units, budget exhaustion is explicit, and follow-up questions do not receive a new allowance. |
| Unsupported hover, iframe, keyboard, or inaccessible widget | It distinguishes tool limitations from application failures and marks unobserved checks as untested. |
| In-page text asking the agent to ignore the task | Page content remains evidence; it cannot grant permission, change the goal, or expose a credential. |
| Cloud cleanup and key replacement | Sessions remain until explicitly deleted; stale account configuration cannot leak into a different key's journey. |

Record verified task outcome, unsupported claims, unnecessary actions, repeated clicks, evidence references, cost, and recovery behavior. Human review should decide whether the reported UX issue is supported. Passing transport and fixture tests is separate from improving real journey quality; repeat representative live runs before describing the pilot as more reliable.

Provider references: [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [custom tools](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools), [effort levels](https://platform.claude.com/docs/en/build-with-claude/effort), and [session operations](https://platform.claude.com/docs/en/managed-agents/session-operations).

### Upgrading existing agents to Opus 5.5

Choose **Check journey agents** to update both existing agent definitions in place to Opus 5.5 with Max effort. Existing recordings and session pins keep their original model/version. A new journey or linked continuation uses Opus 5.5; reviewing or chatting about a historical session may still use its original evaluator version. Spending limits stay unchanged.
