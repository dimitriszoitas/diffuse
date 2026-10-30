# Local interactive review with Playwright

Diffuse can use a local Playwright MCP companion to collect evidence from the current page before you ask AI to review it. The companion measures rendered styles, runs axe-core accessibility checks, samples hover and keyboard focus, and captures a screenshot. It uses a separate local Chromium profile. It does not connect to your personal Chrome profile or reuse its cookies.

## Install and start

Install Node.js 20 or newer, then run these commands from the Diffuse source folder:

```sh
cd local-browser
npm ci
npm run install:browser
npm start
```

On macOS, you can instead double-click **Start Local Browser.command** inside `local-browser`. It checks Node, installs the pinned dependencies and Chromium if missing, then starts the helper in a terminal window. First setup needs internet access; subsequent starts use the installed files.

Keep that terminal open while using interactive review. The service listens only at `http://127.0.0.1:8932`; no cloud browser or remotely hosted service is needed. Dependencies are pinned in `local-browser/package-lock.json`.

On first start it creates `local-browser/.local/pairing-token`. The containing directory has owner-only permissions and the token file is mode `0600`. Copy the contents into Diffuse's local browser pairing field. Do not share this token: it authorizes requests to the companion. The terminal prints the file path, not the secret. Stop the service and remove the token file to rotate it, then start and pair again.

The packaged extension ID is `gdoidkknjbnfmeikloaafdohpjlafgbj`. The companion accepts that exact extension origin, the exact loopback Host, and the pairing bearer token. It does not expose an arbitrary MCP tool endpoint or accept JavaScript supplied by the extension, an AI, or a web page. Only fixed Diffuse audit collectors can run.

## Review a page

1. Open **Review with AI** and choose the local interactive audit.
2. Choose the checks you want and open the website in the audit browser.
3. Log in yourself if needed. Navigate to the page and state you want to inspect.
4. Return to Diffuse and choose **Run checks**. Collection starts only after this action. The current page must be on the same origin as the URL you approved. Authentication may temporarily use another origin before collection; return to the approved website first.
5. Read the collected evidence. Ask AI to interpret it only when you are ready to send the selected evidence to your configured provider.

During collection, all new top-level navigation and additional browser tabs are blocked, including same-origin navigation. This keeps the audit on its current page and prevents navigation redirect chains from leaving scope. Normal page assets and API requests still work. The page's own scripts and its network activity are not sandboxed away from their usual permissions. Only use a site you intend to inspect.

The initial version audits **one current page**. It does not crawl every route, run a journey, click buttons, enter text, submit forms, or create a video. Hover and Tab events can trigger behavior implemented by the website itself. The browser closes when collection completes or you stop it. Its dedicated profile preserves login state for later audits; delete `.local/profile` while the service is stopped to clear it.

## What the evidence means

| Check | Collected evidence | Limits |
|---|---|---|
| Styles | Computed font family, size, weight, line height, colors, spacing and radii; occurrence counts and example selectors | Up to 2,500 rendered DOM elements and 150 groups per category. Counts refer to sampled DOM elements, not every component instance in the product. Virtualized/off-page routes are not included. |
| Accessibility | axe-core violations, incomplete checks, affected selectors and source links | Automated checks do not establish full WCAG conformance. Screen-reader behavior, meaning and task usability need manual assessment. Frames and closed shadow roots have limitations. |
| Interactions | Before/after computed styles for up to three visible controls; six Tab focus observations | A style change is evidence, not a pass/fail usability judgment. Sampling does not exhaust every state or establish keyboard reachability of the whole page. |
| Screenshots | A JPEG before checks and another after interaction checks, with viewport dimensions | May include private page content. No video is captured. The first screenshot remains available if later checks fail or you stop. |
| Diagnostics | Count of console/page errors | Error bodies, network response bodies, credentials and cookies are not included. |

The service limits collection to two minutes, bounds individual MCP calls, permits only one active audit, and closes its MCP process on cancellation. This is an **audit collection limit**, unrelated to the journey action target. Stop, errors and restarts preserve partial evidence and the step trace.

## Local storage and AI processing

The companion stores its token, dedicated browser profile and audit JSON under `local-browser/.local/`. These files are gitignored. Screenshots generated by MCP are bounded in `.local/mcp-output`; saved audits are in `.local/audits`. The companion makes no Anthropic or OpenAI calls. It does not upload evidence to Diffuse's backend.

When you explicitly request AI interpretation in Diffuse, the selected text evidence is sent to the active AI provider using the configured connection. Screenshots stay local for this first version. Using a local browser does not make cloud AI processing local. Check page text and URLs before sharing evidence.

To remove local data, stop the companion and delete `.local/`. This removes pairing, saved audit files and the dedicated login profile; extension reports already saved in Chrome remain separate.

## Verify the companion

```sh
cd local-browser
npm test
npm run test:integration
```

The integration check opens only a disposable localhost fixture in a fresh temporary browser profile, exercises the real MCP transport and removes its test data afterward. It uses the pinned Chromium build installed by `npm run install:browser`; optionally set `DIFFUSE_TEST_BROWSER` to another compatible browser executable. It never attaches to a running personal Chrome instance.

Official references: [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Playwright page evaluation](https://playwright.dev/docs/evaluating), [automated accessibility testing](https://playwright.dev/docs/accessibility-testing), and [axe-core](https://github.com/dequelabs/axe-core).
