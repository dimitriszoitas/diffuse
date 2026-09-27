# Diffuse — live design comparison and page audits

**0.8.0 adds portable review files, restores comments on their original page, and simplifies the review sidebar.** Settings combines AI and Jira configuration. Icon viewport controls, a shortcut cheatsheet and a collapsible notebook sidebar keep the workspace compact.

Diffuse uses a native Chrome side drawer for review controls. **Start review** opens it; for an active review, click the extension icon and **Open review sidebar**. There is no floating toolbar. The webpage resizes beside Diffuse, and closing the drawer preserves the review and unfinished comment. Chrome chooses the drawer side and owns its resize handle.

Keep both comparison pages in one Chrome window. Background tabs may retain their old viewport until activated, so visit the prototype once and return after changing the drawer width if the viewport warning appears. Native drawer pixels are excluded from screenshots and recordings. New comment pins follow their captured element or area anchor through scrolling and responsive layout changes. Pins leave the screen with their target instead of sticking to the viewport edge. Older area captures without anchors retain their recorded document position; an original screenshot remains available when a target cannot be located. AI preview highlights remain tied to their captured viewport. The existing Chrome toolbar gesture is still required to grant capture on each reviewed tab. Selecting a new tab from a persistent drawer does not itself grant capture access.

Diffuse layers a **continuously running prototype** over a production page in Chrome. Drag a reveal divider, change opacity, and compare while the prototype keeps rendering. The source is a live tab video stream, including its animations and changing state.

**AI findings and reports** use: **Current → Change to**, descriptive correction guidance, one issue per finding, larger focused evidence and image zoom. Prototype close-ups use independently identified reference regions. Existing saved wording and evidence stay unchanged.

## Install in Chrome

1. Use Chrome 116 or later.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the **`extension` folder inside this project**. Do not select the project folder itself.
4. Pin **Diffuse — Live design comparison** in Chrome’s extensions menu.

The extension loads directly from its files; no build step is needed. If Diffuse updates while a page is open, its old controls stop and show a refresh notice. Unsaved comment text remains available to copy before refreshing; an interrupted Save is never retried automatically. After changing extension code, choose **Reload** on its card in `chrome://extensions`, then refresh both comparison pages.

**Upgrading an existing installation:** replace the extension files in the same installed folder, then choose **Reload** on the existing extension card. Do not remove and reinstall the extension or load it from a different folder path: saved reviews belong to its extension ID in this Chrome profile. Keep that installation path unchanged to preserve access to them. Use **Export review** to share a complete review that another Diffuse installation can import.

## Review a local HTML file

For a page opened directly from your computer (`file:///…/page.html`), open `chrome://extensions`, choose Diffuse’s **Details**, and enable **Allow access to file URLs**. Return to the HTML page, reopen Diffuse and start the review. Diffuse also offers a settings shortcut when file access is off. Chrome requires this separate setting for local files; the extension cannot enable it for you. Local files can also be selected as live references. Localhost development servers continue to work with normal per-site permission.

## Start a review, then add Diff when needed

Start on the page being reviewed: click the Chrome extension icon, choose **Start review**, and allow access to that page. The side drawer gives you comments, region selection, recording, AI review and reports. There is no upfront audit/comparison choice.

Choose **Diff** in the drawer when you want a live reference. Select an open reference tab, grant that selected site access, then confirm **the same tab** in Chrome’s sharing dialog. A capture handle identifies the selected reference; a mismatched tab or non-tab surface is rejected before replacing the working stream. The live reference stays in the offscreen capture document, so closing the small selector window does not stop it.

With **Link scroll** off, wheel or trackpad scrolling over the production side moves production; scrolling over the prototype side moves the reference tab. Nested scroll panels are chosen using the pointer position. **Link scroll** optionally synchronizes production scrolling with the reference.

The existing divider and opacity controls appear once connected. **Hide reference / Show reference** toggles the overlay. Use Diff again to change or remove the reference. The review identity and saved evidence stay together across these changes, and each saved observation retains its own captured page/reference context. Reference changes wait until pending comments, recordings, captures and AI actions are finished. Cancellation preserves the current reference.

**Start review** opens the native Chrome side drawer. To reopen it during a review, click Diffuse’s extension icon and choose **Open review sidebar**. The drawer resizes the page and keeps unfinished comments when closed. Chrome controls its side and resize handle. Visit the reference once after resizing if a viewport mismatch appears: inactive tabs may retain their previous dimensions. A full reference reload clears its capture identity; choose it again through Diff. Saved comments remain intact.

**Keyboard shortcuts:** `Alt+Shift+D` toggles a connected reference; `Alt+Shift+P` switches between reference and reviewed page. Tap **C**, release it, then click an element to leave a comment; hold **C + left-click-drag** to select an area. Escape cancels. The shortcuts are ignored while typing in an editable field.

Page clicks operate the reviewed page. Switch to the reference to interact with it. Scroll linking does not synchronize menus, form inputs or application state.

## Responsive viewport views

Use **Desktop (1440 × 900)**, **Laptop (1280 × 800)**, **Tablet (1024 × 768)**, or **Phone (390 × 844)** in the drawer. These change real CSS layout dimensions and media queries on the reviewed page and its connected reference. They do not emulate a device operating system, mobile user agent or touch input. **Reset / Use window size** restores normal sizing; ending the review releases viewport control too.

Chrome requires the extension's **debugger** permission for these controls and shows a debugging notice while a preset is active. Close DevTools on the review tabs before using a preset; Diffuse does not take over another debugger. A pending comment, capture, recording or AI operation must finish before switching.

Every captured comment keeps its viewport view and exact dimensions. Pins and drawer comments show the current view; report filters let you see all views or one at a time. Jira descriptions and exports include the captured viewport. Comments without a saved viewport label are grouped by their recorded width (1440px and above: desktop; 1280–1439px: laptop; 768–1279px: tablet; below 768px: phone). Existing saved labels remain unchanged. Comments without dimensions remain accessible in every live view and under Unspecified viewport in reports.

## Comment with screenshot evidence

Starting from the reviewed page’s actual Chrome toolbar icon grants that page’s initial capture access. A persistent drawer on a newly selected tab does not grant access by itself. If needed, click Diffuse in Chrome’s toolbar on the reviewed page and choose **Enable capture & return**; a pending capture retries without discarding its draft.

1. Open the page and state you want to review. If you have connected a reference through **Diff**, bring both apps into matching states and wait for the live reference.
2. Tap **C**, release it, then click the reviewed element to leave a comment. Hold **C** and drag to select an area. Press Escape to cancel.
3. Diffuse hides its interface briefly and captures the reviewed page, plus the reference when connected, **before** opening the comment form. The selected element receives a marked screenshot and a contextual crop alongside the original screenshot.
4. Write an **Actual / comment** description. **Title and expected result are optional**; a blank title displays a short excerpt from your observation. Add reproduction steps when useful.
5. **Save comment** stays visible at the bottom while the fields scroll. Under **Attach evidence**, keep **Screenshot** or choose **Short recording**. Check the component name, name the state, choose a category and severity, and save.

If a page reload interrupts the drawer connection, **Reconnect review** restores the pending evidence and your typed fields. Save again after reconnection; recovery never silently submits a comment.

For a region instead of an element, hold **C** while dragging with the left mouse button. A dotted rectangle shows the selected area. Region comments attach its bounds without claiming a component identity. Audit mode uses the same flow with one page screenshot.

Categories use visible labels and consistent colors in the composer, pins, reports, and HTML exports: **Design mismatch — purple**, **UX issue — amber**, and **Copy change — blue**. Comparison comments default to Design mismatch; audit comments default to UX issue. Category and severity are separate fields.

Each comment keeps its captured evidence, URLs, viewport and alignment information, and available element details. Production evidence is a PNG browser screenshot; prototype evidence is a frame from the live capture. Both have timestamps, and the capture timing difference is recorded. Moving or changing the live pages later does not move the saved screenshot annotation.

Saved comments also appear as numbered **pins on the current page and viewport view**. New element and area comments retain a DOM anchor and relative bounds, including nested scrolling. Pins follow that content through scrolling and layout changes; if the target leaves the visible area, its pin and open bubble leave with it. Fixed and sticky elements keep their actual positions. A missing or replaced target does not receive a guessed pin. Earlier area captures cannot gain a historical DOM anchor retroactively; their original screenshots remain the reliable reference.

Comments have stable numbers across viewport filters. Click a pin to open its comment bubble and **Open in review** for its evidence. The original screenshot and annotation never change when the live page does.

Component suggestions come from observed `data-component`, `data-testid`, role, or tag information and are editable. Diffuse does not inspect React/Vue internals or prove that a DOM element maps to a particular source component. Element details include its selector and breadcrumb, bounds, computed typography/color/spacing/layout, observed ARIA and control states, and scroll containers. The inspector does not read form values or passwords. Screenshots still show whatever is visibly on the page.

The state field starts as **Current state**. Replace it with a useful label such as “validation error” or “menu expanded.” These are your labels for captured conditions; they do not claim other states have been checked.

## Add a short recording

In the comment form, choose **Short recording**, then **Start recording**. The form temporarily moves out of the way so you can interact with the page. Click **Stop recording** to return to it; recording stops automatically after **30 seconds**. Your text, selected element or region, and original screenshot context are preserved. Preview the clip or use **Record again** before saving.

The clip captures the whole visible page as you interact, including Diffuse’s controls and any live prototype overlay. A selected region is screenshot context, not a video crop. No microphone or tab audio is recorded. Keep **Short recording** selected to attach the clip; choosing **Screenshot** before saving excludes the clip from the saved comment.

The drawer’s **Record page** control is available throughout the review. They first capture clean starting screenshots—paired in comparison mode, one in audit mode—and open the comment form afterward. These page-level recordings start with an editable page component label. Ending the session with **Stop** preserves an unfinished recording in the report.

## Optional AI review with your own key

1. Open **Settings → AI review** from the popup or sidebar. Enter your **Anthropic API key**, select a vision-capable Claude model, and save. Allow the Anthropic connection if Chrome requests it.
2. By default, the key is kept only for the current Chrome session and may need to be entered again after reloading the extension. **Remember my key on this device** stores it in this Chrome profile between sessions. This is local extension storage, not an encrypted password vault. Use **Remove key** to clear it. A saved key is not displayed back in the form.
3. Return to the reviewed page and open **AI review**. Reopen the panel after changing settings so it picks up the updated connection. Add optional instructions and choose a minimum issue size.
4. Click **Run AI review**. This explicitly sends the current production screenshot, the prototype screenshot in comparison mode, and your instructions **directly to Anthropic**. Usage is billed to your Anthropic API account. Opening the panel or changing its threshold does not run a request.
5. Review each pending suggestion. **Show area** previews its approximate bounds in purple; it is visibly separate from saved comment pins. Choose **Accept comment** to save it with evidence, or **Dismiss** to remove it from the pending list.

The **0–100 minimum issue size** is a filter for the model’s estimated finding magnitude, with a default of **35**. Lower values include more minor details; higher values focus on findings the model rated as larger. Changing it locally reveals or hides suggestions from the existing batch without calling the model again. This subjective score is separate from **confidence**, which describes the model’s estimated certainty. Neither is an exact pixel tolerance, a calibrated error rate, or a guarantee of correctness. If the filter hides suggestions, **Show all** reveals every pending finding from that review without a new request. **Accept all shown (N)** adds only the findings currently passing the filter, each with its captured screenshot and engineering context. Show all first to include every pending finding. Accepted findings are skipped on retry; failed additions remain pending. The review summary and limitations are expandable below the suggestion cards.

Comparison mode can suggest design mismatches, UX issues, and copy changes. An audit has no design baseline and uses visual heuristics for potential UX or copy issues. Claude sees the captured viewport: it does not operate the app, inspect hidden states, or verify every interaction. The panel shows any returned limitations so you can judge the suggestion against what was actually captured.

Pending suggestions do not become pins or exported comments until accepted. The configured API key is never added to comments, report exports, or messages to the inspected page. Any sensitive information already visible on the reviewed page is still part of its screenshot.

AI errors distinguish authentication, model access, API credit, rate limits, and recognized request-format problems. When available, the message includes a safe HTTP status and request ID for troubleshooting. Automated regression checks use local response fixtures and do not spend API credits.

## Review, copy, and export

Open **Review reports** in the side drawer or extension popup. The notebook lists saved reviews, including earlier comparison sessions. You can edit a comment’s written fields while keeping its original evidence, or delete comments and reviews. **Hide** moves a review to the **Hidden** list without deleting anything; **Restore** brings it back. Severity uses labeled, color-coded radio choices. Category and viewport filters share one horizontally scrollable row.

Reports include your manual comments and accepted AI comments, with their categories. Pending and dismissed AI suggestions are not exported. API keys are never exported.

The **⋯ Review options** menu beside the review title contains the sharing and download actions. **Delete** remains beside it.

- **Copy entire report** copies formatted text and screenshot content for pasting into a document or ticket. Image support depends on the destination; use **Copy image** or **Download image** when it strips images. A plain-text fallback is shown if rich copying is unavailable.
- **Download HTML** saves a self-contained report with embedded screenshots and playable recordings for reading offline.
- **AI handoff .md ↓** exports every saved finding across all viewports in one concise Markdown file: overall task, finding IDs, Current → Change to → Verify, captured context, and evidence filenames. It omits image/video data so a coding assistant can use it efficiently. Include the HTML report or referenced evidence files for visual verification. No new AI request is made.

Accepted AI findings also include a collapsible **Suggested AI prompt** with **Copy AI prompt**. Jira descriptions preserve this prompt in a copyable code block, with Current, a highlighted Change to panel, context, numbered steps, and evidence filenames. Jira uses its native styling; screenshots and recordings are uploaded as attachments.

Pasting a report into another app does not preserve playable video: the copied report represents it with screenshots and a filename. Use the Jira flow below to send selected observations and attach their saved files directly.

## Share a review with another Diffuse user

Open the **⋯ Review options** menu beside the review title and choose **Export review** to download a `.diffuse-review.json` file. It includes every saved comment across pages and viewports, the captured URLs and anchors, written fields, screenshots, recordings and accepted AI context. Account credentials and local session identifiers are excluded.

The recipient chooses **Import review** in their notebook and selects that file. The import creates a separate saved review, preserving existing reviews. **Open review page** opens the saved URL and restores the comment pins. Chrome may first ask for access to that site. Clicking a comment in the sidebar returns to its captured URL and viewport, then reveals its location.

The recipient needs access to the reviewed website. An export does not include the website itself, its login session, or unsaved application state. Local files and localhost addresses must also exist on their computer; original screenshot and recording evidence remains readable in the notebook even when the page is unavailable. A live Diff reference can be connected again separately.

The notebook sidebar can be collapsed and expanded using its sidebar icon. **Settings** at the bottom of the sidebar brings AI configuration, Jira accounts and page-access information together.

## Send selected observations to Jira

1. Open **Settings → Jira connections** from Diffuse and choose **Connect Jira**. Connections keep the Atlassian account and its authorized sites separate. Jira sign-in is independent of your Anthropic key.
2. In a saved review, use **Send to Jira** on one observation, or mark **Select for Jira** on several and choose **Send selected to Jira**. **Select visible** adds the currently visible observations; filtering does not silently clear selections, and the count identifies selected items hidden by the filter.
3. Choose the connected account, site, project and issue type. Complete the project's required fields, then review each ticket's title, description and evidence. Field values chosen in this preview apply to every selected observation. Unsupported required field types block submission rather than being omitted.
4. Choose **Create N tickets**. Each selected observation becomes one issue, with readable Current/Requested change text, component, state, reproduction steps, category, severity and captured page links where available. Its saved screenshots or recording upload as attachments.
5. Keep the report open while sending. Follow each item's status and resulting Jira link. Reopening and resuming uses the saved delivery; an already-created issue is reused for remaining evidence.

A confirmed rejection can be retried explicitly. If Jira may have accepted a request but the response was lost, Diffuse requires a manual check in Jira and blocks another automatic write. It does not treat missing evidence as a fully successful delivery. Files are limited to 20 MiB each, 40 MiB per observation and the site's own attachment limit; evidence is validated before creating the issue.

**Current rollout:** the backend is configured, but real Atlassian authorization and live ticket creation have not yet been verified. The Atlassian app currently allows its owner only. Enabling other accounts requires app sharing to be configured separately; new Diffuse installation IDs also require server approval. The connection UI supports separate accounts once those access requirements are met.

## Try the included demo

The two demo pages are self-contained and use no external assets or services. With Node.js installed, open a terminal in this project folder and run:

```sh
npm run demo
```

For the new **Forma studio** showcase used in the portfolio film, open [Forma production](http://127.0.0.1:4178/showcase-production.html) and [Forma prototype](http://127.0.0.1:4178/showcase-prototype.html). These fictional pages include intentional hierarchy, spacing, copy, and button differences, plus a working project drawer. Start a review on the production tab, then choose **Diff** and select the prototype as the reference. The marketing film labels its illustrative AI results as simulated; the normal extension still uses your own Anthropic key when you explicitly run AI review.

Keep that terminal open, then open both pages in Chrome:

- [Production demo](http://127.0.0.1:4178/production.html)
- [Prototype demo](http://127.0.0.1:4178/prototype.html)

Activate Diffuse **from the production demo**, choose **Start review**, then use **Diff** to select the prototype demo. Confirm that same prototype tab in Chrome’s sharing dialog. The demo server listens only on `127.0.0.1:4178`. It serves a fixed list of demo assets and does not expose the rest of the workspace. Stop it with `Ctrl+C`. If that port is in use, run `PORT=4179 npm run demo` and change the links accordingly.

### Things to try

- **Check that the view stays live.** Watch the clock, pulsing green dot, and moving activity bar in the top right. There is no refresh button for the prototype video. The counter continues to change while you compare. If your operating system requests reduced motion, the animations stop but the clock still updates.
- **Find the intentional design differences.** Production has a slightly larger heading, more space above the subtitle, taller metric cards, a wider/taller primary button with a different green, and a wider gap between the main panels.
- **Try the dropdown.** Switch to the prototype and open **This week**. Return to production to see that state in the live reference. Open the same menu in production manually to compare matching states. The menu supports arrow keys, Home/End, Enter/Space, and Escape.
- **Try a modal.** Open **New project** on either app. Tab moves between fields and buttons; Escape closes it. The other app stays in its own state until you open its dialog too. Creating a demo project shows a confirmation but saves no data.
- **Scroll the page.** Move down to **Coming up next**. Compare root scrolling with **Link scroll** enabled and disabled.
- **Scroll inside Latest activity.** The activity panel is separately scrollable. Both pages mark it with `data-diffuse-scroll="activity"`, so it has a stable match. Focus the panel to scroll it with the keyboard.
- **Hide and stop.** Hide the reference, show it again, then stop. Confirm the normal production page remains usable.
- **Leave a comment.** Enable capture from the production tab’s Chrome toolbar icon. Select a metric card, describe its spacing difference, and save. Open **Review** to inspect the marked screenshot and element details.
- **Record an interaction.** Capture a short dropdown or dialog comparison, stop recording, and save the comment. Download HTML to keep both screenshots and the playable clip in one file.

Both demo pages intentionally reject iframe embedding. They still work with tab capture, which is the approach used here.

## Permissions and data

Diffuse requests access to the reviewed site when you start a review and to the reference site when you connect it through **Diff**. Chrome’s extension permissions also allow listing tab titles/URLs for the page picker, injecting the controls and inspector, saving local settings and reviews, and capturing the selected tabs. The reviewed page’s capture access is granted through its Chrome extension icon; the live reference requires confirmation in Chrome’s tab-sharing dialog.

The prototype video travels locally inside Chrome using an offscreen extension document and a local WebRTC connection. Saved reviews, screenshots, metadata, and recordings are stored in the extension’s local **IndexedDB** database in this Chrome profile and persist across comparison sessions. They are not synced to another profile or device. Removing the extension or clearing its data can remove them; keep the same installation folder and use **Reload** for upgrades.

Manual comparison and saved reviews remain local until you explicitly share them. Jira connections use the hosted Diffuse service: it stores encrypted Atlassian grants and durable delivery snapshots/receipts, and receives only the observations and evidence selected for submission. Evidence bytes are deleted after successful attachment upload; unfinished evidence expires after seven days. The service sends the selected ticket text and files to Jira. Connection credentials stay in trusted extension contexts, not inspected-page scripts or reports. There is no analytics service. Optional AI review sends the explicitly requested screenshots and instructions directly to Anthropic using your configured key; Anthropic’s API usage is billed to your account. The key is available only to trusted extension contexts, with session storage by default and optional local persistence as described above. The underlying apps continue to make their own normal network requests. Copying, downloading, and sharing reports are explicit actions you take.

Chrome can retain previously granted site permissions. Manage or revoke them in the extension’s **Details → Site access** settings.

## Current boundaries

- **Match viewport and zoom.** Viewport presets apply the same CSS layout dimensions to the reviewed page and its reference. In window-size mode, match viewport size and zoom before judging alignment. Chrome can keep a captured background tab at its previous size: after resizing the browser, open **Prototype ↗** once, then return with **Alt+Shift+P**. Diffuse updates the capture dimensions when the prototype resizes. A mismatch warning signals when sizes differ; pixel nudges correct offsets, not different responsive layouts.
- **One review session at a time.** A comparison uses two tabs; an audit uses one. Keep the session’s tabs open. Navigation, capture interruption, browser lifecycle changes, or changing site permissions may require reconnecting or starting again.
- **Linked scrolling is approximate when layouts differ.** Different content heights, virtualized lists, sticky elements, and custom scroll behavior can prevent a perfect match. New comparisons scroll independently by default; turn on **Link scroll** when matching page positions is useful.
- **Nested scrolling needs a reliable match.** A shared `data-diffuse-scroll` label is the strongest option. Cross-origin frames, closed shadow roots, canvas-based interfaces, and unrelated app structures may not expose comparable scroll targets. Their visuals may still appear in the captured video.
- **Application states are independent.** There is no automatic click replay, form synchronization, or semantic state matching in this milestone. Bring each app into the intended state separately.
- **Native dialogs are supported.** The selection overlay remains usable over ordinary HTML modal dialogs. Dialogs inside closed shadow roots and custom application focus traps have not been validated.
- **Page access.** HTTP/HTTPS, localhost and local HTML files are supported. Local files require Chrome’s **Allow access to file URLs** setting. Browser settings pages, new-tab pages and protected browser surfaces cannot be reviewed.
- **Live capture uses resources.** Frame timing and visual quality depend on Chrome, the page, and the machine. This build does not promise a fixed frame rate, pixel-perfect video compression, or zero latency.
- **Evidence is a viewport checkpoint.** Screenshot evidence captures the visible viewport, not an automatically stitched full page. The prototype image comes from the live stream, so its quality depends on that capture. The two images are timestamped but are not an atomic, simultaneous capture; moving content can differ between them.
- **Element details are observed context.** DOM labels, selectors, styles, and ARIA states help describe what was captured. They do not provide framework source attribution, automatic component matching, or exhaustive state coverage. Cross-origin frame contents and closed shadow-root internals cannot be inspected by the page picker.
- **AI review is screenshot-based.** It can miss issues or suggest changes that are intentional. A single-page audit has no baseline; threshold and confidence scores are model estimates. No automatic hidden-state testing or exact pixel-difference guarantee is provided.

## Next milestones

1. **Repeatable state comparisons:** save separate interaction recipes for each app and named checkpoints. Report unavailable states explicitly rather than claiming they passed.
2. **More issue trackers:** add Asana and ClickUp alongside the Jira handoff. Copy and download remain available for other destinations.

Continuous live comparison remains the main working view throughout these additions.

## Development checks

The extension itself has no runtime packages or build step. Node.js runs the demo server and checks:

```sh
npm run check
npm test
```

For the optional real-browser integration suite, install development dependencies and the test browser first:

```sh
npm install
npx playwright install chromium
npm run test:browser
```

The browser suite uses a fresh temporary profile and a temporary extension copy that pre-grants only local fixture hosts. It exercises actual tab capture and local video delivery. It does not automate Chrome’s native optional-site-permission approval dialog. The shipping manifest retains optional site permissions. The test browser is launched with mock-Keychain and basic-password-store flags and does not use your normal Chrome profile.

The live comparison checks cover background updates, source resolution, reveal/opacity/alignment, initial and nested scrolling, independent application interaction, native modal layering, resizing, reloads, and capture cleanup. Isolated content-interface checks also exercise element picking, metadata, form-value exclusion, evidence hiding, comment forms, permission retry, and recording controls. See `artifacts/test-results.json` for the completed integration results. Your authenticated production and prototype pages have not yet been tested.

The same browser suite verifies actual screenshot permission retry, paired evidence with element metadata, real silent recording, immutable evidence after editing, rich clipboard contents, offline HTML with playable video, deletion, review persistence, and the 30-second recording limit with reload recovery. Unit regressions cover recording finalization races and export safety. Run `npm run package` to create the versioned ZIP and update the stable `releases/Diffuse` installation folder.

The audit checks use local AI-response fixtures to exercise region gestures, pins and bubbles, category selection, score filtering, suggestion previews, and explicit individual/bulk acceptance and dismissal. See the integration results for completed full-extension checks. These automated checks do not verify a particular account's model entitlement or a live provider response.

Run `npm run test:audit-browser` for the full-extension audit and AI approval suite. It redirects only its disposable test copy to a local streamed-response fixture; it never uses a real key or paid provider request. Results are saved in `artifacts/audit-test-results.json`.

Run `npm run test:accessibility` for the overlay's focused keyboard, non-drag selection, minimum text/control size, 200% Chrome zoom, and 320 CSS-pixel reflow checks. The popup, settings, report, and offline export also received targeted browser and palette-contrast checks. These checks cover the extension interface; they are not a complete accessibility audit of arbitrary reviewed pages.

Run `POPUP_HEADED=1 npm run test:popup` to check the actual Chrome toolbar popup in a temporary profile. It verifies native sizing, visible primary actions, comparison/audit controls and access to secondary controls through focus and scrolling. Opening `popup.html` in a normal tab does not exercise Chrome's automatic popup sizing. Chrome disables native zoom on extension popup pages; this check runs at the popup's default zoom.

The provider implementation follows Anthropic’s official [vision](https://platform.claude.com/docs/en/build-with-claude/vision), [structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), and [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) documentation. The default model is configurable in AI settings; available models and account access can change.

## Coming soon

**Asana** and **ClickUp** integrations are planned. Jira handoff is implemented in 0.7.0, with the current rollout and verification limits described above.
