(() => {
  if (globalThis.__diffuseLiveController) return;
  globalThis.__diffuseLiveController = true;

  let contextInvalidated = false;
  let contextTimer = null;
  let session = null;
  let role = null;
  let host = null;
  let root = null;
  let video = null;
  let peer = null;
  let connectionId = null;
  let settingsTimer = null;
  let scrollFrame = null;
  let referenceWheelFrame = null;
  let pendingReferenceWheel = null;
  let resizeTimer = null;
  let localWarning = '';
  let viewportActionBusy = false;
  let abort = null;
  let reconnectTimer = null;
  let frameCallback = null;
  let connectionDeadline = null;
  let modalObserver = null;
  let pickerAbort = null;
  let picking = false;
  let hoveredElement = null;
  let selectedElement = null;
  let selectionMetadata = null;
  let commentDraft = null;
  let evidenceChoice = 'screenshot';
  let captureBusy = false;
  let commentSaving = false;
  let pendingCaptureAction = null;
  let recording = null;
  let recordingTimer = null;
  let recordingBusy = false;
  let evidencePreviouslyHidden = null;
  let areaArmed = false;
  let areaDrag = null;
  let cHeld = false;
  let cGestureUsed = false;
  let ignoreNextAreaClick = false;
  let pinsTimer = null;
  let openPinId = null;
  let pinItems = [];
  let pinsUrl = '';
  let pinsViewport = '';
  let aiConfig = {hasKey:false,model:'',threshold:35};
  let aiBatch = null;
  let aiBusy = false;
  let aiOperationBusy = false;
  let aiBulkAccepting = false;
  let aiThresholdOverride = null;
  let aiSavedThreshold = null;
  let aiPreviewContext = null;
  let docked = false;
  let panelNotifyTimer = null;
  let draftEvidenceRevision = 0;
  let commentFieldRevisions = new Map();

  const viewport = () => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio});
  const reloadMessage = 'Diffuse was updated. Refresh this page, then reopen Diffuse.';
  function runtimeAvailable() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }
  function reloadError() {
    return Object.assign(new Error(reloadMessage), {code: 'EXTENSION_CONTEXT_INVALIDATED'});
  }
  // sendMessage can throw before returning a Promise after an extension reload.
  // Normalize both failure paths, and never retry a potentially completed write.
  async function send(type, data = {}) {
    if (contextInvalidated || !runtimeAvailable()) { invalidateContext(); throw reloadError(); }
    try {
      const result = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, sessionId: session?.id, ...data});
      if (contextInvalidated || !runtimeAvailable()) { invalidateContext(); throw reloadError(); }
      return result;
    } catch (error) {
      if (contextInvalidated || !runtimeAvailable() || /extension context invalidated/i.test(error?.message || String(error))) {
        invalidateContext(); throw reloadError();
      }
      throw error;
    }
  }
  const quietSend = (type, data) => send(type, data).catch(() => {});
  const el = id => root?.getElementById(id);
  const hasReference = () => Number.isInteger(session?.sourceTabId);
  const isAudit = () => !hasReference();
  const categoryLabel = value => ({'design-mismatch':'Design mismatch','ux-issue':'UX issue','copy-change':'Copy change'}[value] || 'Design mismatch');
  const commentTitle = fields => fields?.title || (fields?.comment || '').split(/\r?\n/).find(line => line.trim())?.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Saved comment';
  function colorCategory(node, value) {
    if (!node) return;
    const colors = {'design-mismatch':['#c9adff','#38205d'],'ux-issue':['#ffd28a','#5e3908'],'copy-change':['#9bd5ff','#123f60']};
    const category = colors[value] ? value : 'design-mismatch';
    node.dataset.category = category;
    node.style.setProperty('--category-color', colors[category][0]);
    node.style.setProperty('--category-ink', colors[category][1]);
  }

  const styles = `
:host{all:initial!important;position:fixed!important;inset:0!important;display:block!important;z-index:2147483647!important;pointer-events:none!important;color-scheme:dark!important;contain:layout style!important;--ink:#211a35;--panel:#241c35;--raised:#342844;--text:#fcfaff;--muted:#d2c7df;--line:#9381ae;--accent:#c9adff;--coral:#ff9b85;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important}
:host::backdrop{background:transparent!important;pointer-events:none!important}:host([data-evidence-hidden]){visibility:hidden!important}
:host([data-docked]) #comment-panel,:host([data-docked]) #ai-panel,:host([data-docked]) #panel-backdrop{display:none!important}
*{box-sizing:border-box}[hidden]{display:none!important}button,input,textarea,select,summary{font:inherit}button,summary{cursor:pointer}button,input,textarea,select,summary{scroll-margin:84px 12px 20px}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px;box-shadow:0 0 0 2px #211a35}button:disabled{opacity:.55;cursor:default}
button,summary{min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:9px 13px;background:var(--raised);color:var(--text);font-size:16px;line-height:1.4;white-space:normal}button:hover,summary:hover{background:#49365f}input,textarea,select{color:var(--text);background:#171122;border:1px solid var(--line);border-radius:9px;padding:10px 12px;min-height:44px;min-width:0}input::placeholder,textarea::placeholder{color:#bbb0ca;opacity:1}input[type=range]{padding:0;accent-color:var(--accent);border:0;background:transparent;min-width:80px}input[type=checkbox]{accent-color:var(--accent);width:22px;height:22px;min-height:22px;padding:0;margin:0;flex-shrink:0}
#layer{position:absolute;inset:0;overflow:hidden;pointer-events:none}#reference{position:absolute;top:0;left:0;max-width:none;max-height:none;object-fit:fill;pointer-events:none}#divider{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);box-shadow:0 0 0 1px #211a3580;pointer-events:none}#handle{position:absolute;top:38%;left:-23px;width:48px;height:64px;border:2px solid #fff;border-radius:24px;background:var(--accent);color:var(--ink);font-size:25px;pointer-events:auto;cursor:ew-resize;touch-action:none;box-shadow:0 4px 18px #211a3555}
.edge-label{position:absolute;top:16px;padding:7px 12px;border-radius:8px;background:#211a35;color:#fff;font-size:14px;font-weight:650;line-height:1.4;letter-spacing:.03em;white-space:nowrap;text-transform:uppercase}.production{right:14px}.prototype{left:14px}
#toolbar{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);pointer-events:auto;font-size:16px;line-height:1.5;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:0 10px 38px #120c2455}.bar{display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap}.brand{display:flex;gap:12px;align-items:center;font-size:22px;font-weight:750;letter-spacing:-.5px;margin-right:6px}.mark{width:28px;height:30px;position:relative;flex-shrink:0}.mark:before,.mark:after{content:'';position:absolute;width:17px;height:25px;border:2px solid var(--ink);border-radius:6px;transform:rotate(-12deg)}.mark:before{left:0;top:0;background:var(--coral)}.mark:after{left:10px;top:5px;background:var(--accent)}
#status{font-size:14px;font-weight:550;color:var(--muted);display:flex;align-items:center;gap:8px;white-space:nowrap}#status:before{content:'';width:9px;height:9px;border-radius:50%;background:var(--coral)}#status[data-state=error]{color:#ffb6ac}#status[data-state=error]:before{background:#ffb6ac}#status[data-state=reconnecting]:before,#status[data-state=connecting]:before,#status[data-state=starting]:before{background:#ffd28a}.separator{height:32px;width:1px;background:var(--line)}.control{display:flex;align-items:center;gap:10px;white-space:nowrap;min-height:44px;font-size:14px}.control input[type=range]{width:90px}.control output{min-width:42px;color:var(--text);font-size:14px;font-variant-numeric:tabular-nums}#stop{background:transparent}#hide[aria-pressed=true]{border-color:var(--accent);background:#49345f}
details{position:relative}summary{list-style:none}summary::-webkit-details-marker{display:none}summary:after{content:'⌄';font-size:18px;margin-left:auto}details[open]>summary:after{content:'⌃'}.alignment{position:absolute;bottom:56px;right:0;width:330px;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px #120c2455}.alignment label{display:grid;gap:7px;color:var(--text);font-size:14px}.alignment input{width:100%;font-variant-numeric:tabular-nums}.alignment button,.alignment small,.reveal-field{grid-column:1/-1}.alignment small{color:var(--muted);font-size:14px}.reveal-field output{font-size:14px}
#warning{border-top:1px solid var(--line);padding:10px 16px;font-size:14px;color:#ffd28a;max-width:1100px;overflow-wrap:anywhere}#warning:empty{display:none}#comment,#area-comment{border-color:var(--accent);color:var(--accent)}#comment[aria-pressed=true],#area-comment[aria-pressed=true]{background:var(--accent);color:var(--ink)}#record[data-recording=true]{color:#211a35;border-color:var(--coral);background:var(--coral)}.review-bar{border-top:1px solid #756189}.review-bar .composer-note{margin:0}
#selection-outline{position:fixed;border:2px solid var(--accent);background:#c9adff18;box-shadow:0 0 0 1px #211a35;pointer-events:none;z-index:1}#selection-label{position:absolute;left:-2px;bottom:calc(100% + 6px);max-width:min(400px,90vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 9px;background:var(--accent);color:var(--ink);border-radius:6px;font-size:14px;font-weight:600}#selection-outline[data-region=true]{border-style:dotted;background:#c9adff20}
#comment-pins{position:absolute;inset:0;pointer-events:none}.comment-pin{position:absolute;transform:translate(-50%,-50%);width:44px;height:44px;min-width:44px;min-height:44px;border:2px solid #fff;border-radius:50% 50% 50% 8px;background:var(--category-color,#c9adff);color:var(--category-ink,#38205d);box-shadow:0 3px 12px #211a3570;padding:0;font-size:16px;font-weight:750;pointer-events:auto}.comment-pin:hover,.comment-pin[aria-expanded=true]{background:var(--category-color,#c9adff);filter:brightness(1.04);outline:2px solid #211a35;outline-offset:2px}
#saved-comment-bubble{position:absolute;width:380px;max-width:calc(100% - 24px);max-height:calc(100% - 32px);overflow:auto;pointer-events:auto;background:var(--panel);color:var(--text);border:2px solid var(--category-color,#c9adff);border-radius:16px;padding:18px;box-shadow:0 10px 35px #120c2455;font-size:16px;line-height:1.6}#saved-comment-bubble h3{font-size:20px;line-height:1.4;margin:14px 0}#saved-comment-bubble p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.bubble-top{display:flex;justify-content:space-between;align-items:center;gap:10px}.bubble-meta{font-size:14px;color:var(--muted)}.bubble-actions{display:flex;gap:10px;margin-top:16px}#saved-comment-category{display:inline-block;border-radius:7px;padding:5px 9px;background:var(--category-color,#c9adff);color:var(--category-ink,#38205d);font-weight:650}#saved-comment-highlight{position:absolute;border:2px dashed var(--category-color,#c9adff);background:color-mix(in srgb,var(--category-color,#c9adff) 8%,transparent);pointer-events:none}
#panel-backdrop{position:absolute;inset:0;background:#120c2428;pointer-events:auto;z-index:15}#comment-panel,#ai-panel{position:absolute;top:16px;right:16px;width:490px;max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;overscroll-behavior:contain;scroll-padding-top:88px;pointer-events:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 60px #120c2460;font-size:16px;line-height:1.55}#ai-panel{width:530px;border-color:var(--accent)}.composer-header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--panel);padding:18px 22px;border-bottom:1px solid #756189;z-index:1}.composer-header h2{margin:0;font-size:24px;line-height:1.3;font-weight:700;letter-spacing:-.5px}.composer-close{font-size:28px;width:44px;height:44px;padding:0;flex-shrink:0}.composer-body{padding:20px 22px 24px}.composer-field{display:grid;gap:8px;margin-bottom:20px}.composer-field>span{color:var(--text);font-weight:600}.composer-field small,.composer-note{font-size:14px;line-height:1.6;color:var(--muted)}.composer-field input,.composer-field textarea,.composer-field select{display:block;width:100%;font-size:16px;line-height:1.5;letter-spacing:normal}.composer-field textarea{resize:vertical;min-height:100px}.composer-field select{color-scheme:dark}.composer-row{display:grid;grid-template-columns:1fr 145px;gap:16px}.composer-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:20px}#comment-panel{display:flex;flex-direction:column;overflow:hidden}#comment-panel .composer-header{position:relative;flex-shrink:0;padding:14px 18px}#comment-panel .composer-header h2{font-size:22px}#comment-panel>.composer-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 18px;scroll-padding-block:12px}#comment-panel .composer-field{margin-bottom:16px}.composer-footer{flex-shrink:0;padding:12px 18px;background:var(--panel);border-top:1px solid var(--line)}.composer-footer .composer-actions{margin:0}.composer-footer .composer-error{margin:0 0 10px;max-height:22vh;overflow:auto;font-size:14px;padding:10px}#comment-panel:has(#comment-form[hidden]) .composer-footer .composer-actions{display:none}#comment-panel:has(#comment-form[hidden]) .composer-footer:not(:has(.composer-error:not(:empty))){display:none}#save-comment{background:var(--accent);color:var(--ink);border-color:var(--accent);font-weight:700}.composer-note{margin:10px 0 0}.composer-error{padding:14px;border:1px solid var(--coral);border-radius:10px;background:#46272f;color:#ffd9cd;font-size:16px;line-height:1.6;margin:14px 0;overflow-wrap:anywhere}.composer-error:empty{display:none}#capture-retry-description{margin:0 0 16px;color:var(--text);line-height:1.6}#selection-summary{font-size:14px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere;margin:0 0 20px}
.evidence-preview{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}.evidence-preview figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#171122}.evidence-preview img{display:block;width:100%;height:110px;object-fit:contain;background:#100c18}.evidence-preview figcaption{padding:8px 10px;color:var(--text);font-size:14px}.evidence-choice{border:0;padding:0;margin:0 0 16px}.evidence-choice legend{font-weight:650;color:var(--text);margin-bottom:10px}.evidence-options{display:flex;gap:8px}.evidence-options button{flex:1}.evidence-options button[aria-pressed=true]{background:var(--accent);color:var(--ink);border-color:var(--accent);font-weight:650}#recording-choice{margin-bottom:18px}#recording-choice-note{margin:0 0 12px}#comment-record{margin-top:10px}#recording-preview{position:static;display:block;width:100%;height:190px;object-fit:contain;background:#100c18;border-radius:10px;pointer-events:auto}#comment-category{border-color:var(--category-color);color:var(--category-color)}#comment-category option{background:#171122;color:var(--text)}
#ai-suggestions{display:grid;gap:16px;margin-top:20px}.ai-suggestion{border:1px solid #a18cbd;border-radius:14px;padding:18px;background:#30233e}.ai-suggestion h3{font-size:21px;line-height:1.4;margin:12px 0}.ai-suggestion p{margin:10px 0;overflow-wrap:anywhere}.ai-suggestion h4{font-size:14px;line-height:1.5;font-weight:700;color:#dfcaff;margin:0 0 6px}.ai-current{margin-top:16px}.ai-current p,.ai-change p{font-size:16px;line-height:1.7;white-space:pre-line;margin:0}.ai-change{margin-top:16px;padding:16px;border-left:3px solid #ff9b85;border-radius:0 8px 8px 0;background:#ff9b8512}.ai-change h4{color:#ffb7a4}.ai-suggestion-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.ai-suggestion-meta{font-size:14px;line-height:1.6;color:#dfcaff}.ai-suggestion [data-action=accept]{border-color:var(--accent);color:var(--accent);font-weight:650}#ai-region-preview{position:absolute;border:3px dashed var(--accent);background:#c9adff18;pointer-events:none}#ai-region-label{position:absolute;left:0;top:0;padding:5px 9px;background:#6941c6;color:#fff;font-size:14px;font-weight:600}.ai-disclosure{padding:14px;background:#30243f;border:1px solid #9682ac;border-radius:10px;color:#e6d8fa;font-size:14px;line-height:1.6}.ai-empty{color:var(--muted);font-size:16px;line-height:1.6}.threshold-ends{display:flex;justify-content:space-between;gap:14px}.threshold-ends small{font-size:14px;color:#dfcaff}#ai-results-status{border:1px solid #a18cbd;border-radius:14px;background:#30243f;padding:18px}#ai-results-status h3{font-size:20px;line-height:1.4;color:var(--text);margin:0 0 10px}#ai-results-status p{margin:0;font-size:16px;line-height:1.6;color:#e6d8fa}#ai-show-all,#ai-accept-all{margin-top:14px;width:100%;font-size:16px;font-weight:700}#ai-show-all{background:#c9adff;color:#211a35;border-color:#c9adff}#ai-accept-all{background:#ff9b85;color:#211a35;border-color:#ff9b85}#ai-results-status .ai-filter-note{font-size:14px;margin-top:10px;color:var(--muted)}.ai-run-details{margin-top:8px}.ai-run-details summary{font-size:16px;white-space:normal}.ai-run-details p{margin:14px 0}
#comment-pins{z-index:2}#saved-comment-highlight,#ai-region-preview{z-index:3}#toolbar{z-index:10}#saved-comment-bubble,#comment-panel,#ai-panel{z-index:20}#picker-tip,#capture-progress{z-index:30}#picker-tip,#capture-progress{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:max-content;max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;padding:14px 18px;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--text);font-size:16px;line-height:1.5;box-shadow:0 8px 30px #120c2455}#picker-tip{pointer-events:auto}#picker-tip>span{flex:1;min-width:160px}#capture-progress{pointer-events:none}#area-coordinates{flex-basis:100%}#area-coordinates summary{width:100%;justify-content:space-between}#area-form{padding-top:14px}.area-fields{display:grid;grid-template-columns:repeat(4,minmax(60px,1fr));gap:10px;margin-bottom:14px}.area-fields label{display:grid;gap:6px;font-size:14px}.area-fields input{width:100%;font-size:16px}#area-error{color:#ffd9cd;font-size:14px}#area-error:empty{display:none}
@media(max-width:1100px){#toolbar{width:calc(100% - 32px)}.brand{margin-right:auto}.review-bar .composer-note{flex-basis:100%}.bar{gap:10px}.separator{display:none}}
@media(max-width:650px){#toolbar{bottom:8px;max-height:42vh;overflow:auto;width:calc(100% - 16px);max-width:none;border-radius:14px}.bar{padding:10px;gap:8px}.bar button,.bar summary{font-size:16px}.control{flex-wrap:wrap}.alignment{position:fixed;left:10px;right:10px;bottom:10px;top:auto;width:auto;max-height:75vh;overflow:auto;z-index:40}#comment-panel,#ai-panel{top:8px;right:8px;width:calc(100% - 16px);max-width:none;max-height:calc(100% - 16px);border-radius:14px}.composer-header{padding:14px}.composer-body{padding:16px}.composer-row{grid-template-columns:1fr}.evidence-options{flex-wrap:wrap}.evidence-options button{min-width:100px}.area-fields{grid-template-columns:1fr 1fr}.composer-header h2{font-size:22px}#saved-comment-bubble{width:calc(100% - 24px)}.edge-label{font-size:14px}}
:host([data-docked]) #toolbar{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;padding:8px;width:max-content;max-width:calc(100% - 16px);border-radius:14px}
:host([data-docked]) #toolbar>.bar{display:contents}
:host([data-docked]) .comparison-bar>:not(#diff),:host([data-docked]) #recording-note{display:none!important}
:host([data-docked]) #toolbar button{padding:9px 12px}
:host([data-docked]) #warning,:host([data-docked]) #diff-hint{flex-basis:100%;margin:0;padding:8px;font-size:14px}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(forced-colors:active){button,input,select,textarea,summary,#toolbar,#comment-panel,#ai-panel,#saved-comment-bubble{border-color:ButtonText}.comment-pin,#handle{forced-color-adjust:none}.mark{forced-color-adjust:none}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid Highlight}}
.viewport-bar{border-top:1px solid var(--line);gap:8px;padding:8px 12px}.viewport-segments{display:flex;gap:2px;border:1px solid var(--line);border-radius:10px;padding:2px}.viewport-segments button{font-size:14px;min-height:44px;padding:5px 9px;border:1px solid transparent;background:transparent}.viewport-segments button[aria-pressed=true]{background:var(--accent);color:var(--ink)}.viewport-bar .composer-note{font-size:14px;margin:0}:host([data-docked]) .viewport-bar{display:none!important}
@media(max-width:650px){#toolbar .bar{padding:7px 9px;gap:6px}#toolbar .bar button,#toolbar .bar summary{font-size:14px;padding:5px 9px;min-height:44px}#toolbar .brand{font-size:18px;gap:8px}#toolbar #status,#toolbar #recording-note{display:none}#toolbar .viewport-bar{gap:5px}#toolbar .viewport-segments{gap:0}#toolbar #viewport-caption{flex-basis:100%}}

/* Drawer commands share controller fields, but no toolbar is rendered on the page. */
#toolbar{display:none!important}

:host([data-context-invalidated]) > :not(style):not(#context-reload-notice):not(#comment-panel){display:none!important}
:host([data-context-invalidated]:not([data-reload-draft])) #comment-panel{display:none!important}
:host([data-context-invalidated]) #comment-panel{max-height:calc(100% - 180px);pointer-events:auto}
#context-reload-notice{position:absolute;bottom:12px;right:12px;width:490px;max-width:calc(100% - 24px);max-height:150px;overflow:auto;pointer-events:auto;background:var(--panel);border:1px solid var(--accent);border-radius:14px;padding:14px;box-shadow:0 8px 30px #120c2455;font-size:14px;line-height:1.5;z-index:50}
#context-reload-notice p{margin:0 0 10px}#context-reload-notice button{font-size:14px;min-height:44px}

*{scrollbar-width:thin;scrollbar-color:#9381ae transparent}*::-webkit-scrollbar{width:8px;height:8px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{background:#9381ae;border:2px solid transparent;background-clip:padding-box;border-radius:8px}*::-webkit-scrollbar-corner{background:transparent}
.composer-row:has(select[id$=severity]){grid-template-columns:1fr}
@media(forced-colors:active){*{scrollbar-color:auto}}
  `;

  function makeOverlay() {
    host = document.createElement('diffuse-live-overlay');
    host.setAttribute('data-diffuse-ui', 'true');
    root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${styles}</style>
      <div id="layer" aria-hidden="true"><video id="reference" autoplay muted playsinline></video></div>
      <div id="divider"><span class="edge-label production">Production</span><span class="edge-label prototype">Prototype</span><button id="handle" type="button" role="slider" aria-label="Prototype reveal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">↔</button></div>
      <!-- Shared controller values for the side drawer; never shown as page controls. -->
      <div id="toolbar" hidden inert aria-hidden="true">
        <div class="bar comparison-bar"><span class="brand"><span class="mark" aria-hidden="true"></span>Diffuse</span><span id="status" role="status">Preparing review</span><button id="diff" type="button" aria-describedby="diff-hint">Diff</button><span class="separator"></span>
        <label class="control">Opacity <input id="opacity" type="range" min="0" max="100" value="55"><output id="opacity-value">55%</output></label>
        <button id="hide" type="button" aria-pressed="false">Hide reference</button>
        <details id="align"><summary>Adjust</summary><div class="alignment"><label class="control"><input id="linked" type="checkbox" checked>Link scroll</label><label class="reveal-field">Reveal position <input id="reveal" type="range" min="0" max="100" value="50"><output id="reveal-value">50%</output></label><label>Horizontal <input id="offset-x" type="number" min="-3000" max="3000" value="0" step="1"></label><label>Vertical <input id="offset-y" type="number" min="-3000" max="3000" value="0" step="1"></label><button id="reset" type="button">Reset alignment</button><button id="source" type="button">Open reference ↗</button><small>Click the slider or use arrow keys to adjust the reveal without dragging.</small></div></details>
        <button id="reconnect" type="button" hidden>Reconnect</button><button id="stop" type="button" aria-label="Stop review">Stop</button></div>
        <div class="bar review-bar"><button id="comment" type="button" aria-pressed="false">Comment</button><button id="area-comment" type="button" aria-pressed="false" title="Select an area, or hold C and drag on the page">Area</button><button id="review" type="button">Review (0)</button><button id="record" type="button" title="Record this page as shown. No audio. Up to 30 seconds.">Record comparison</button><button id="ai-review" type="button">AI review</button><span id="recording-note" hidden></span></div>
        <div id="viewport-controls" class="bar viewport-bar"><div class="viewport-segments" role="group" aria-label="Change responsive viewport"><button type="button" data-preset="desktop" aria-pressed="false" title="Desktop · 1440 × 900">Desktop</button><button type="button" data-preset="laptop" aria-pressed="false" title="Laptop · 1280 × 800">Laptop</button><button type="button" data-preset="tablet" aria-pressed="false" title="Tablet · 1024 × 768">Tablet</button><button type="button" data-preset="phone" aria-pressed="false" title="Phone · 390 × 844">Phone</button></div><button id="viewport-native" type="button" aria-label="Restore window viewport" title="Use the window’s native size" hidden>Reset</button><span id="viewport-caption" class="composer-note" role="status"></span></div>
        <div id="warning" role="status"></div><div id="diff-hint" class="composer-note" style="padding:0 16px 12px" hidden></div>
      </div>
      <div id="selection-outline" hidden aria-hidden="true"><span id="selection-label"></span></div>
      <div id="picker-tip" hidden><span role="status">Choose an element on production. Esc to cancel.</span><button id="cancel-picker" type="button">Cancel</button><details id="area-coordinates" hidden><summary>Set area dimensions</summary><form id="area-form"><div class="area-fields"><label>Left <input id="area-x" type="number" min="0" step="1" required></label><label>Top <input id="area-y" type="number" min="0" step="1" required></label><label>Width <input id="area-width" type="number" min="4" step="1" required></label><label>Height <input id="area-height" type="number" min="4" step="1" required></label></div><button type="submit">Comment on this area</button><p id="area-error" role="alert"></p></form></details></div>
      <div id="panel-backdrop" hidden aria-hidden="true"></div>
      <div id="capture-progress" hidden role="status">Capturing both pages…</div>
      <div id="comment-pins"></div><div id="saved-comment-highlight" hidden aria-hidden="true"></div>
      <section id="saved-comment-bubble" hidden role="dialog" aria-label="Saved comment"><div class="bubble-top"><span id="saved-comment-category" class="bubble-meta"></span><button id="close-saved-comment" type="button" aria-label="Close saved comment">×</button></div><h3 id="saved-comment-title"></h3><p id="saved-comment-text"></p><p id="saved-comment-expected"></p><p id="saved-comment-state" class="bubble-meta"></p><div class="bubble-actions"><button id="open-pin-report" type="button">Open in review</button></div></section>
      <div id="ai-region-preview" hidden aria-hidden="true"><span id="ai-region-label">AI suggestion · not saved</span></div>
      <section id="ai-panel" hidden role="dialog" aria-labelledby="ai-title" aria-modal="false"><div class="composer-header"><h2 id="ai-title">AI review</h2><button id="close-ai" class="composer-close" type="button" aria-label="Close AI review">×</button></div><div class="composer-body"><p id="ai-mode-note" class="composer-note"></p><label class="composer-field"><span>Instructions <small>(optional)</small></span><textarea id="ai-instructions" maxlength="4000" placeholder="What should the review focus on?"></textarea></label><label class="composer-field"><span>Minimum issue size: <output id="ai-threshold-value">35</output>/100</span><input id="ai-threshold" type="range" min="0" max="100" value="35" aria-describedby="ai-threshold-help"><span class="threshold-ends"><small>0 · All details</small><small>100 · Largest issues only</small></span><small id="ai-threshold-help">Higher numbers hide smaller differences. This filters existing suggestions; changing it does not run AI again. Size is an estimate, separate from confidence.</small></label><p id="ai-disclosure" class="ai-disclosure">Run sends the current screenshot(s) and your instructions to Anthropic using your configured API key. API charges apply. Nothing is sent until you click Run.</p><p id="ai-config-status" class="composer-note"></p><div class="composer-actions"><button id="ai-settings" type="button">AI settings</button><button id="ai-run" type="button">Run AI review</button></div><div id="ai-error" class="composer-error" role="alert"></div><div id="ai-suggestions" tabindex="-1"></div></div></section>
      <section id="comment-panel" hidden role="dialog" aria-labelledby="composer-title" aria-modal="false">
        <div class="composer-header"><h2 id="composer-title">Add a comment</h2><button id="close-comment" class="composer-close" type="button" aria-label="Close comment">×</button></div>
        <div class="composer-body">
          <div id="capture-retry" hidden><p id="capture-retry-description"></p><button id="retry-capture" type="button">Retry capture</button><button id="choose-another" type="button">Choose another element</button></div>
          <form id="comment-form" hidden>
            <fieldset class="evidence-choice"><legend>Attach evidence</legend><div class="evidence-options"><button id="evidence-screenshot" type="button" aria-pressed="true">Screenshot</button><button id="evidence-recording" type="button" aria-pressed="false">Short recording</button></div></fieldset>
            <div id="recording-choice" hidden><p id="recording-choice-note" class="composer-note">Record an interaction for up to 30 seconds, without audio. Your comment and selected area will be kept.</p><video id="recording-preview" controls muted playsinline preload="metadata" hidden></video><button id="comment-record" type="button">Start recording</button></div>
            <div class="evidence-preview" id="evidence-preview"><figure><img id="production-preview" alt="Captured production screen"><figcaption>Production</figcaption></figure><figure><img id="prototype-preview" alt="Captured prototype screen"><figcaption>Prototype</figcaption></figure></div>
            <p id="selection-summary"></p>
            <label class="composer-field"><span>Title <small>(optional)</small></span><input id="comment-title" type="text" maxlength="160" placeholder="Add a short title, if helpful"></label>
            <label class="composer-field"><span>Actual / comment</span><textarea id="comment-actual" required maxlength="6000" placeholder="Describe the discrepancy you see."></textarea></label>
            <label class="composer-field"><span>Expected <small>(optional)</small></span><textarea id="comment-expected" maxlength="6000" placeholder="Describe the intended result."></textarea></label>
            <label class="composer-field"><span>Category</span><select id="comment-category" required><option value="design-mismatch">Design mismatch</option><option value="ux-issue">UX issue</option><option value="copy-change">Copy change</option></select></label>
            <label class="composer-field"><span>Component</span><input id="comment-component" type="text" maxlength="160"><small id="component-hint">Verify the component name before saving.</small></label>
            <div class="composer-row"><label class="composer-field"><span>State</span><input id="comment-state" type="text" required maxlength="160" value="Current state"></label><label class="composer-field"><span>Severity</span><select id="comment-severity"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select></label></div>
            <label class="composer-field"><span>Steps to reproduce <small>(optional)</small></span><textarea id="comment-steps" maxlength="6000" placeholder="How did you reach this state?"></textarea></label>
            <p class="composer-note" id="evidence-note"></p><p class="composer-note">State names describe this capture. Other states have not been checked.</p>
          </form>
        </div>
        <div class="composer-footer"><div id="comment-error" class="composer-error" role="alert"></div><div class="composer-actions"><button id="cancel-comment" type="button">Cancel</button><button id="save-comment" type="submit" form="comment-form">Save comment</button></div></div>
      </section>`;
    document.documentElement.append(host);
    globalThis.DiffuseSelect?.enhance(root, {theme: 'dark'});
    liftAboveDialogs();
    video = el('reference');
    if(video)video.muted = true;
    for(const button of el('viewport-controls').querySelectorAll('button'))button.addEventListener('click',()=>changeViewport(button.dataset.preset||null));
    el('opacity').addEventListener('input', event => updateSettings({opacity: Number(event.target.value) / 100}));
    el('reveal').addEventListener('input',event=>updateSettings({reveal:Number(event.target.value)}));
    el('linked').addEventListener('change', event => {
      const linked = event.target.checked;
      updateSettings({linked});
      clearTimeout(settingsTimer); settingsTimer = null;
      send('SETTINGS', {settings: session.settings}).then(() => { if (linked) syncScroll(document); }).catch(() => {});
    });
    el('hide').addEventListener('click', () => updateSettings({hidden: !session.settings.hidden}));
    el('offset-x').addEventListener('input', event => updateSettings({offsetX: finiteOffset(event.target.value)}));
    el('offset-y').addEventListener('input', event => updateSettings({offsetY: finiteOffset(event.target.value)}));
    el('reset').addEventListener('click', () => updateSettings({offsetX: 0, offsetY: 0}));
    el('source').addEventListener('click', () => quietSend('FOCUS_SOURCE'));
    el('diff').addEventListener('click',()=>openDiff().catch(error=>{localWarning=error.message;paint();}));
    el('stop').addEventListener('click', async () => {
      try { requireSuccess(await send('STOP_SESSION')); } catch (error) { localWarning = error.message; paint(); }
    });
    el('reconnect').addEventListener('click', () => quietSend('RECONNECT'));
    el('comment').addEventListener('click', () => picking ? stopPicking() : startPicking());
    el('comment').addEventListener('pointerdown', event => event.preventDefault());
    el('area-comment').addEventListener('click', () => areaArmed ? cancelArea() : armArea());
    el('area-comment').addEventListener('pointerdown', event => event.preventDefault());
    el('cancel-picker').addEventListener('click', () => {stopPicking(); cancelArea();});
    el('area-form').addEventListener('submit',event=>{event.preventDefault();captureAreaCoordinates();});
    const dismissPin=()=>{const button=pinItems.find(item=>item.comment.id===openPinId)?.button;closePin();button?.focus({preventScroll:true});};
    el('close-saved-comment').addEventListener('click', dismissPin);
    el('open-pin-report').addEventListener('click', () => quietSend('OPEN_REPORT', {commentId:openPinId}));
    el('ai-review').addEventListener('click', openAi);
    el('close-ai').addEventListener('click', ()=>{closeAi();el('ai-review').focus({preventScroll:true});});
    el('ai-settings').addEventListener('click', async () => {
      try {requireSuccess(await send('OPEN_AI_SETTINGS'));} catch(error) {el('ai-error').textContent=error.message;}
    });
    el('ai-run').addEventListener('click', runAi);
    el('ai-threshold').addEventListener('input', () => {aiThresholdOverride=Number(el('ai-threshold').value);el('ai-threshold-value').value=el('ai-threshold').value;renderAiSuggestions();});
    el('ai-panel').addEventListener('keydown', event => {trapPanelFocus(event,el('ai-panel'));if(event.key==='Escape'){event.preventDefault();closeAi();el('ai-review').focus({preventScroll:true});}event.stopPropagation();});
    el('saved-comment-bubble').addEventListener('keydown', event => {if(event.key==='Escape'){event.preventDefault();dismissPin();}event.stopPropagation();});
    el('close-comment').addEventListener('click', closeComment);
    el('cancel-comment').addEventListener('click', closeComment);
    el('choose-another').addEventListener('click', startPicking);
    el('retry-capture').addEventListener('click', retryCapture);
    el('comment-form').addEventListener('submit', saveComment);
    el('comment-form').addEventListener('input', rememberCommentFields);
    el('comment-form').addEventListener('change', rememberCommentFields);
    el('ai-instructions').addEventListener('input', notifyPanel);
    el('evidence-screenshot').addEventListener('click', () => chooseEvidence('screenshot'));
    el('evidence-recording').addEventListener('click', () => chooseEvidence('recording'));
    el('comment-record').addEventListener('click', startComposerRecording);
    el('comment-category').addEventListener('change', () => colorCategory(el('comment-category'), el('comment-category').value));
    el('comment-panel').addEventListener('keydown', event => {
      trapPanelFocus(event,el('comment-panel'));
      if (event.key === 'Escape' && !commentSaving) { event.preventDefault(); closeComment(); }
      event.stopPropagation();
    });
    el('review').addEventListener('click', async () => {
      try { requireSuccess(await send('OPEN_REPORT')); } catch (error) { localWarning = error.message; paint(); }
    });
    el('record').addEventListener('click', () => recording ? stopRecording() : startRecording());
    installAreaGestures();
    pinsTimer = setInterval(updatePinPositions, 250);
    refreshAiBatch();
    const handle = el('handle');
    if(!handle)return;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      updateSettings({reveal: Math.min(100, Math.max(0, event.clientX / innerWidth * 100))});
    });
    handle.addEventListener('pointermove', event => {
      if (handle.hasPointerCapture(event.pointerId)) updateSettings({reveal: Math.min(100, Math.max(0, event.clientX / innerWidth * 100))});
    });
    handle.addEventListener('pointerup', event => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); });
    handle.addEventListener('keydown', event => {
      let value = session.settings.reveal;
      if (event.key === 'ArrowLeft') value -= event.shiftKey ? 10 : 1;
      else if (event.key === 'ArrowRight') value += event.shiftKey ? 10 : 1;
      else if (event.key === 'Home') value = 0;
      else if (event.key === 'End') value = 100;
      else return;
      event.preventDefault();
      updateSettings({reveal: Math.min(100, Math.max(0, value))});
    });
  }

  function liftAboveDialogs() {
    // A modal makes all elements outside it inert, even other top-layer items.
    // Keep the comparison inside the current modal, then use a manual popover
    // to preserve viewport coordinates and escape dialog clipping/transforms.
    host.popover = 'manual';
    let modalStack = [...document.querySelectorAll('dialog:modal')];
    const focusedModal = document.activeElement?.closest('dialog:modal');
    if (focusedModal) modalStack = modalStack.filter(dialog => dialog !== focusedModal).concat(focusedModal);
    const lift = (records = []) => {
      if (!host) return;
      for (const record of records) {
        if (record.type === 'attributes' && record.target.matches('dialog')) {
          modalStack = modalStack.filter(dialog => dialog !== record.target);
          if (record.target.matches(':modal')) modalStack.push(record.target);
        }
      }
      modalStack = modalStack.filter(dialog => dialog.isConnected && dialog.matches(':modal'));
      const parent = modalStack.at(-1) || document.documentElement;
      if (host.parentNode === parent && host.matches(':popover-open')) return;
      if (host.matches(':popover-open')) host.hidePopover();
      parent.append(host);
      host.showPopover();
    };
    modalObserver = new MutationObserver(lift);
    modalObserver.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']});
    lift();
  }

  function requireSuccess(response) {
    if (!response?.ok) {
      const error = new Error(response?.error || 'Diffuse could not complete this action. Try again.');
      error.code = response?.code;
      throw error;
    }
    return response;
  }

  function trapPanelFocus(event,panel) {
    if(event.key!=='Tab')return;
    const controls=[...panel.querySelectorAll('button,input,textarea,select,summary,a[href],video[controls],[tabindex]')].filter(node=>!node.disabled&&node.tabIndex>=0&&node.getClientRects().length);
    if(!controls.length)return;
    const first=controls[0],last=controls.at(-1),active=root.activeElement;
    if(event.shiftKey&&active===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
  }

  function updatePanelState() {
    if (contextInvalidated) return;
    if(!root)return;
    const open=!docked&&['comment-panel','ai-panel'].some(id=>!el(id).hidden);
    el('panel-backdrop').hidden=!open;
    el('saved-comment-bubble').inert=open;
    for(const id of ['comment-panel','ai-panel'])el(id).setAttribute('aria-modal',String(!docked&&!el(id).hidden));
    notifyPanel();
  }

  function notifyPanel() {
    if(contextInvalidated||!docked||role!=='target'||panelNotifyTimer!==null)return;
    panelNotifyTimer=setTimeout(()=>{panelNotifyTimer=null;if(docked&&session)quietSend('PANEL_STATE_CHANGED');},60);
  }

  function viewportMatches(captured) {
    return !captured || ((!Number.isFinite(captured.width)||Math.abs(captured.width-innerWidth)<2)
      &&(!Number.isFinite(captured.height)||Math.abs(captured.height-innerHeight)<2)
      &&(!Number.isFinite(captured.dpr)||Math.abs(captured.dpr-devicePixelRatio)<0.01)
      &&(!Number.isFinite(captured.visualScale)||Math.abs(captured.visualScale-(visualViewport?.scale||1))<0.01));
  }

  function viewportGroup(width) { return !Number.isFinite(width)||width<=0?'unknown':width>=1440?'desktop':width>=1280?'laptop':width>=768?'tablet':'phone'; }
  function currentViewportGroup() { return session?.viewportPreset || viewportGroup(innerWidth); }
  function commentViewportGroup(comment) {
    const context=comment.context?.production||comment.selection?.context;
    const key=context?.viewportProfile?.key;
    return ['desktop','laptop','tablet','phone'].includes(key)?key:viewportGroup(context?.viewport?.width);
  }
  function commentInCurrentViewport(comment) { const key=commentViewportGroup(comment);return key==='unknown'||key===currentViewportGroup(); }

  function currentContext() {
    const context = globalThis.DiffuseInspector?.context() || {
      url: location.href, title: document.title, capturedAt: new Date().toISOString(),
      viewport: viewport(), scroll: {x: scrollX, y: scrollY}, language: document.documentElement.lang || navigator.language,
      browser: {userAgent: navigator.userAgent, platform: navigator.platform},
    };
    return {...context,viewportProfile:{key:currentViewportGroup(),mode:session?.viewportPreset?'preset':'window'}};
  }

  async function changeViewport(preset) {
    if(viewportActionBusy)return;
    const reason=diffDisabledReason();
    if(reason){localWarning=reason;paint();return;}
    viewportActionBusy=true;localWarning='';paint();
    try { requireSuccess(await send('VIEWPORT_PRESET',{preset})); }
    catch(error){localWarning=error.message;}
    finally{viewportActionBusy=false;paint();}
  }

  function paintViewport() {
    if (contextInvalidated) return;
    if(!root||!el('viewport-controls'))return;
    const key=currentViewportGroup(),busy=viewportActionBusy||session?.viewportChanging||Boolean(diffDisabledReason());
    for(const button of el('viewport-controls').querySelectorAll('button')){button.disabled=Boolean(busy);if(button.dataset.preset)button.setAttribute('aria-pressed',String(button.dataset.preset===key));}
    el('viewport-native').hidden=!session?.viewportPreset;
    const count=(session?.comments||[]).filter(commentInCurrentViewport).length;
    el('viewport-caption').textContent=viewportActionBusy?'Changing viewport…':`${innerWidth} × ${innerHeight} · ${count} comment${count===1?'':'s'} in this view`;
  }

  function panelState(message={}) {
    const evidenceKey=commentDraft?`${commentDraft.id}:${draftEvidenceRevision}`:null;
    const evidenceIncluded=Boolean(commentDraft&&(message.knownDraftId!==commentDraft.id||message.knownEvidenceKey!==evidenceKey));
    const failureVisible=!el('capture-retry').hidden&&!el('comment-panel').hidden;
    return {
      view:recording||recordingBusy?'controls':!el('comment-panel').hidden?'comment':!el('ai-panel').hidden?'ai':'controls',
      docked,picking,areaArmed,captureBusy,commentSaving,recordingBusy,aiBusy:aiBusy||Boolean(session?.aiRunning),aiOperationBusy,aiBulkAccepting,
      recording,warning:[session?.error,session?.warning,localWarning].filter(Boolean).join(' · '),pendingCaptureAction,diffDisabledReason:diffDisabledReason(),
      captureError:failureVisible?el('comment-error').textContent:'',
      captureDescription:failureVisible?el('capture-retry-description').textContent:'',
      captureNeedsAccess:failureVisible&&el('composer-title').textContent==='Allow capture on this tab',
      comment:commentDraft?{
        id:commentDraft.id,fields:readCommentFields(false),selectionSummary:el('selection-summary').textContent,
        componentHint:el('component-hint').textContent,evidenceChoice,error:el('comment-error').textContent,fieldRevisions:Object.fromEntries(commentFieldRevisions),
        evidenceKey,evidenceIncluded,...(evidenceIncluded?{evidence:commentDraft.evidence||{}}:{}),
      }:null,
      ai:{config:{hasKey:Boolean(aiConfig.hasKey),model:aiConfig.model||'',threshold:aiConfig.threshold},instructions:el('ai-instructions').value,threshold:Number(el('ai-threshold').value),batch:aiBatch,error:el('ai-error').textContent},
      openPinId,
    };
  }

  function rememberCommentFields() {
    if(commentDraft)commentDraft.composerFields=readCommentFields(false);
    notifyPanel();
  }

  function diffDisabledReason() {
    if(recording||recordingBusy)return 'Stop the recording before choosing a reference.';
    if(captureBusy)return 'Wait for the screenshot capture before choosing a reference.';
    if(commentDraft||commentSaving)return 'Save or cancel your comment before choosing a reference.';
    if(aiBusy||aiOperationBusy||session?.aiRunning)return 'Finish the AI review before choosing a reference.';
    return '';
  }

  async function openDiff() {
    const reason=diffDisabledReason();
    if(reason)throw new Error(reason);
    stopPicking(false);cancelArea();closePin();closeAi();
    requireSuccess(await send('OPEN_DIFF'));
  }

  function applyCommentFields(fields,message={}) {
    if(!commentDraft||!fields||typeof fields!=='object'||commentSaving||recordingBusy||recording)return;
    if(message.editorId!==undefined||message.fieldRevision!==undefined){
      if(typeof message.editorId!=='string'||!message.editorId||message.editorId.length>80||!Number.isSafeInteger(message.fieldRevision)||message.fieldRevision<0)throw new Error('This draft update is invalid. Reopen the drawer.');
      if(message.fieldRevision<(commentFieldRevisions.get(message.editorId)??-1))return;
      if(!commentFieldRevisions.has(message.editorId)&&commentFieldRevisions.size>=8)commentFieldRevisions.delete(commentFieldRevisions.keys().next().value);
      commentFieldRevisions.set(message.editorId,message.fieldRevision);
    }
    for(const [key,id] of [['title','title'],['comment','actual'],['expected','expected'],['component','component'],['state','state'],['steps','steps'],['severity','severity'],['category','category']]) {
      if(typeof fields[key]!=='string')continue;
      const node=el(`comment-${id}`);
      if(node instanceof HTMLSelectElement){if([...node.options].some(option=>option.value===fields[key]))node.value=fields[key];}
      else node.value=fields[key].slice(0,node.maxLength>0?node.maxLength:6000);
    }
    colorCategory(el('comment-category'),el('comment-category').value);
    rememberCommentFields();
  }

  async function panelCommand(message) {
    if(role!=='target'||!root)throw new Error('The review page is unavailable. Return to it and reconnect.');
    if(['setCommentFields','saveComment','recordComment','evidence','cancelComment'].includes(message.action)
      &&message.draftId!==undefined&&message.draftId!==commentDraft?.id)throw new Error('This comment draft has changed. Refresh the drawer before editing.');
    const fields=message.fields;
    const applyAiFields=()=>{
      if(typeof message.instructions==='string')el('ai-instructions').value=message.instructions.slice(0,4000);
      if(Number.isFinite(message.threshold)){aiThresholdOverride=Math.max(0,Math.min(100,Math.round(message.threshold)));el('ai-threshold').value=String(aiThresholdOverride);el('ai-threshold-value').value=String(aiThresholdOverride);renderAiSuggestions();}
    };
    switch(message.action) {
      case 'selectElement':startPicking();break;
      case 'selectArea':armArea();break;
      case 'cancelSelection':stopPicking(false);cancelArea();break;
      case 'openAi':await openAi();break;
      case 'openDiff':await openDiff();break;
      case 'closeAi':closeAi();break;
      case 'setAiFields':applyAiFields();break;
      case 'runAi':applyAiFields();await runAi();break;
      case 'aiSuggestion': {
        const suggestion=aiBatch?.suggestions?.find(item=>item.id===message.id&&(!item.status||item.status==='pending'));
        if(!suggestion)throw new Error('This suggestion is no longer pending. Refresh the review.');
        if(message.suggestionAction==='preview')aiPreview(suggestion);
        else if(['accept','dismiss'].includes(message.suggestionAction))await handleAiSuggestion(message.suggestionAction,suggestion);
        else throw new Error('Unknown suggestion action.');
        break;
      }
      case 'acceptAllAi':await acceptAllAiSuggestions((aiBatch?.suggestions||[]).filter(item=>(!item.status||item.status==='pending')&&Number(item.score??item.mismatchScore??0)>=Number(el('ai-threshold').value)));break;
      case 'showAllAi':aiThresholdOverride=0;el('ai-threshold').value='0';el('ai-threshold-value').value='0';renderAiSuggestions();break;
      case 'setCommentFields':applyCommentFields(fields,message);break;
      case 'evidence':
        if(!['screenshot','recording','video'].includes(message.choice))throw new Error('Choose a screenshot or short recording.');
        applyCommentFields(fields,message);chooseEvidence(message.choice==='video'?'recording':message.choice);break;
      case 'recordComment':applyCommentFields(fields,message);await startComposerRecording();break;
      case 'saveComment':applyCommentFields(fields,message);await saveComment();break;
      case 'cancelComment':closeComment();break;
      case 'record':await startRecording();break;
      case 'stopRecording':await stopRecording();break;
      case 'retryCapture':await retryCapture();break;
      case 'settings': {
        const values=message.settings||{},partial={};
        for(const key of ['hidden','linked'])if(typeof values[key]==='boolean')partial[key]=values[key];
        for(const [key,min,max] of [['opacity',0,1],['reveal',0,100],['offsetX',-3000,3000],['offsetY',-3000,3000]])if(Number.isFinite(values[key]))partial[key]=Math.max(min,Math.min(max,values[key]));
        updateSettings(partial);break;
      }
      case 'showPin':requireSuccess(await send('SHOW_COMMENT', {commentId: message.id}));break;
      case 'focusSource':requireSuccess(await send('FOCUS_SOURCE'));break;
      case 'stop':requireSuccess(await send('STOP_SESSION'));break;
      case 'reconnect':requireSuccess(await send('RECONNECT'));break;
      case 'openReport':requireSuccess(await send('OPEN_REPORT'));break;
      case 'openSettings':requireSuccess(await send('OPEN_SETTINGS'));break;
      default:throw new Error('Unknown drawer action.');
    }
    notifyPanel();
    return {ok:true,state:root&&session?panelState(message):null};
  }

  function editableEvent(event) {
    return event.composedPath().some(node => node instanceof Element && (node.matches('input,textarea,select,[role="textbox"],[role="combobox"]') || node.isContentEditable));
  }

  function canSelect() {return Boolean(root && !captureBusy && !commentSaving && !recording && !recordingBusy && !commentDraft && !aiBusy && !aiOperationBusy && !session?.aiRunning);}

  function armArea() {
    if(!canSelect()) return;
    stopPicking(false);closePin();closeAi();
    areaArmed=true;areaDrag=null;
    el('comment-panel').hidden=true;
    el('picker-tip').firstElementChild.textContent='Drag an area, or set its dimensions below. Esc to cancel.';
    el('area-coordinates').hidden=false;
    el('area-coordinates').open=false;
    el('area-error').textContent='';
    for(const [id,value] of Object.entries({'area-x':Math.floor(innerWidth/4),'area-y':Math.floor(innerHeight/4),'area-width':Math.min(240,Math.floor(innerWidth/2)),'area-height':Math.min(140,Math.floor(innerHeight/2))}))el(id).value=String(value);
    el('picker-tip').hidden=false;
    paintReviewControls();
    el('area-coordinates').querySelector('summary').focus({preventScroll:true});
  }

  function captureAreaCoordinates() {
    if(!canSelect()||!el('area-form').reportValidity())return;
    const [x,y,width,height]=['area-x','area-y','area-width','area-height'].map(id=>Number(el(id).value));
    if(![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<4||height<4||x+width>innerWidth||y+height>innerHeight){el('area-error').textContent=`Keep the area inside this ${innerWidth} × ${innerHeight} page view.`;return;}
    cancelArea();selectedElement=null;selectionMetadata=globalThis.DiffuseInspector.region(x,y,width,height);captureComment();
  }

  function cancelArea() {
    if(areaDrag) ignoreNextAreaClick=true;
    areaArmed=false;areaDrag=null;cHeld=false;
    if(!root)return;
    el('selection-outline').hidden=true;
    el('selection-outline').removeAttribute('data-region');
    el('area-coordinates').hidden=true;
    if(!picking)el('picker-tip').hidden=true;
    paintReviewControls();
  }

  function areaBounds() {
    if(!areaDrag)return null;
    const x=Math.min(areaDrag.startX,areaDrag.x),y=Math.min(areaDrag.startY,areaDrag.y);
    return{x,y,width:Math.abs(areaDrag.x-areaDrag.startX),height:Math.abs(areaDrag.y-areaDrag.startY)};
  }

  function installAreaGestures() {
    const options={capture:true,signal:abort.signal};
    const suppress=event=>{event.preventDefault();event.stopImmediatePropagation();};
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&(areaArmed||areaDrag||cHeld)){suppress(event);cHeld=false;cGestureUsed=true;cancelArea();return;}
      if(event.code==='KeyC'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!editableEvent(event)&&canSelect()){
        if (!cHeld) cGestureUsed=false;
        cHeld=true;suppress(event);
      }
    },options);
    document.addEventListener('keyup',event=>{
      if(event.code!=='KeyC')return;
      const selectElement=cHeld&&!cGestureUsed&&!areaDrag&&!editableEvent(event)&&!isDiffuseEvent(event);
      cHeld=false;cGestureUsed=false;
      if(selectElement&&canSelect()){suppress(event);startPicking();}
    },options);
    window.addEventListener('blur',()=>{cHeld=false;cGestureUsed=false;if(areaDrag)cancelArea();},{signal:abort.signal});
    document.addEventListener('pointerdown',event=>{
      if(event.button!==0||!(areaArmed||cHeld)||!canSelect()||isDiffuseEvent(event)||editableEvent(event))return;
      suppress(event);cGestureUsed=true;stopPicking(false);closePin();closeAi();
      areaArmed=true;ignoreNextAreaClick=false;
      areaDrag={startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,pointerId:event.pointerId};
      el('picker-tip').hidden=true;
      const outline=el('selection-outline');outline.hidden=false;outline.dataset.region='true';
      Object.assign(outline.style,{left:`${event.clientX}px`,top:`${event.clientY}px`,width:'0px',height:'0px'});
      el('selection-label').textContent='Selected area';
      paintReviewControls();
    },options);
    document.addEventListener('pointermove',event=>{
      if(!areaDrag)return;suppress(event);
      areaDrag.x=Math.max(0,Math.min(innerWidth,event.clientX));areaDrag.y=Math.max(0,Math.min(innerHeight,event.clientY));
      const bounds=areaBounds();Object.assign(el('selection-outline').style,{left:`${bounds.x}px`,top:`${bounds.y}px`,width:`${bounds.width}px`,height:`${bounds.height}px`});
      el('selection-label').textContent=`${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
    },options);
    document.addEventListener('pointerup',event=>{
      if(!areaDrag||event.pointerId!==areaDrag.pointerId)return;suppress(event);
      areaDrag.x=Math.max(0,Math.min(innerWidth,event.clientX));areaDrag.y=Math.max(0,Math.min(innerHeight,event.clientY));
      const bounds=areaBounds();areaDrag=null;areaArmed=false;ignoreNextAreaClick=true;
      el('selection-outline').hidden=true;el('selection-outline').removeAttribute('data-region');
      if(bounds.width<4||bounds.height<4){
        const target=pickTarget(event);
        if(target){selectedElement=target;selectionMetadata=globalThis.DiffuseInspector.inspect(target);captureComment();}
        else {localWarning='Press C, then choose an element. Hold C and drag to select an area.';paint();}
        return;
      }
      selectedElement=null;selectionMetadata=globalThis.DiffuseInspector.region(bounds.x,bounds.y,bounds.width,bounds.height);
      captureComment();
    },options);
    for(const name of ['mousedown','mouseup','click'])document.addEventListener(name,event=>{
      if(isDiffuseEvent(event))return;
      if(areaDrag||ignoreNextAreaClick){suppress(event);if(name==='click')ignoreNextAreaClick=false;}
    },options);
    document.addEventListener('pointercancel',()=>{if(areaDrag)cancelArea();},options);
    document.addEventListener('wheel',event=>{if(areaDrag)event.preventDefault();},{...options,passive:false});
  }

  function commentRect(comment) {
    const selection=comment.selection;
    if(!selection){const scroll=comment.context?.production?.scroll||{x:0,y:0};const rect={x:scroll.x+24-scrollX,y:scroll.y+24-scrollY,width:1,height:1};return{...rect,visible:rect};}
    return globalThis.DiffuseInspector?.resolveSelection(selection) || null;
  }

  function renderPins() {
    if(!root)return;
    pinsUrl=location.href;pinsViewport=currentViewportGroup();
    const comments=(session?.comments||[]).filter(comment=>commentInCurrentViewport(comment)&&(comment.context?.production?.url||comment.selection?.context?.url)===location.href);
    const existing=new Map([...el('comment-pins').children].map(button=>[button.dataset.commentId,button]));
    pinItems=comments.map((comment,index)=>{
      const number=(session.comments||[]).findIndex(item=>item.id===comment.id)+1;
      let button=existing.get(comment.id);existing.delete(comment.id);
      if(!button){button=document.createElement('button');button.type='button';button.className='comment-pin';button.dataset.commentId=comment.id;button.addEventListener('click',()=>openPin(comment.id));el('comment-pins').append(button);}
      colorCategory(button,comment.fields?.category);button.textContent=String(number);button.title=`${categoryLabel(comment.fields?.category)}: ${commentTitle(comment.fields)}`;button.setAttribute('aria-label',`Comment ${number}, ${categoryLabel(comment.fields?.category)}: ${commentTitle(comment.fields)}`);button.setAttribute('aria-expanded',String(openPinId===comment.id));button.setAttribute('aria-controls','saved-comment-bubble');
      return{comment,button};
    });
    for(const button of existing.values())button.remove();
    if(openPinId&&!comments.some(comment=>comment.id===openPinId))closePin();
    updatePinPositions();
  }

  function updatePinPositions() {
    if(!root)return;
    if(pinsUrl!==location.href||pinsViewport!==currentViewportGroup()){renderPins();return;}
    for(const item of pinItems){
      const rect=commentRect(item.comment);item.rect=rect;
      const point=rect?{x:rect.x+Math.min(rect.width,12),y:rect.y+Math.min(rect.height,12)}:null;
      const visible=rect?.visible;
      // The pin belongs to one point on the page. Do not clamp it to the
      // viewport edge when that point scrolls out of its container.
      const inView=point&&visible&&point.x>=Math.max(0,visible.x)&&point.y>=Math.max(0,visible.y)
        &&point.x<=Math.min(innerWidth,visible.x+visible.width)&&point.y<=Math.min(innerHeight,visible.y+visible.height);
      item.button.hidden=!inView||picking||areaArmed||Boolean(areaDrag);
      if(point){item.button.style.left=`${point.x}px`;item.button.style.top=`${point.y}px`;}
      if(item.comment.id===openPinId){
        const show=!item.button.hidden;
        el('saved-comment-bubble').hidden=!show;el('saved-comment-highlight').hidden=!show;
        if(show){
          const bubble=el('saved-comment-bubble');bubble.style.left=`${Math.max(12,Math.min(innerWidth-bubble.offsetWidth-12,point.x+23))}px`;bubble.style.top=`${Math.max(12,Math.min(innerHeight-bubble.offsetHeight-12,point.y+3))}px`;
          Object.assign(el('saved-comment-highlight').style,{left:`${visible.x}px`,top:`${visible.y}px`,width:`${visible.width}px`,height:`${visible.height}px`});
        }
      }
    }
  }

  async function revealComment(id) {
    const comment=session?.comments?.find(item=>item.id===id);
    if(!comment)throw new Error('This comment is no longer available.');
    const context=comment.context?.production||comment.selection?.context||{};
    if(context.url!==location.href)throw new Error('The page changed before the comment could be shown. Select the comment again.');
    if(!canSelect())throw new Error('Save or cancel the open comment before opening another.');
    stopPicking(false);cancelArea();closePin();closeAi();
    const sessionId=session.id;
    // Restore the captured scrolling state first, including scrollable panels.
    // Then find the live anchor so responsive reflow does not leave the pin at
    // an obsolete absolute coordinate.
    const restoreScroll=()=>{
      const position=context.scroll||{};
      window.scrollTo({left:Number.isFinite(position.x)?position.x:0,top:Number.isFinite(position.y)?position.y:0,behavior:'instant'});
      const nested=context.nestedScroll||comment.selection?.scrollContainers||[];
      for(const saved of nested){
        const target=globalThis.DiffuseInspector.resolveSelector(saved.selector);
        if(!target||target===document.documentElement)continue;
        const x=saved.x??saved.scrollLeft,y=saved.y??saved.scrollTop;
        if(Number.isFinite(x))target.scrollLeft=x;
        if(Number.isFinite(y))target.scrollTop=y;
      }
    };
    restoreScroll();
    // Client-rendered routes can mount after Chrome reports the document loaded.
    // Wait for the real anchor, without inventing a replacement element.
    let rect=null;
    for(let attempt=0;attempt<30;attempt++){
      if(!root||session?.id!==sessionId||location.href!==context.url)throw new Error('The review page changed. Select the comment again.');
      rect=commentRect(comment);
      if(rect)break;
      await new Promise(resolve=>setTimeout(resolve,100));restoreScroll();
    }
    if(!rect)return{ok:true,found:false};
    const selection=comment.selection;
    const target=globalThis.DiffuseInspector.resolveSelector(selection?.anchor?.selector||selection?.selector);
    if(target)target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    renderPins();openPin(id);updatePinPositions();notifyPanel();
    return{ok:true,found:pinItems.some(item=>item.comment.id===id&&!item.button.hidden)};
  }

  function openPin(id) {
    if(openPinId===id){closePin();return;}
    const item=pinItems.find(item=>item.comment.id===id);if(!item)return;
    closeAi();openPinId=id;
    const fields=item.comment.fields||{};
    el('saved-comment-category').textContent=categoryLabel(fields.category)+(item.comment.ai?' · AI assisted':'');
    for(const id of ['saved-comment-category','saved-comment-highlight','saved-comment-bubble'])colorCategory(el(id),fields.category);
    el('saved-comment-title').textContent=commentTitle(fields);
    el('saved-comment-text').textContent=fields.comment||'';
    el('saved-comment-expected').textContent=fields.expected?`Expected: ${fields.expected}`:'';
    el('saved-comment-state').textContent=[fields.component,fields.state,fields.severity].filter(Boolean).join(' · ');
    el('saved-comment-bubble').hidden=false;el('saved-comment-highlight').hidden=false;
    for(const entry of pinItems)entry.button.setAttribute('aria-expanded',String(entry.comment.id===id));
    updatePinPositions();el('close-saved-comment').focus({preventScroll:true});
  }

  function closePin() {
    openPinId=null;if(!root)return;
    el('saved-comment-bubble').hidden=true;el('saved-comment-highlight').hidden=true;
    for(const item of pinItems)item.button.setAttribute('aria-expanded','false');
  }

  async function refreshAiBatch() {
    const sessionId=session?.id;
    try {
      const result=requireSuccess(await send('GET_AI_SUGGESTIONS'));
      if(!root||session?.id!==sessionId)return;
      aiBatch=result.batch||null;aiPreviewContext=aiBatch?.context?.production||null;
      renderAiSuggestions();
    } catch {}
  }

  async function openAi() {
    if(!root||commentDraft||captureBusy||recording)return;
    stopPicking(false);cancelArea();closePin();
    el('ai-panel').hidden=false;el('ai-error').textContent='';updatePanelState();if(!docked)el('ai-instructions').focus({preventScroll:true});
    el('ai-mode-note').textContent=isAudit()?'Review this page for potential UX and copy issues. Add a reference with Diff to compare designs.':'Review the current page and reference screenshots for potential mismatches.';
    el('ai-config-status').textContent='Checking AI settings…';
    try{
      const response=requireSuccess(await send('GET_AI_CONFIG'));
      if(!root)return;
      aiConfig={...aiConfig,...response.config};
      if(aiSavedThreshold!==aiConfig.threshold)aiThresholdOverride=null;
      aiSavedThreshold=aiConfig.threshold;
      el('ai-threshold').value=String(aiThresholdOverride??Math.max(0,Math.min(100,Number(aiConfig.threshold)||0)));
      el('ai-threshold-value').value=el('ai-threshold').value;
      el('ai-config-status').textContent=aiConfig.hasKey?`Model: ${aiConfig.model||'Configured model'} · API key stays in extension settings.`:'Add your Anthropic API key in AI settings to run a review.';
      await refreshAiBatch();
    }catch(error){if(root)el('ai-error').textContent=error.message;}
    paintReviewControls();
  }

  function closeAi() {if(root){el('ai-panel').hidden=true;el('ai-region-preview').hidden=true;updatePanelState();}}

  function aiPreview(suggestion) {
    if(!root||!suggestion?.region){if(root)el('ai-region-preview').hidden=true;return;}
    const region=suggestion.region;const context=aiBatch?.context?.production||aiPreviewContext||currentContext();
    if(context.url&&context.url!==location.href){el('ai-region-preview').hidden=true;return;}
    if(!viewportMatches(context.viewport)){el('ai-region-preview').hidden=true;localWarning='This suggestion was captured at a different page size. Its original area is available in the review.';paint();return;}
    const width=context.viewport?.width||innerWidth,height=context.viewport?.height||innerHeight;
    const x=Math.max(0,Math.min(1,Number(region.x)||0))*width+(context.scroll?.x||0)-scrollX;
    const y=Math.max(0,Math.min(1,Number(region.y)||0))*height+(context.scroll?.y||0)-scrollY;
    Object.assign(el('ai-region-preview').style,{left:`${x}px`,top:`${y}px`,width:`${Math.max(0,Math.min(1,Number(region.width)||0))*width}px`,height:`${Math.max(0,Math.min(1,Number(region.height)||0))*height}px`});
    el('ai-region-preview').hidden=false;
  }

  function renderAiSuggestions() {
    if (contextInvalidated) return;
    if(!root)return;
    const list=el('ai-suggestions');const restoreFocus=list.contains(root.activeElement);list.replaceChildren();
    const threshold=Number(el('ai-threshold').value)||0;
    const pending=(aiBatch?.suggestions||[]).filter(suggestion=>!suggestion.status||suggestion.status==='pending');
    const visible=pending.filter(suggestion=>Number(suggestion.score??suggestion.mismatchScore??0)>=threshold);
    const hiddenCount=pending.length-visible.length;
    if(aiBatch&&!aiBusy){
      const status=document.createElement('section');status.id='ai-results-status';status.tabIndex=-1;status.setAttribute('role','status');
      const title=document.createElement('h3');title.textContent=pending.length?`Review complete · ${pending.length} pending suggestion${pending.length===1?'':'s'}`:'No pending suggestions in this review';
      const detail=document.createElement('p');
      detail.textContent=hiddenCount===pending.length&&hiddenCount
        ? `All ${hiddenCount} suggestions are hidden by your filter of ${threshold}/100. Lower it to see the findings.`
        : hiddenCount ? `Showing ${visible.length} of ${pending.length} suggestions. ${hiddenCount} smaller suggestion${hiddenCount===1?' is':'s are'} hidden by your filter.`
        : pending.length ? 'Review the suggestions below. They become comments only when you accept them.' : 'Any accepted suggestions are in your comments. No new comments are added automatically.';
      status.append(title,detail);
      if(hiddenCount){
        const showAll=document.createElement('button');showAll.id='ai-show-all';showAll.type='button';showAll.textContent=`Show all ${pending.length} suggestion${pending.length===1?'':'s'}`;showAll.disabled=aiOperationBusy;
        showAll.addEventListener('click',()=>{
          aiThresholdOverride=0;el('ai-threshold').value='0';el('ai-threshold-value').value='0';renderAiSuggestions();
          el('ai-suggestions').querySelector('[data-action=preview]')?.focus({preventScroll:true});
        });
        const freeNote=document.createElement('p');freeNote.className='ai-filter-note';freeNote.textContent='Uses this review’s existing results. No new AI request or charge.';
        status.append(showAll,freeNote);
      }
      if(visible.length){
        const acceptAll=document.createElement('button');acceptAll.id='ai-accept-all';acceptAll.type='button';acceptAll.textContent=aiBulkAccepting?'Adding comments…':`Accept all shown (${visible.length})`;acceptAll.disabled=aiOperationBusy;
        acceptAll.addEventListener('click',()=>acceptAllAiSuggestions(visible));status.append(acceptAll);
      }
      list.append(status);
    }else{
      const note=document.createElement('p');note.className='ai-empty';note.textContent=aiBusy?'Reviewing the captured screen. This may take a minute…':'Run a review to see suggestions. Nothing is added to your comments automatically.';list.append(note);
    }
    for(const suggestion of visible){
      const card=document.createElement('article');card.className='ai-suggestion';card.dataset.suggestionId=suggestion.id;
      const meta=document.createElement('div');meta.className='ai-suggestion-meta';meta.textContent=`Pending · ${categoryLabel(suggestion.category)} · Estimated size ${Math.round(Number(suggestion.score??suggestion.mismatchScore)||0)}/100 · ${Math.round(Math.max(0,Math.min(1,Number(suggestion.confidence)||0))*100)}% confidence`;
      const title=document.createElement('h3');title.textContent=suggestion.title||'Suggested observation';
      const current=document.createElement('section');current.className='ai-current';const currentLabel=document.createElement('h4');currentLabel.textContent='Current';const text=document.createElement('p');text.textContent=suggestion.comment||'';current.append(currentLabel,text);
      const reason=document.createElement('p');reason.className='composer-note';reason.textContent=suggestion.reason||'';
      const expected=document.createElement('section');expected.className='ai-change';const changeLabel=document.createElement('h4');changeLabel.textContent='Change to';const changeText=document.createElement('p');changeText.textContent=suggestion.expected||'No proposed change was recorded.';expected.append(changeLabel,changeText);
      const actions=document.createElement('div');actions.className='ai-suggestion-actions';
      for(const [action,label]of[['preview','Show area'],['accept','Accept comment'],['dismiss','Dismiss']]){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.action=action;button.disabled=aiOperationBusy||aiBusy||(action==='preview'&&!suggestion.region);
        button.addEventListener('click',()=>action==='preview'?aiPreview(suggestion):handleAiSuggestion(action,suggestion));actions.append(button);
      }
      card.addEventListener('mouseenter',()=>aiPreview(suggestion));card.addEventListener('mouseleave',()=>{if(root)el('ai-region-preview').hidden=true;});
      card.addEventListener('focusin',()=>aiPreview(suggestion));
      card.append(meta,title,current,expected);if(suggestion.reason)card.append(reason);card.append(actions);list.append(card);
    }
    if(aiBatch?.summary||aiBatch?.limitations?.length){
      const details=document.createElement('details');details.className='ai-run-details';
      const label=document.createElement('summary');label.textContent='Review summary and limitations';details.append(label);
      if(aiBatch.summary){const summary=document.createElement('p');summary.className='composer-note';summary.textContent=String(aiBatch.summary);details.append(summary);}
      if(aiBatch.limitations?.length){const limitations=document.createElement('p');limitations.className='composer-note';limitations.textContent=`Limits: ${Array.isArray(aiBatch.limitations)?aiBatch.limitations.join(' · '):String(aiBatch.limitations)}`;details.append(limitations);}
      list.append(details);
    }
    if(restoreFocus&&!docked){const target=el('ai-results-status')||list;target.tabIndex=-1;target.focus({preventScroll:true});}
    notifyPanel();
  }

  async function runAi() {
    if(!root||aiBusy||aiOperationBusy||recording||captureBusy||commentDraft)return;
    if(!aiConfig.hasKey){el('ai-error').textContent='Add your API key in AI settings, then reopen this panel.';return;}
    const sessionId=session?.id;aiBusy=true;pendingCaptureAction=null;el('ai-error').textContent='';aiPreviewContext=currentContext();
    const instructions=el('ai-instructions').value.trim();const threshold=Number(el('ai-threshold').value);
    paintReviewControls();renderAiSuggestions();
    try{
      const result=requireSuccess(await send('RUN_AI_REVIEW',{instructions,threshold}));
      if(!root||session?.id!==sessionId)return;
      aiBatch=result.batch||null;aiPreviewContext=aiBatch?.context?.production||aiPreviewContext;
    }catch(error){
      if(root&&session?.id===sessionId){
        if(error.code==='NEEDS_CAPTURE_ACCESS'){pendingCaptureAction='ai';el('ai-error').textContent='Click the Diffuse icon in Chrome on this page, then Enable capture & return. This requested review will retry after access is granted.';}
        else if(error.code==='NEEDS_AI_KEY'){aiConfig.hasKey=false;el('ai-error').textContent='Add your Anthropic API key in AI settings, then reopen this panel.';}
        else el('ai-error').textContent=error.message;
      }
    }finally{if(session?.id===sessionId){aiBusy=false;paintReviewControls();renderAiSuggestions();}}
  }

  async function handleAiSuggestion(action,suggestion) {
    if(!root||!aiBatch||aiOperationBusy||aiBusy)return;
    const sessionId=session?.id;
    aiOperationBusy=true;el('ai-error').textContent='';renderAiSuggestions();
    try{
      const result=requireSuccess(await send(action==='accept'?'ACCEPT_AI_SUGGESTION':'DISMISS_AI_SUGGESTION',{batchId:aiBatch.id,suggestionId:suggestion.id}));
      if(!root||session?.id!==sessionId)return;
      if(result.batch)aiBatch=result.batch;
      else if(aiBatch)aiBatch={...aiBatch,suggestions:aiBatch.suggestions.filter(item=>item.id!==suggestion.id)};
      if(result.review&&session)session.commentCount=result.review.count;
      el('ai-region-preview').hidden=true;
    }catch(error){if(root&&session?.id===sessionId)el('ai-error').textContent=error.message;}
    finally{if(session?.id===sessionId){aiOperationBusy=false;renderAiSuggestions();paintReviewControls();}}
  }

  async function acceptAllAiSuggestions(suggestions) {
    if(!root||!aiBatch||aiOperationBusy||aiBusy||!suggestions.length)return;
    const sessionId=session?.id,batchId=aiBatch.id;
    const suggestionIds=suggestions.map(suggestion=>suggestion.id);
    aiOperationBusy=true;aiBulkAccepting=true;el('ai-error').textContent='';renderAiSuggestions();paintReviewControls();
    try{
      const result=requireSuccess(await send('ACCEPT_AI_SUGGESTIONS',{batchId,suggestionIds}));
      if(!root||session?.id!==sessionId)return;
      aiBatch=result.batch||null;
      if(result.review&&session)session.commentCount=result.review.count;
      const accepted=Number(result.acceptedCount)||0;
      localWarning=`${accepted} AI suggestion${accepted===1?'':'s'} added as comments.`;
      if(result.failures?.length)el('ai-error').textContent=`${accepted} comments added. ${result.failures.length} could not be added. ${result.failures[0].error||'Try accepting the remaining suggestions again.'}`;
      el('ai-region-preview').hidden=true;
      paint();
    }catch(error){
      if(root&&session?.id===sessionId){el('ai-error').textContent=error.message;await refreshAiBatch();}
    }finally{
      if(session?.id===sessionId){aiOperationBusy=false;aiBulkAccepting=false;renderAiSuggestions();paintReviewControls();}
    }
  }

  function isDiffuseEvent(event) {
    return event.composedPath().some(node => node === host || (node instanceof Element && node.hasAttribute('data-diffuse-ui')));
  }

  function pickTarget(event) {
    if (isDiffuseEvent(event)) return null;
    return event.composedPath().find(node => node instanceof Element && node !== document.documentElement && !node.hasAttribute('data-diffuse-ui')) || null;
  }

  function drawSelection(element) {
    if (!root || !element?.isConnected) { if (el('selection-outline')) el('selection-outline').hidden = true; return; }
    const rect = element.getBoundingClientRect();
    const outline = el('selection-outline');
    outline.hidden = false;
    Object.assign(outline.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`});
    el('selection-label').textContent = element.getAttribute('data-component') || element.getAttribute('data-testid') || element.getAttribute('role') || element.localName;
    el('selection-label').style.bottom = rect.top < 30 ? 'auto' : 'calc(100% + 4px)';
    el('selection-label').style.top = rect.top < 30 ? 'calc(100% + 4px)' : 'auto';
  }

  function startPicking() {
    if (!canSelect()) return;
    cancelArea();closePin();closeAi();
    pendingCaptureAction = null;
    localWarning = '';
    el('comment-panel').hidden = true;
    el('comment-error').textContent = '';
    stopPicking(false);
    picking = true;
    hoveredElement = null;
    selectedElement = null;
    selectionMetadata = null;
    pickerAbort = new AbortController();
    const options = {capture: true, signal: pickerAbort.signal};
    el('area-coordinates').hidden=true;
    el('picker-tip').firstElementChild.textContent='Choose an element, or use arrow keys and Enter. Esc to cancel.';
    el('picker-tip').hidden = false;
    const suppress = event => {
      if (isDiffuseEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('pointermove', event => {
      const target = pickTarget(event);
      hoveredElement = target;
      drawSelection(target);
    }, options);
    for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick']) document.addEventListener(eventName, suppress, options);
    document.addEventListener('click', event => {
      const target = pickTarget(event);
      if (!target) return;
      suppress(event);
      try {
        if (!globalThis.DiffuseInspector) throw new Error('The element inspector is unavailable. Reload this page and reconnect Diffuse.');
        selectionMetadata = globalThis.DiffuseInspector.inspect(target);
        selectedElement = target;
        stopPicking(false);
        captureComment();
      } catch (error) {
        stopPicking(false);
        localWarning = error.message;
        paint();
      }
    }, options);
    let keyboardIndex=-1;
    const keyboardTargets=[...document.querySelectorAll('button,a[href],input,select,textarea,h1,h2,h3,p,[data-component],[data-testid],[role]')].filter(node=>!node.closest('[data-diffuse-ui]')&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden').slice(0,400);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stopPicking();return; }
      if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)&&keyboardTargets.length){
        event.preventDefault();event.stopImmediatePropagation();
        const direction=['ArrowUp','ArrowLeft'].includes(event.key)?-1:1;
        keyboardIndex=(keyboardIndex+direction+keyboardTargets.length)%keyboardTargets.length;
        hoveredElement=keyboardTargets[keyboardIndex];hoveredElement.scrollIntoView({block:'nearest',inline:'nearest'});drawSelection(hoveredElement);
        const label=(hoveredElement.getAttribute('aria-label')||hoveredElement.textContent||hoveredElement.tagName).trim().replace(/\s+/g,' ').slice(0,90);
        el('picker-tip').firstElementChild.textContent=`${label}. ${keyboardIndex+1} of ${keyboardTargets.length}. Enter to comment; arrows to choose; Esc to cancel.`;
      }
      if(event.key==='Enter'&&hoveredElement&&!isDiffuseEvent(event)){
        event.preventDefault();event.stopImmediatePropagation();selectedElement=hoveredElement;selectionMetadata=globalThis.DiffuseInspector.inspect(hoveredElement);stopPicking(false);captureComment();
      }else if(event.key==='Enter'&&hoveredElement&&root.activeElement===el('comment')){
        event.preventDefault();event.stopImmediatePropagation();selectedElement=hoveredElement;selectionMetadata=globalThis.DiffuseInspector.inspect(hoveredElement);stopPicking(false);captureComment();
      }
    }, options);
    document.addEventListener('scroll', () => drawSelection(hoveredElement), {...options, passive: true});
    paint();
  }

  function stopPicking(restoreFocus = true) {
    pickerAbort?.abort(); pickerAbort = null;
    const wasPicking = picking;
    picking = false;
    hoveredElement = null;
    if (root) {
      el('picker-tip').hidden = true;
      el('selection-outline').hidden = true;
      paintReviewControls();
      if (restoreFocus && wasPicking && !docked) el('comment').focus({preventScroll: true});
    }
  }

  function showCaptureFailure(error, action) {
    if (contextInvalidated) return;
    if (!root) return;
    pendingCaptureAction = action;
    el('comment-panel').hidden = false;
    el('comment-form').hidden = true;
    el('capture-retry').hidden = false;
    const accessNeeded = error.code === 'NEEDS_CAPTURE_ACCESS';
    el('composer-title').textContent = accessNeeded ? 'Allow capture on this tab' : 'Capture needs attention';
    el('capture-retry-description').textContent = accessNeeded
      ? 'Click the Diffuse extension icon in Chrome on this tab once to allow capture. Diffuse will retry when access is granted.'
      : error.message;
    el('comment-error').textContent = accessNeeded ? '' : 'Your comment has not been saved. Retry to attach its evidence.';
    el('choose-another').hidden = action === 'record';
    if(!docked)el('retry-capture').focus({preventScroll: true});
  }

  async function captureComment() {
    if (!root || captureBusy || !selectionMetadata) return;
    const sessionId = session?.id;
    pendingCaptureAction = null;
    captureBusy = true;
    el('comment-panel').hidden = true;
    el('capture-progress').textContent = isAudit()?'Capturing this page…':'Capturing both pages…';
    el('capture-progress').hidden = false;
    paintReviewControls();
    try {
      if (selectedElement?.isConnected) selectionMetadata = globalThis.DiffuseInspector.inspect(selectedElement);
      if(selectionMetadata.kind==='region'&&!viewportMatches(selectionMetadata.context?.viewport))throw new Error('The page size changed. Choose the area again before capturing.');
      const result = requireSuccess(await send('CAPTURE_COMMENT', {selection: selectionMetadata}));
      if (!result.draft?.id) throw new Error('The screenshot draft was not returned. Retry the capture.');
      if (!root || session?.id !== sessionId) return;
      openComment(result.draft);
    } catch (error) {
      if (session?.id === sessionId) showCaptureFailure(error, 'comment');
    } finally {
      captureBusy = false;
      if (el('capture-progress')) el('capture-progress').hidden = true;
      paintReviewControls();
    }
  }

  function retryCapture() {
    if (pendingCaptureAction === 'record') return startRecording();
    else if (pendingCaptureAction === 'comment-record') return startComposerRecording();
    else if(pendingCaptureAction==='ai')return runAi();
    else if (selectionMetadata) return captureComment();
  }

  function readCommentFields(trim=true) {
    return Object.fromEntries([['title','title'],['comment','actual'],['expected','expected'],['component','component'],['state','state'],['steps','steps'],['severity','severity'],['category','category']].map(([key,id]) => [key,trim?el(`comment-${id}`).value.trim():el(`comment-${id}`).value]));
  }

  function chooseEvidence(choice) {
    if (recording || recordingBusy || commentSaving) return;
    evidenceChoice = choice;
    if (choice === 'screenshot' && pendingCaptureAction === 'comment-record') pendingCaptureAction = null;
    el('comment-error').textContent = '';
    el('composer-title').textContent = choice === 'recording' ? 'Add a recording comment' : 'Add a comment';
    paintEvidenceChoice();
  }

  function paintEvidenceChoice() {
    if (contextInvalidated) return;
    if (!root) return;
    const wantsVideo = evidenceChoice === 'recording';
    const clip = commentDraft?.evidence?.video;
    el('evidence-screenshot').setAttribute('aria-pressed',String(!wantsVideo));
    el('evidence-recording').setAttribute('aria-pressed',String(wantsVideo));
    el('recording-choice').hidden = !wantsVideo;
    el('recording-choice-note').textContent = clip
      ? 'Recording attached. The original screenshot and selected area are included as context.'
      : 'Record an interaction for up to 30 seconds, without audio. Your comment and selected area will be kept.';
    el('comment-record').textContent = clip ? 'Record again' : 'Start recording';
    const preview = el('recording-preview');
    const clipUrl = clip?.dataUrl;
    if (wantsVideo && typeof clipUrl === 'string' && /^data:video\/webm(?:;codecs=[a-z0-9,]+)?;base64,/i.test(clipUrl)) {
      if (preview.getAttribute('src') !== clipUrl) preview.src = clipUrl;
      preview.hidden = false;
    } else {
      preview.pause();preview.removeAttribute('src');preview.hidden = true;
    }
    el('evidence-note').textContent = wantsVideo
      ? 'The recording shows the full page, including Diffuse, without audio. The screenshot preserves your original selection.'
      : (isAudit()?'A screenshot and available observed page details are attached.':'Paired screenshots and observed element details are attached to this capture.');
    paintReviewControls();
  }

  async function startComposerRecording() {
    if (!root || !commentDraft || evidenceChoice !== 'recording' || recording || recordingBusy || captureBusy || commentSaving || aiBusy) return;
    const sessionId = session?.id;
    const draftId = commentDraft.id;
    const fields = readCommentFields();
    commentDraft.composerFields = fields;
    pendingCaptureAction = null;
    recordingBusy = true;
    el('recording-preview').pause();
    el('comment-panel').hidden = true;
    paintReviewControls();
    try {
      const result = requireSuccess(await send('START_RECORDING', {draftId, fields}));
      if (!result.recording?.id) throw new Error('The recording did not start. Try again.');
      if (!root || session?.id !== sessionId) return;
      localWarning = 'Recording your interaction. Stop recording below to return to this comment.';
      setRecording(result.recording);
      paint();
    } catch (error) {
      if (root && session?.id === sessionId) {
        pendingCaptureAction = error.code === 'NEEDS_CAPTURE_ACCESS' ? 'comment-record' : null;
        el('comment-panel').hidden = false;
        el('comment-error').textContent = error.message;
      }
    } finally {
      recordingBusy = false;
      paintReviewControls();
    }
  }

  function openComment(draft) {
    if (contextInvalidated) return;
    if (!root || !draft?.id) return;
    const sameDraft = commentDraft?.id === draft.id;
    if(!sameDraft)commentFieldRevisions.clear();
    const fields = sameDraft ? readCommentFields(false) : draft.composerFields;
    stopPicking(false);
    cancelArea();closePin();closeAi();
    pendingCaptureAction = null;
    commentDraft = draft;
    draftEvidenceRevision++;
    localWarning = '';
    const selection = draft.selection || null;
    if (!sameDraft) el('comment-form').reset();
    el('comment-panel').hidden = false;
    el('capture-retry').hidden = true;
    el('comment-form').hidden = false;
    el('composer-title').textContent = draft.evidence?.video ? 'Add a recording comment' : 'Add a comment';
    el('comment-error').textContent = '';
    el('comment-component').value = selection?.component?.name || 'Page';
    el('comment-state').value = 'Current state';
    el('comment-category').value=isAudit()?'ux-issue':'design-mismatch';
    if (fields) for (const [key,id] of [['title','title'],['comment','actual'],['expected','expected'],['component','component'],['state','state'],['steps','steps'],['severity','severity'],['category','category']]) {
      if (typeof fields[key] === 'string') el(`comment-${id}`).value = fields[key];
    }
    colorCategory(el('comment-category'),el('comment-category').value);
    evidenceChoice = draft.evidenceChoice==='screenshot' ? 'screenshot' : draft.evidence?.video || draft.evidenceChoice==='video' ? 'recording' : sameDraft ? evidenceChoice : 'screenshot';
    el('component-hint').textContent = selection?.component?.source
      ? `Inferred from ${selection.component.source}. Edit this to match your team's component name.`
      : 'Name the component or page this recording describes.';
    el('selection-summary').textContent = selection?.kind==='region'?`Selected area · ${Math.round(selection.rect.viewport.width)} × ${Math.round(selection.rect.viewport.height)} px`:selection?.selector || 'Page-level capture';
    for (const [side, imageId] of [['production', 'production-preview'], ['prototype', 'prototype-preview']]) {
      const dataUrl = draft.evidence?.[side]?.dataUrl;
      const image = el(imageId);
      image.closest('figure').hidden=side==='prototype'&&isAudit();
      if(side==='production')image.closest('figure').querySelector('figcaption').textContent=isAudit()?'Page':'Production';
      if (typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) { image.src = dataUrl; image.hidden = false; }
      else { image.removeAttribute('src'); image.hidden = true; }
    }
    el('evidence-preview').style.gridTemplateColumns=isAudit()?'1fr':'1fr 1fr';
    paintEvidenceChoice();
    paint();
    if(!docked)el('comment-actual').focus({preventScroll: true});
  }

  function closeComment() {
    if (contextInvalidated) return;
    if (commentSaving || recording || recordingBusy || !root) return;
    el('recording-preview').pause();
    el('recording-preview').removeAttribute('src');
    if (commentDraft?.id) quietSend('DISCARD_DRAFT', {draftId: commentDraft.id});
    commentDraft = null;
    pendingCaptureAction = null;
    selectedElement = null;
    selectionMetadata = null;
    el('comment-panel').hidden = true;
    el('comment-error').textContent = '';
    paintReviewControls();
    if(!docked)el('comment').focus({preventScroll: true});
  }

  async function saveComment(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (!commentDraft || commentSaving || recording || recordingBusy) return;
    if(!el('comment-form').checkValidity()){
      if(!docked)el('comment-form').reportValidity();
      el('comment-error').textContent='Add your comment and a state name before saving.';notifyPanel();return;
    }
    const fields = {
      title: el('comment-title').value.trim(),
      comment: el('comment-actual').value.trim(),
      expected: el('comment-expected').value.trim(),
      component: el('comment-component').value.trim() || 'Page',
      state: el('comment-state').value.trim(),
      steps: el('comment-steps').value.trim(),
      severity: el('comment-severity').value,
      category: el('comment-category').value,
    };
    if (!fields.comment || !fields.state) {
      el('comment-error').textContent = 'Add your comment and a state name before saving.';
      notifyPanel();
      return;
    }
    if (evidenceChoice === 'recording' && !commentDraft.evidence?.video) {
      el('comment-error').textContent = 'Record a short clip, or choose Screenshot before saving.';
      notifyPanel();
      return;
    }
    commentSaving = true;
    el('comment-error').textContent = '';
    el('save-comment').textContent = 'Saving…';
    paintReviewControls();
    try {
      const result = requireSuccess(await send('ADD_COMMENT', {draftId: commentDraft.id, fields, evidenceChoice: evidenceChoice === 'recording' ? 'video' : 'screenshot'}));
      el('recording-preview').pause();el('recording-preview').removeAttribute('src');
      commentDraft = null;
      if (session && result.review) session.commentCount = result.review.count;
      if(session&&result.comment){const comment=result.comment;session.comments=[...(session.comments||[]).filter(item=>item.id!==comment.id),{id:comment.id,createdAt:comment.createdAt,fields:comment.fields,selection:comment.selection,context:{production:comment.context?.production},ai:comment.ai}];renderPins();}
      if (root) { el('comment-panel').hidden = true; localWarning = 'Comment saved. Open Review to copy or export it.'; paint(); }
    } catch (error) {
      if (el('comment-error')) el('comment-error').textContent = error.message;
    } finally {
      commentSaving = false;
      if (el('save-comment')) el('save-comment').textContent = 'Save comment';
      paintReviewControls();
    }
  }

  function setRecording(value) {
    if (contextInvalidated) return;
    recording = value || null;
    clearInterval(recordingTimer);
    recordingTimer = recording ? setInterval(paintReviewControls, 250) : null;
    paintReviewControls();
  }

  async function startRecording() {
    if (!root || recording || recordingBusy || captureBusy || commentDraft || aiBusy) return;
    stopPicking(false);
    cancelArea();closePin();closeAi();
    pendingCaptureAction = null;
    recordingBusy = true;
    el('comment-panel').hidden = true;
    el('capture-progress').textContent = isAudit()?'Preparing screenshot and recording…':'Preparing screenshots and recording…';
    el('capture-progress').hidden = false;
    paintReviewControls();
    try {
      const result = requireSuccess(await send('START_RECORDING', {selection: null}));
      if (!result.recording?.id) throw new Error('The recording did not start. Try again.');
      if (root) { localWarning = ''; setRecording(result.recording); paint(); }
    } catch (error) {
      showCaptureFailure(error, 'record');
    } finally {
      recordingBusy = false;
      if (el('capture-progress')) el('capture-progress').hidden = true;
      paintReviewControls();
    }
  }

  async function stopRecording() {
    if (!recording || recordingBusy) return;
    recordingBusy = true;
    paintReviewControls();
    try {
      const result = requireSuccess(await send('STOP_RECORDING'));
      setRecording(null);
      if (!result.draft?.id) throw new Error('The recording draft was not returned. Open Review to check the saved evidence.');
      openComment(result.draft);
    } catch (error) {
      localWarning = error.message;
      paint();
    } finally {
      recordingBusy = false;
      paintReviewControls();
    }
  }

  function paintReviewControls() {
    if (contextInvalidated) return;
    if(root&&session)paintViewport();
    if (!root) return;
    const diffReason=diffDisabledReason();
    el('diff').disabled=Boolean(diffReason);
    el('diff').title=diffReason||(hasReference()?'Choose a different reference tab':'Choose a reference tab to compare');
    el('diff-hint').hidden=!diffReason;el('diff-hint').textContent=diffReason;
    el('comment').disabled = captureBusy || commentSaving || recordingBusy || Boolean(recording) || Boolean(commentDraft) || aiBusy || aiOperationBusy || Boolean(session?.aiRunning);
    el('comment').setAttribute('aria-pressed', String(picking));
    el('comment').textContent = picking ? 'Cancel selection' : 'Comment';
    el('area-comment').disabled=el('comment').disabled;
    el('area-comment').setAttribute('aria-pressed',String(areaArmed));
    const count = Number(session?.commentCount) || 0;
    el('review').textContent = `Review (${count})`;
    el('record').disabled = recordingBusy || captureBusy || commentSaving || (Boolean(commentDraft) && !recording) || picking || areaArmed || aiBusy || aiOperationBusy || Boolean(session?.aiRunning);
    el('record').dataset.recording = String(Boolean(recording));
    if (recording) {
      const started = typeof recording.startedAt === 'number' ? recording.startedAt : Date.parse(recording.startedAt);
      const elapsed = Number.isFinite(started) ? Math.min(30, Math.max(0, Math.floor((Date.now() - started) / 1000))) : 0;
      el('record').textContent = recordingBusy ? 'Saving recording…' : `Stop recording · 00:${String(elapsed).padStart(2, '0')}`;
      el('record').title = 'Stop recording. No audio. Stops automatically at 30 seconds.';
    } else {
      el('record').textContent = recordingBusy ? 'Starting recording…' : 'Record';
      el('record').title = 'Record this page as shown. No audio. Up to 30 seconds.';
    }
    el('save-comment').disabled = commentSaving || !commentDraft || recordingBusy || Boolean(recording);
    el('cancel-comment').disabled = commentSaving || recordingBusy || Boolean(recording);
    el('close-comment').disabled = commentSaving || recordingBusy || Boolean(recording);
    for (const id of ['evidence-screenshot','evidence-recording','comment-record']) el(id).disabled = commentSaving || recordingBusy || Boolean(recording);
    el('retry-capture').disabled = captureBusy || recordingBusy;
    el('ai-review').disabled=captureBusy||commentSaving||Boolean(commentDraft)||Boolean(recording)||recordingBusy;
    el('ai-run').disabled=aiBusy||aiOperationBusy||Boolean(session?.aiRunning)||!aiConfig.hasKey||captureBusy||Boolean(recording);
    el('ai-run').textContent=aiBusy||session?.aiRunning?'Reviewing…':aiBatch?'Run new AI review':'Run AI review';
    updatePanelState();
    updatePinPositions();
  }

  function finiteOffset(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(3000, Math.max(-3000, number)) : 0; }

  function paint() {
    if (contextInvalidated) return;
    if (!root || !session) return;
    const audit=isAudit();
    for(const id of ['opacity','linked','hide','align','source','reconnect']){
      const control=el(id);if(control)(control.closest('.control')||control).hidden=audit;
    }
    root.querySelector('.separator').hidden=audit;
    const settings = {opacity:.55,reveal:50,offsetX:0,offsetY:0,...session.settings};
    if(!audit){
    el('layer').style.opacity = String(settings.opacity);
    el('layer').style.clipPath = `inset(0 0 0 ${settings.reveal}%)`;
    el('layer').hidden = settings.hidden || session.status === 'error';
    el('divider').hidden = settings.hidden;
    // Keep the grip reachable when the reference is fully revealed or hidden.
    el('divider').style.left = `clamp(18px, ${settings.reveal}%, calc(100% - 18px))`;
    el('handle').setAttribute('aria-valuenow', String(Math.round(settings.reveal)));
    el('handle').setAttribute('aria-valuetext', `${Math.round(100 - settings.reveal)}% prototype revealed`);
    el('opacity').value = String(Math.round(settings.opacity * 100));
    el('opacity-value').value = `${Math.round(settings.opacity * 100)}%`;
    el('reveal').value=String(Math.round(settings.reveal));el('reveal-value').value=`${Math.round(settings.reveal)}%`;
    el('linked').checked = settings.linked;
    el('hide').textContent = settings.hidden ? 'Show reference' : 'Hide reference';
    el('hide').setAttribute('aria-pressed', String(settings.hidden));
    if (root.activeElement !== el('offset-x')) el('offset-x').value = settings.offsetX;
    if (root.activeElement !== el('offset-y')) el('offset-y').value = settings.offsetY;
    video.style.width = `${session.sourceViewport?.width || innerWidth}px`;
    video.style.height = `${session.sourceViewport?.height || innerHeight}px`;
    video.style.transform = `translate(${settings.offsetX}px, ${settings.offsetY}px)`;
    const labels = {starting: 'Starting', connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', error: 'Disconnected'};
    el('status').textContent = labels[session.status] || 'Connecting';
    el('status').dataset.state = session.status;
    el('reconnect').hidden = !['reconnecting', 'error'].includes(session.status);
    }else{el('layer').hidden=true;el('divider').hidden=true;el('status').textContent=({starting:'Preparing review',connecting:'Preparing review',reconnecting:'Preparing review',error:'Review unavailable'}[session.status]||'Review ready');el('status').dataset.state=session.status||'live';}
    el('warning').textContent = [session.error, session.warning, localWarning].filter(Boolean).join(' · ');
    paintReviewControls();
    renderPins();
  }

  function updateSettings(partial) {
    if (contextInvalidated) return;
    if (!session || isAudit()) return;
    session.settings = {...session.settings, ...partial};
    paint();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { settingsTimer = null; quietSend('SETTINGS', {settings: session.settings}); }, 100);
  }

  function scrollDescriptor(target) {
    if (target === document || target === document.documentElement || target === document.body) return {kind: 'root'};
    if (!(target instanceof Element)) return null;
    for (const attribute of ['data-diffuse-scroll', 'id', 'aria-label']) {
      const value = target.getAttribute(attribute);
      if (value && document.querySelectorAll(`[${attribute}="${CSS.escape(value)}"]`).length === 1) return {kind: 'element', attribute, value};
    }
    return null;
  }

  function syncScroll(target) {
    if (contextInvalidated) return;
    if (isAudit() || session?.settings?.hidden || !session?.settings?.linked || role !== 'target') return;
    const descriptor = scrollDescriptor(target);
    if (!descriptor) {
      localWarning = 'This nested panel is not linked. Matching panels need the same unique id, label, or data-diffuse-scroll value.';
      paint(); return;
    }
    const position = descriptor.kind === 'root' ? {x: scrollX, y: scrollY} : {x: target.scrollLeft, y: target.scrollTop};
    const currentId = session.id;
    send('SCROLL', {scroll: {...descriptor, ...position}}).then(result => {
      if (contextInvalidated || session?.id !== currentId) return;
      localWarning = result?.ok ? '' : result?.error || 'Prototype scroll is unavailable.';
      paint();
    }).catch(() => {});
  }

  function applyScroll(scroll) {
    if (!scroll || !Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) return {ok: false, error: 'Invalid scroll position.'};
    if (scroll.kind === 'root') { window.scrollTo({left: scroll.x, top: scroll.y, behavior: 'instant'}); return {ok: true}; }
    if (!['data-diffuse-scroll', 'id', 'aria-label'].includes(scroll.attribute) || typeof scroll.value !== 'string') return {ok: false, error: 'Unknown scroll container.'};
    const matches = document.querySelectorAll(`[${scroll.attribute}="${CSS.escape(scroll.value)}"]`);
    if (matches.length !== 1) return {ok: false, error: 'No unique matching scroll panel in the prototype. Scroll it independently.'};
    matches[0].scrollTo({left: scroll.x, top: scroll.y, behavior: 'instant'});
    return {ok: true};
  }

  function canScrollReference() {
    return !contextInvalidated && role === 'target' && hasReference() && session?.status === 'live'
      && !session.settings?.hidden && (session.settings?.opacity ?? .55) > 0 && !session.settings?.linked
      && Number.isFinite(session.sourceViewport?.width) && session.sourceViewport.width > 0
      && Number.isFinite(session.sourceViewport?.height) && session.sourceViewport.height > 0 && !areaDrag && !areaArmed && !cHeld && !picking
      && !captureBusy && !host?.hasAttribute('data-evidence-hidden') && video && !el('layer')?.hidden;
  }

  function referenceWheel(event) {
    // Left-side wheel and browser zoom retain the website's normal behavior.
    // Diffuse's own controls must always scroll their own panels.
    if (!canScrollReference() || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.composedPath().includes(host)) return;
    const reveal = Math.max(0, Math.min(100, session.settings?.reveal ?? 50));
    if (event.clientX < innerWidth * reveal / 100) return;
    const bounds = video.getBoundingClientRect();
    if (!bounds.width || !bounds.height || event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return;
    const sourceWidth = session.sourceViewport?.width || bounds.width;
    const sourceHeight = session.sourceViewport?.height || bounds.height;
    let dx = event.deltaX, dy = event.deltaY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || ![0, 1, 2].includes(event.deltaMode)) return;
    if (event.shiftKey && !dx) {dx = dy; dy = 0;}
    const factor = event.deltaMode === 1 ? 16 : 1;
    dx *= event.deltaMode === 2 ? sourceWidth : factor * sourceWidth / bounds.width;
    dy *= event.deltaMode === 2 ? sourceHeight : factor * sourceHeight / bounds.height;
    if (!dx && !dy) return;
    const clamp = value => Math.max(-4096, Math.min(4096, value));
    event.preventDefault(); event.stopImmediatePropagation();
    const wheel = {x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height,
      deltaX: clamp((pendingReferenceWheel?.wheel.deltaX || 0) + dx), deltaY: clamp((pendingReferenceWheel?.wheel.deltaY || 0) + dy)};
    pendingReferenceWheel = {sessionId: session.id, sourceTabId: session.sourceTabId, wheel};
    if (referenceWheelFrame !== null) return;
    referenceWheelFrame = requestAnimationFrame(() => {
      referenceWheelFrame = null;
      const pending = pendingReferenceWheel; pendingReferenceWheel = null;
      if (!pending || !canScrollReference() || session.id !== pending.sessionId || session.sourceTabId !== pending.sourceTabId) return;
      send('SCROLL_REFERENCE', {wheel: pending.wheel}).then(result => {
        if (contextInvalidated || session?.id !== pending.sessionId || !canScrollReference()) return;
        if (!result?.ok) {localWarning = result?.error || 'Prototype scroll is unavailable. Reconnect the comparison.'; paint();}
      }).catch(() => {});
    });
  }

  function applyReferenceWheel(wheel) {
    if (!wheel || !['x', 'y', 'deltaX', 'deltaY'].every(key => Number.isFinite(wheel[key]))
      || wheel.x < 0 || wheel.x >= 1 || wheel.y < 0 || wheel.y >= 1
      || Math.abs(wheel.deltaX) > 4096 || Math.abs(wheel.deltaY) > 4096) return {ok: false, error: 'Invalid reference scroll.'};
    if (session?.settings?.hidden || session?.settings?.linked || !hasReference()) return {ok: true};
    const x = wheel.x * innerWidth, y = wheel.y * innerHeight;
    let node = document.elementFromPoint(x, y);
    while (node?.shadowRoot?.elementFromPoint) {
      const deeper = node.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === node) break;
      node = deeper;
    }
    if (node?.tagName === 'IFRAME') return {ok: false, error: 'Embedded reference frames need to be scrolled in the reference tab.'};
    const ancestors = [];
    while (node instanceof Element) {
      if (!ancestors.includes(node)) ancestors.push(node);
      node = node.parentElement || node.getRootNode()?.host;
    }
    const scrollingRoot = document.scrollingElement;
    if (scrollingRoot && !ancestors.includes(scrollingRoot)) ancestors.push(scrollingRoot);
    // Move the actual scrollable element beneath the mapped pointer; no matching
    // selector is needed. At boundaries, follow the page's overscroll chaining.
    for (const [axis, amount] of [['x', wheel.deltaX], ['y', wheel.deltaY]]) {
      let remaining = amount;
      const position = axis === 'x' ? 'scrollLeft' : 'scrollTop';
      for (const element of ancestors) {
        if (Math.abs(remaining) < .01) break;
        const style = getComputedStyle(element), isRoot = element === scrollingRoot;
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        const scrollable = isRoot ? !['hidden', 'clip'].includes(overflow) : ['auto', 'scroll', 'overlay'].includes(overflow);
        if (!scrollable) continue;
        const before = element[position];
        element.scrollBy({[axis === 'x' ? 'left' : 'top']: remaining, behavior: 'instant'});
        remaining -= element[position] - before;
        const overscroll = axis === 'x' ? style.overscrollBehaviorX : style.overscrollBehaviorY;
        if (overscroll === 'contain' || overscroll === 'none') break;
      }
    }
    return {ok: true};
  }

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); };
      const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 2500);
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }

  async function receiveOffer(message) {
    if (role !== 'target' || !video) return {ok: false};
    if (peer) { peer.onconnectionstatechange = null; peer.close(); }
    clearTimeout(reconnectTimer);
    clearTimeout(connectionDeadline);
    if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    frameCallback = null;
    const pc = new RTCPeerConnection({iceServers: []});
    peer = pc;
    connectionId = message.connectionId;
    const thisConnectionId = connectionId;
    connectionDeadline = setTimeout(() => {
      if (peer === pc) { localWarning = 'The live stream has not arrived. Use Reconnect, or restart from the prototype tab.'; quietSend('STREAM_STATUS', {status: 'reconnecting'}); paint(); }
    }, 12000);
    pc.ontrack = event => {
      if (contextInvalidated || peer !== pc || !video) return;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().catch(() => { localWarning = 'Click the page to allow the live preview to play.'; paint(); });
      checkFrame(pc, thisConnectionId);
    };
    pc.onconnectionstatechange = () => {
      if (peer !== pc || !session) return;
      if (pc.connectionState === 'connected') clearTimeout(reconnectTimer);
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        quietSend('STREAM_STATUS', {status: 'reconnecting'});
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { if (peer === pc && pc.connectionState !== 'connected') quietSend('RECONNECT'); }, 2000);
      }
    };
    await pc.setRemoteDescription(message.description);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    if (peer !== pc) return {ok: true};
    const result = await send('RTC_ANSWER', {connectionId: thisConnectionId, description: pc.localDescription.toJSON()});
    if (!result?.ok) throw new Error(result?.error || 'Could not connect the live stream.');
    return {ok: true};
  }

  function checkFrame(pc = peer, id = connectionId) {
    if (!pc || !video) return;
    if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    frameCallback = video.requestVideoFrameCallback(() => {
      frameCallback = null;
      if (peer !== pc || connectionId !== id || !session) return;
      clearTimeout(connectionDeadline);
      localWarning = '';
      quietSend('RTC_CONNECTED', {connectionId: id});
    });
  }

  function stopResources() {
    clearInterval(contextTimer); contextTimer = null;
    clearInterval(pinsTimer); pinsTimer = null;
    clearInterval(recordingTimer); recordingTimer = null;
    clearTimeout(panelNotifyTimer); panelNotifyTimer = null;
    pickerAbort?.abort(); pickerAbort = null;
    modalObserver?.disconnect(); modalObserver = null;
    abort?.abort(); abort = null;
    clearTimeout(settingsTimer); clearTimeout(resizeTimer); clearTimeout(reconnectTimer); clearTimeout(connectionDeadline);
    settingsTimer = null;
    if (frameCallback !== null && video) video.cancelVideoFrameCallback(frameCallback);
    frameCallback = null;
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
    if (referenceWheelFrame !== null) cancelAnimationFrame(referenceWheelFrame);
    referenceWheelFrame = null; pendingReferenceWheel = null;
    if (peer) { peer.onconnectionstatechange = null; peer.ontrack = null; peer.close(); peer = null; }
    if (video) { video.pause(); video.srcObject = null; }
  }

  function invalidateContext() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    globalThis.DiffuseSelect?.destroy(root, {preserveUI: true});
    stopResources();
    if (!root || !host) return;
    // Keep the original fields/evidence in memory for copying. Do not send a
    // discard, replay Save, or tear down the DOM while async handlers settle.
    docked = false;
    host.removeAttribute('data-docked');
    host.removeAttribute('data-evidence-hidden');
    host.setAttribute('data-context-invalidated', '');
    host.toggleAttribute('data-reload-draft', Boolean(commentDraft));
    for (const node of root.querySelectorAll('button,select,input,textarea')) {
      if (node.matches('textarea,input:not([type]),input[type=text]')) node.readOnly = true;
      else node.disabled = true;
    }
    for (const panel of root.querySelectorAll('[aria-modal]')) panel.setAttribute('aria-modal', 'false');
    el('recording-preview')?.pause();
    const notice = document.createElement('section');
    notice.id = 'context-reload-notice'; notice.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = reloadMessage + (commentDraft ? ' Your unsaved text is still here to copy before refreshing. If you were saving, check Review reports before adding it again.' : ' Saved reviews are kept.');
    const dismiss = document.createElement('button');
    dismiss.id = 'dismiss-reload-notice'; dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => host.remove());
    notice.append(text, dismiss); root.append(notice);
    if (commentDraft) { el('comment-panel').hidden = false; el('comment-form').hidden = false; }
    // Let people select/copy their text, but block stale form and keyboard actions.
    for (const type of ['click','submit','input','change','keydown']) root.addEventListener(type, event => {
      if (event.composedPath().includes(notice)) return;
      event.stopImmediatePropagation();
      if (type === 'submit') event.preventDefault();
    }, {capture: true});
  }

  function cleanup() {
    if (root) globalThis.DiffuseSelect?.destroy(root);
    stopResources();
    stopPicking(false);
    clearInterval(pinsTimer);pinsTimer=null;
    areaArmed=false;areaDrag=null;cHeld=false;cGestureUsed=false;ignoreNextAreaClick=false;openPinId=null;pinItems=[];pinsUrl='';pinsViewport='';
    aiBatch=null;aiBusy=false;aiOperationBusy=false;aiBulkAccepting=false;aiThresholdOverride=null;aiSavedThreshold=null;aiPreviewContext=null;
    clearInterval(recordingTimer); recordingTimer = null;
    recording = null; recordingBusy = false; commentSaving = false; captureBusy = false;
    commentDraft = null; pendingCaptureAction = null; selectedElement = null; selectionMetadata = null;
    evidenceChoice = 'screenshot'; evidencePreviouslyHidden = null;
    docked=false;clearTimeout(panelNotifyTimer);panelNotifyTimer=null;draftEvidenceRevision=0;commentFieldRevisions.clear();
    video = null;
    host?.remove(); host = null; root = null; session = null; role = null; localWarning = ''; connectionId = null;
  }

  async function receive(message) {
    if (contextInvalidated || !runtimeAvailable()) { invalidateContext(); throw reloadError(); }
    if (message.type === 'INITIALIZE') {
      cleanup();
      session = message.session; role = message.role;
      abort = new AbortController();
      contextTimer = setInterval(() => { if (!runtimeAvailable()) invalidateContext(); }, 1000);
      if (role === 'target') { makeOverlay(); setRecording(session.recording || null); paint(); }
      const resize = () => {
        if(role==='target'){
          if(areaArmed||areaDrag){cancelArea();localWarning='The page resized. Select the area again at this size.';}
          if(!commentDraft&&!captureBusy&&selectionMetadata?.kind==='region'&&!viewportMatches(selectionMetadata.context?.viewport)){
            selectionMetadata=null;pendingCaptureAction=null;el('comment-panel').hidden=true;
            localWarning='The page resized. Select the area again before capturing.';
          }
          if(el('ai-region-preview'))el('ai-region-preview').hidden=true;
          paint();
        }
        updatePinPositions();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>quietSend('VIEWPORT',{viewport:viewport()}),150);
      };
      window.addEventListener('resize', resize, {signal: abort.signal});
      window.visualViewport?.addEventListener('resize', resize, {signal: abort.signal});
      document.addEventListener('wheel', referenceWheel, {capture: true, passive: false, signal: abort.signal});
      document.addEventListener('scroll', event => {
        if(role==='target'&&!event.composedPath().includes(host)){updatePinPositions();if(el('ai-region-preview'))el('ai-region-preview').hidden=true;}
        if (role !== 'target' || isAudit() || session.settings?.hidden || !session.settings?.linked || event.composedPath().includes(host)) return;
        const target = event.target;
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => { scrollFrame = null; syncScroll(target); });
      }, {capture: true, passive: true, signal: abort.signal});
      document.addEventListener('keydown', event => {
        if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
        if(isAudit())return;
        if (event.code === 'KeyD' && role === 'target') { event.preventDefault(); updateSettings({hidden: !session.settings.hidden}); }
        if (event.code === 'KeyP') { event.preventDefault(); quietSend(role === 'target' ? 'FOCUS_SOURCE' : 'FOCUS_TARGET'); }
      }, {signal: abort.signal});
      return {ok: true, viewport: viewport()};
    }
    if (message.type === 'STOP') { cleanup(); return {ok: true}; }
    if (message.type === 'SESSION_UPDATE') {
      if (session?.id === message.session.id) {
        const pendingSettings = settingsTimer !== null ? session.settings : null;
        session = message.session;
        if (pendingSettings) session.settings = pendingSettings;
        if (role === 'target' && Object.prototype.hasOwnProperty.call(session, 'recording')) setRecording(session.recording || null);
        paint();
      }
      return {ok: true};
    }
    if (!session || message.sessionId !== session.id) return {ok: false, error: 'Page is not paired.'};
    if(message.type==='DOCK_STATE'&&role==='target'){
      docked=Boolean(message.docked);host.toggleAttribute('data-docked',docked);
      // The native drawer owns its own focus. Hidden shadow forms must not keep
      // the page inert, and closing the drawer must reveal the same draft.
      updatePanelState();paintReviewControls();return{ok:true};
    }
    if(message.type==='PANEL_STATE'&&role==='target')return{ok:true,state:panelState(message)};
    if(message.type==='PANEL_COMMAND'&&role==='target')return panelCommand(message);
    if(message.type==='REVEAL_COMMENT'&&role==='target')return revealComment(message.commentId);
    if (message.type === 'GET_CONTEXT') return {ok: true, context: currentContext()};
    if (message.type === 'ANCHOR_SELECTION' && role === 'target') {
      const selection=message.selection, context=selection?.context, rect=selection?.rect?.viewport;
      // AI coordinates refer to the original screenshots. Attach a DOM anchor
      // only while the page is still at that captured URL, size and scroll.
      if(selection?.kind!=='region'||!rect||context?.url!==location.href||!viewportMatches(context.viewport)
        ||Math.abs((context.scroll?.x||0)-scrollX)>1||Math.abs((context.scroll?.y||0)-scrollY)>1)return{ok:true,selection};
      const recordedNested=context.nestedScroll||[], currentNested=globalThis.DiffuseInspector.nestedScrollSnapshot();
      if(recordedNested.length!==currentNested.length||recordedNested.some(saved=>!currentNested.some(now=>now.selector===saved.selector&&Math.abs(now.x-saved.x)<=1&&Math.abs(now.y-saved.y)<=1)))return{ok:true,selection};
      const observed=globalThis.DiffuseInspector.region(rect.x,rect.y,rect.width,rect.height);
      return{ok:true,selection:{...selection,...(observed.anchor?{anchor:observed.anchor}:{})}};
    }
    if (message.type === 'REFRESH_SELECTION' && role === 'target') {
      const element = globalThis.DiffuseInspector.resolveSelector(message.selector);
      return {ok: true, selection: element ? globalThis.DiffuseInspector.inspect(element) : null};
    }
    if (message.type === 'PREPARE_EVIDENCE') {
      const context = currentContext();
      if (host) {
        if (evidencePreviouslyHidden === null) evidencePreviouslyHidden = host.hasAttribute('data-evidence-hidden');
        host.setAttribute('data-evidence-hidden', '');
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {ok: true, context};
    }
    if (message.type === 'RESTORE_EVIDENCE') {
      if (host && evidencePreviouslyHidden === false) host.removeAttribute('data-evidence-hidden');
      evidencePreviouslyHidden = null;
      return {ok: true};
    }
    if (message.type === 'CAPTURE_ACCESS_GRANTED' && role === 'target') {
      if (pendingCaptureAction && !captureBusy && !recordingBusy) retryCapture();
      return {ok: true};
    }
    if (message.type === 'RECORDING_STOPPED' && role === 'target') {
      setRecording(null);
      recordingBusy = false;
      if (message.draft) {
        openComment(message.draft);
        if (message.error) el('comment-error').textContent = `${message.error}${message.draft.evidence?.video ? ' Your previous clip is still attached; the new recording was not saved.' : ' Your comment and screenshot are still available.'}`;
      }
      else { localWarning = message.error || 'The recording stopped. Open Review to check its evidence.'; paint(); }
      return {ok: true};
    }
    if (message.type === 'RTC_OFFER') return receiveOffer(message);
    if (message.type === 'APPLY_SCROLL' && role === 'source' && !session.settings?.hidden && session.settings?.linked) return applyScroll(message.scroll);
    if (message.type === 'APPLY_WHEEL' && role === 'source') return applyReferenceWheel(message.wheel);
    if (message.type === 'SYNC_NOW' && role === 'target') { syncScroll(document); return {ok: true}; }
    if (message.type === 'CHECK_FRAME' && role === 'target') { checkFrame(); return {ok: true}; }
    return {ok: false, error: 'Unknown page command.'};
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (contextInvalidated || !runtimeAvailable()) { invalidateContext(); return; }
    if (sender.id !== chrome.runtime.id || message?.namespace !== 'diffuse' || message.target) return;
    const reply = value => { try { respond(value); } catch { /* The sender may have reloaded as well. */ } };
    receive(message).then(reply, error => { localWarning = error.message; paint(); reply({ok: false, error: error.message, code: error.code}); });
    return true;
  });
})();
