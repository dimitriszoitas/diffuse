# Test a journey

Give Diffuse a goal to attempt across the current website. It discovers visible controls, follows links, fills supplied test data, and checks the resulting screens. You do not need to specify selectors or prepare an automation script.

For example:

> Add Oat milk to the ingredients table with ml as the unit. Start from the dashboard and find the route yourself.

An optional success criterion makes the outcome clearer:

> The new ingredient appears in the table and remains there after returning from another page.

Use **Details** for test data or specific checkpoints. Giving exact steps tests that prescribed flow; a goal without navigation instructions is more useful for assessing discoverability.

## Choose the journey engine

**Direct** is the default: Diffuse manages the journey using the Claude model and API key in AI settings. The optional **Claude agents** pilot uses a persona-driven journey agent and a separate evaluator, both on **Claude Fable 5 · Max effort** (`claude-fable-5`, not Fable 5.1).

To enable the pilot, open **Settings → AI → Journey testing**, choose **Claude agents**, review the spending limit, and select **Set up journey agents**. It uses your existing key to prepare both agents in your Anthropic account; no manual Console setup is needed. The default $2 budget reserves 75% for the journey and 25% for evaluation and follow-up discussion. A request already in progress can exceed its allocated cap. Setup does not start a journey or send page evidence.

Both engines operate your selected, signed-in tab through Diffuse. Keep Chrome and the tab open and visible. Managed session history is retained by Anthropic separately from the local report and movie. [Read the setup, budget, troubleshooting, and cloud-data removal guide](managed-agents.md) before enabling the pilot. Switching engines does not change screenshot audits or Jira title generation.

## Run and inspect

1. Start a normal Diffuse review on an HTTP/HTTPS page or localhost preview. Sign in to the app yourself first.
2. Open **Journey Testing with AI** in the sidebar. It uses the journey engine and Anthropic key in AI settings.
3. Describe the persona and adjust technical confidence, product familiarity, task familiarity, and persistence. Choose the review checklist, enter the goal and optional criteria/data, then choose an action target. This is a scoring benchmark, not a stopping limit.
4. Start the journey and keep the reviewed tab visible. Diffuse can follow routes through multiple pages on the same website origin.
5. **Pause** interrupts the next AI decision and pauses recording; **Resume** reads the page again and resumes recording. **Stop** ends the run and saves its video. A browser action already dispatched cannot be undone.
6. Watch the silent journey recording alongside its notes. A yellow pulse marks each click before the action, including clicks that open another page. Choose **Watch this step** on a timeline entry to seek to that moment, or download the full WebM movie.
7. Inspect the screenshot evidence, observed action counts, and AI assessment. Accept relevant findings as review comments.

Accepted findings keep their captured page URL, screenshot, and reproduction steps. They can be shared using the existing JSON, HTML, Jira, and GitHub review flows. Recent runs remain available in the journey panel for this review. Run the same goal again after making changes; compare the evidence before declaring a fix.

## Choose a review focus and exploration style

**What should AI check?** offers task completion, discoverability and clarity, feedback and recovery, interaction states, accessibility, and layout consistency. The first three are selected by default. These guide what the model looks for along the observed route; they do not guarantee exhaustive coverage. Checks without sufficient evidence remain untested. Hover, keyboard, and assistive-technology behavior cannot be inferred from a static screenshot or a successful mouse click.

**How should it explore?** offers balanced or thorough exploration, additional instructions, and permission to move the test records required by the goal. Thorough exploration asks the model to examine available search, filters, and scrollable lists before concluding that no route is available. This still uses the selected persona; extra exploration counts toward the action-efficiency benchmark. Permission to move records applies only to the test records needed for the stated task; it does not authorize unrelated changes, deleting records, sending invitations, or changing access.

The persona profile is recorded with the run and carried into forks and continuations unless you change it. AI answers use that recorded perspective. Older runs without a persona remain identified as such. Profiles are simulation parameters, not claims about how real people will behave.

## Ask about a step and try another route

When a journey ends, expand a step and choose **Ask AI about this step**, or use **Ask AI** for the whole journey. This opens a chat with a saved transcript and follow-up context. Enter sends a message; Shift + Enter adds a new line. The back button returns to the journey without discarding your draft. For example: “Why did you choose New instead of the first step of the wizard?” Answers use recorded observations, action summaries, and outcomes. They can link back to the supporting steps and acknowledge when an alternative was not tested. Questions do not operate the page.

When an alternative would be useful, the answer offers **Fork journey…**. Edit the proposed route, goal, test data, and action target, then choose **Run alternative route**. You can also use **Try another route** directly after a run.

A fork starts at the original starting URL on the same website. It is a separate run with its own notes and recording; the original stays in Previous journeys. It does not restore an earlier application snapshot or reset existing data. Use distinct test records or prepare the app yourself before rerunning.

Up to 20 questions are retained with each local run. A question sends the saved journey evidence, prior conversation, and the selected step’s screenshot when available to Anthropic using your key. With Claude agents, the separate evaluator answers in the journey's saved evaluator session and uses that session's remaining budget. It cannot operate the website. Neither engine sends the full movie. API charges apply.

## Respond when Diffuse gets stuck

A blocked attempt opens a help conversation with a question in plain language. Expand **What happened** to see the recorded reason, or open its cited step. Closing the conversation leaves **Reply to Diffuse** on the result; polling does not repeatedly reopen it.

Give guidance and choose your assessment: **Issue with the experience**, **AI missed something**, or **Not sure yet**. The assessment concerns this blocker, not every finding at the same step or the whole product. It stays separate from the original AI observations and scores, and is included as reviewer context in subsequent discussion and continuation. No issue is created automatically.

Choose **Stop journey** to save your feedback and leave the attempt stopped. A written answer is optional for Stop, and saving it makes no model call. Choose **Continue** to save your answer and use it as instructions for the next part of the journey from the current page. Sensitive actions still require the same manual intervention; classifying a blocker as an AI miss does not grant additional permissions.

Your answer stays saved even if continuation cannot start. **Continue with saved answer** retries the same response; **Open continued journey** returns to the attempt already created from it. The parent recording finishes saving before a response is stored, so the movie and feedback remain together.

## Continue an unfinished journey

For a stopped, blocked, or inconclusive run, choose **Continue journey** in the result or chat. Add instructions, review the inherited persona and exploration settings, and choose **Continue from current page**. The page must be on the same website as the previous run. Diffuse reads its current state; it does not return to the original URL, recreate the project, restore a snapshot, or reset application data.

A continuation is a linked new part with its own action target, numbered steps, spending allowance, and silent recording. The efficiency score covers this new part only; it does not include actions from the earlier part. Previous steps are supplied as read-only context to avoid repeating completed work. New findings cite evidence from the new part. The previous run stays in history. If you have navigated elsewhere in the app, describe what changed in your instructions. Paused runs still use **Resume** to continue the existing recording.

## Reading the result

- **Completed**: the AI judged that the observed result met the supplied goal. Inspect the final screenshot and explanation; this is not a backend assertion or a human usability study.
- **Failed**: the AI identified an observed task failure and explains its evidence.
- **Blocked**: Diffuse needs guidance or human intervention, such as finding a route, login, a different website, a sensitive action, or an unsupported control. It asks for help before any continuation.
- **Inconclusive**: a browser interruption, provider limit or error, no observed progress, or uncertain outcome prevented a reliable conclusion.
- **Stopped**: you ended the run.

**Action efficiency** is a separate, transparent benchmark: completed attempts receive `round(100 × min(1, target ÷ actual actions))`. For example, 25 actions against a target of 20 earns 80/100. At or below the target earns 100/100. Unfinished attempts show the count and target without an efficiency score. The count includes AI actions such as typing, scrolling and waiting; it is not a human click count or a usability rating. For a continuation, the score covers the current part only.

Clicks, navigation and backtracking are observed counts. Fewer clicks do not automatically mean better UX. Discoverability, clarity, effort, feedback and recovery are AI assessments on a 1–5 scale, with evidence and confidence. **Not tested** is used when the journey provides insufficient evidence. Agent duration includes model and automation overhead and is not a human task-time measurement.

## Scope and limits

Journeys stay within one origin and one tab at the viewport selected before the run. They use the rendered page and visible controls, without inspecting hidden app state or calling app APIs to shortcut the task. Unsupported widgets, embedded frames, login challenges and external-site transitions can stop a run. Chrome's debugging notice is shown while a journey is controlling the page. Existing viewport control is preserved.

Use approved test data and a suitable test environment: a journey can submit forms and create records in the signed-in app. Password, file upload, payment, destructive controls and native confirmation dialogs require human intervention. Findings remain suggestions until accepted; no tickets or PR comments are published automatically.

Journeys have no fixed action count or overall duration cutoff. Spending limits, individual request timeouts, no-progress checks, and browser safeguards still apply; a saved stop reason explains why an attempt ended. The silent recording captures only the reviewed tab, at up to 1920 × 1080. It stops at ten minutes or its 18 MiB recording cap (the final clip must fit 20 MiB), while the journey continues with screenshots and notes. The sidebar identifies this as a partial recording; later steps do not offer a misleading video timestamp. Unexpected capture loss instead stops the attempt and asks for guidance. Older attempts stopped by a recording cap can be identified when their saved video contains that exact reason. The recording can include everything visible in the tab, including test data. It captures no audio.

Each decision sends visible page evidence and the journey context to the selected AI provider, with API charges. The full recording stays on your device and is not sent to the model. Movies and screenshots follow a limit of ten recent runs and an approximate 80 MiB budget. The newest run and its direct fork or continuation parent keep their media together, even if that pair exceeds the approximate size budget. Older media is cleared first; complete step ledgers and notes remain in Reports. Download movies you want to keep before older media is cleared. With Claude agents, deleting local history does not delete provider-side sessions; follow the [cloud-data removal instructions](managed-agents.md#data-and-removal) separately.

The complete journey and its movie are not included in normal review exports; accepted findings include their screenshot and reproduction steps. Download the movie separately when you want to share the whole attempt. See [Privacy](PRIVACY.md).


## Journey reports in 0.19.0

Open Review Reports and select the review. Its Journeys section contains each saved attempt regardless of outcome or accepted findings. Expand a journey for its goal, persona, action target, outcome and recorded stop reason. Expand a step for the action, reason, execution status, result, page, timestamp, action details and retained screenshot. A missing stop reason is explicitly unknown. Recordings are playable when retained. Stopped runs with no actions are still listed.

Older screenshots and movies follow the local media budget; complete step ledgers and notes remain until the review is deleted. Earlier versions may already have removed old runs, which cannot be reconstructed. Full HTML downloads include the journey section; portable JSON/Jira/GitHub sharing still includes selected accepted findings rather than the complete journey ledger.
