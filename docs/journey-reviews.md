# Test a journey

Give Diffuse a goal to attempt across the current website. It discovers visible controls, follows links, fills supplied test data, and checks the resulting screens. You do not need to specify selectors or prepare an automation script.

For example:

> Add Oat milk to the ingredients table with ml as the unit. Start from the dashboard and find the route yourself.

An optional success criterion makes the outcome clearer:

> The new ingredient appears in the table and remains there after returning from another page.

Use **Details** for test data or specific checkpoints. Giving exact steps tests that prescribed flow; a goal without navigation instructions is more useful for assessing discoverability.

## Run and inspect

1. Start a normal Diffuse review on an HTTP/HTTPS page or localhost preview. Sign in to the app yourself first.
2. Open **Journey Testing with AI** in the sidebar. It uses the model and Anthropic key in AI settings.
3. Enter the goal and optional criteria/data, then choose an action limit.
4. Start the journey and keep the reviewed tab visible. Diffuse can follow routes through multiple pages on the same website origin.
5. **Pause** interrupts the next AI decision and pauses recording; **Resume** reads the page again and resumes recording. **Stop** ends the run and saves its video. A browser action already dispatched cannot be undone.
6. Watch the silent journey recording alongside its notes. A yellow pulse marks each click before the action, including clicks that open another page. Choose **Watch this step** on a timeline entry to seek to that moment, or download the full WebM movie.
7. Inspect the screenshot evidence, observed action counts, and AI assessment. Accept relevant findings as review comments.

Accepted findings keep their captured page URL, screenshot, and reproduction steps. They can be shared using the existing JSON, HTML, Jira, and GitHub review flows. Recent runs remain available in the journey panel for this review. Run the same goal again after making changes; compare the evidence before declaring a fix.

## Ask about a step and try another route

When a journey ends, expand a step and choose **Ask about this step**, or use **Ask about this journey** for a general question. For example: “Why did you choose New instead of the first step of the wizard?” Answers use recorded observations, action summaries, and outcomes. They can link back to the supporting steps and acknowledge when an alternative was not tested. Questions do not operate the page.

When an alternative would be useful, the answer offers **Fork journey…**. Edit the proposed route, goal, test data, and action limit, then choose **Run alternative route**. You can also use **Try another route** directly after a run.

A fork starts at the original starting URL on the same website. It is a separate run with its own notes and recording; the original stays in Previous journeys. It does not restore an earlier application snapshot or reset existing data. Use distinct test records or prepare the app yourself before rerunning.

Up to 20 questions are retained with each local run. A question sends the saved journey evidence, prior conversation, and the selected step’s screenshot when available to Anthropic using your key. It does not send the full movie. API charges apply.

## Reading the result

- **Completed**: the AI judged that the observed result met the supplied goal. Inspect the final screenshot and explanation; this is not a backend assertion or a human usability study.
- **Failed**: the AI identified an observed task failure and explains its evidence.
- **Blocked**: the run needs human intervention, such as login, a different website, a sensitive action, or an unsupported control.
- **Inconclusive**: the action/time limit, browser interruption, provider error, or uncertain outcome prevented a reliable conclusion.
- **Stopped**: you ended the run.

Clicks, navigation and backtracking are observed counts. Fewer clicks do not automatically mean better UX. Discoverability, clarity, effort, feedback and recovery are AI assessments on a 1–5 scale, with evidence and confidence. **Not tested** is used when the journey provides insufficient evidence. Agent duration includes model and automation overhead and is not a human task-time measurement.

## Scope and limits

Journeys stay within one origin and one tab at the viewport selected before the run. They use the rendered page and visible controls, without inspecting hidden app state or calling app APIs to shortcut the task. Unsupported widgets, embedded frames, login challenges and external-site transitions can stop a run. Chrome's debugging notice is shown while a journey is controlling the page. Existing viewport control is preserved.

Use approved test data and a suitable test environment: a journey can submit forms and create records in the signed-in app. Password, file upload, payment, destructive controls and native confirmation dialogs require human intervention. Findings remain suggestions until accepted; no tickets or PR comments are published automatically.

Each run is limited to ten minutes and the selected action count. The silent recording captures only the reviewed tab, at up to 1920 × 1080, with a 20 MiB limit. Reaching a recording limit or losing capture stops the journey with an inconclusive outcome; retained notes and screenshots remain available. The recording can include everything visible in the tab, including test data. It captures no audio.

Each decision sends visible page evidence and the journey context to Anthropic, with API charges. The full recording stays on your device and is not sent to the model. Local history, including movies and screenshots, is limited to ten recent runs and an approximate 80 MiB budget. The newest run and its direct fork parent stay together, even if that pair exceeds the approximate size budget; older runs are removed first. Download movies you want to keep before older history is removed.

The complete journey and its movie are not included in normal review exports; accepted findings include their screenshot and reproduction steps. Download the movie separately when you want to share the whole attempt. See [Privacy](PRIVACY.md).
