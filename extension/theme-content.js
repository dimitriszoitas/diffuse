/* Scoped presentation only. The shared theme controller owns preference and lifecycle. */
globalThis.DiffuseDarkStyles = `
:host([data-theme="dark"]) {
  color-scheme: dark !important;
  --ink: #e8eff8; --panel: #172432; --raised: #1c2b3c;
  --text: #e8eff8; --muted: #a6b6ca; --line: #607a99; --accent: #91b9ff;
  --ui-accent: #91b9ff; --ui-muted: #a6b6ca; --coral: #f1a08a;
}
:host([data-theme="dark"]) :is(button, summary) { background: var(--raised); border-color: var(--line); color: var(--text); }
:host([data-theme="dark"]) :is(button, summary):hover { background: #25384e; }
:host([data-theme="dark"]) :is(input, textarea, select) { background: #13202e; color: var(--text); border-color: var(--line); color-scheme: dark; }
:host([data-theme="dark"]) :is(input, textarea)::placeholder { color: #90a2b9; }
:host([data-theme="dark"]) .composer-field select { color-scheme: dark; }
:host([data-theme="dark"]) :is(button, input, textarea, select, summary):focus-visible { outline-color: var(--accent); }
:host([data-theme="dark"]) #handle { background: #1b3048; color: #bdd7ff; border-color: #6889b2; box-shadow: 0 2px 10px #00000045; }
:host([data-theme="dark"]) .edge-label { background: #182b42f5; color: #bed7fc; border-color: #4b6c95; }
:host([data-theme="dark"]) #divider { background: #8fb7fb; }
:host([data-theme="dark"]) #selection-outline { border-color: #8fb7fb; background: #7ca7ff14; box-shadow: 0 0 0 1px #101a2ac9; }
:host([data-theme="dark"]) #selection-outline[data-region="true"] { background: #7ca7ff20; }
:host([data-theme="dark"]) :is(#selection-label, #ai-region-label) { background: #2b60b6; color: #fff; }
:host([data-theme="dark"]) #ai-region-preview { border-color: #8fb7fb; background: #7ca7ff14; }
:host([data-theme="dark"]) .comment-pin { background: var(--category-color, #c9adff); color: var(--category-ink, #38205d); border-color: #e5edf7; box-shadow: 0 2px 10px #00000055; }
:host([data-theme="dark"]) .comment-pin:is(:hover, [aria-expanded="true"]) { background: var(--category-color, #c9adff); color: var(--category-ink, #38205d); outline-color: #8fb7fb; }
:host([data-theme="dark"]) .comment-pin[data-dragging] { outline-color: #8fb7fb; box-shadow: 0 4px 16px #00000060; }
:host([data-theme="dark"]) #comment-pin-connections line { stroke: #92b4e2; }
:host([data-theme="dark"]) #comment-pin-connections circle { fill: #172432; stroke: #92b4e2; }
:host([data-theme="dark"]) :is(#saved-comment-bubble, #comment-panel, #ai-panel, #context-reload-notice, #picker-tip, #capture-progress, #pin-position-status) { background: var(--panel); color: var(--text); border-color: #405772; box-shadow: 0 8px 32px #00000055; }
:host([data-theme="dark"]) #saved-comment-category { background: var(--category-color, #c9adff); color: var(--category-ink, #38205d); }
:host([data-theme="dark"]) #select-pin-area { background: #213955; color: #bed7ff; border-color: #496b95; }
:host([data-theme="dark"]) #select-pin-area:hover { background: #2b4668; }
:host([data-theme="dark"]) #pin-attachment { color: var(--accent); }
:host([data-theme="dark"]) #panel-backdrop { background: #06102066; }
:host([data-theme="dark"]) .composer-header { background: var(--panel); border-color: #2c3e53; }
:host([data-theme="dark"]) .composer-footer { background: #142131; border-color: #2c3e53; }
:host([data-theme="dark"]) :is(#save-comment, #ai-run, #ai-accept-all) { background: linear-gradient(180deg, #3672da, #275cb8); color: #fff; border-color: #467fe6; box-shadow: inset 0 1px 0 #ffffff14, 0 2px 6px #00000030; }
:host([data-theme="dark"]) :is(#save-comment, #ai-run, #ai-accept-all):hover { background: linear-gradient(180deg, #417fe7, #3068c9); }
:host([data-theme="dark"]) button:disabled { color: #a6b6ca; background: #1c2b3c; border-color: #2c3e53; box-shadow: none; }
:host([data-theme="dark"]) .composer-error { background: #38272f; color: #ffaaa9; border-color: #76505a; }
:host([data-theme="dark"]) #area-error { color: #ffaaa9; }
:host([data-theme="dark"]) .evidence-preview figure { background: #172432; border-color: #2c3e53; }
:host([data-theme="dark"]) .evidence-preview img,
:host([data-theme="dark"]) #recording-preview { background: #0d1722; }
:host([data-theme="dark"]) .evidence-options button[aria-pressed="true"] { background: #27496e; color: #d5e6ff; border-color: #82a9e4; }
:host([data-theme="dark"]) #comment-category { color: var(--text); border-color: var(--line); }
:host([data-theme="dark"]) #comment-category option { background: var(--panel); color: var(--text); }
:host([data-theme="dark"]) :is(.ai-suggestion, .ai-disclosure, #ai-results-status) { background: #1c2b3c; border-color: #3b516b; }
:host([data-theme="dark"]) :is(.ai-suggestion h4, .ai-suggestion-meta, .threshold-ends small, #ai-results-status p, .ai-disclosure) { color: var(--muted); }
:host([data-theme="dark"]) .ai-change { background: #19352f; border-color: #639f88; }
:host([data-theme="dark"]) .ai-change h4 { color: #99d5bc; }
:host([data-theme="dark"]) .ai-suggestion [data-action="accept"] { background: #213955; color: #bed7ff; border-color: #496b95; }
:host([data-theme="dark"]) #ai-show-all { background: #213955; color: #bed7ff; border-color: #496b95; }
:host([data-theme="dark"]) .ai-run-details summary { background: transparent; }
:host([data-theme="dark"]) #ai-review-glow { box-shadow: inset 0 0 0 1px #82aaff66, inset 0 0 20px 3px #397bfa70, inset 0 0 56px 9px #579bff2e; }
:host([data-theme="dark"]) * { scrollbar-color: #455b73 transparent; }
:host([data-theme="dark"]) *::-webkit-scrollbar-thumb { background-color: #455b73; }
:host([data-theme="dark"]) *::-webkit-scrollbar-thumb:hover { background-color: #647e9d; }
:host([data-theme="dark"]) :is(.df-select, .df-severity, .df-select-menu) {
  --ds-bg: #1b2b3e; --ds-ink: #e8eff8; --ds-muted: #a6b6ca;
  --ds-line: #607a99; --ds-focus: #91b9ff; --ds-option: #2a4566; --ds-shadow: #00000055;
}
:host([data-theme="dark"]) .df-select-error { color: #ffaaa9; }
:host([data-theme="dark"]) .df-severity-choice[data-value="minor"]>span { background: #1a2e48; color: #aecfff; border-color: #385679; }
:host([data-theme="dark"]) .df-severity-choice[data-value="major"]>span { background: #332d22; color: #efd098; border-color: #635334; }
:host([data-theme="dark"]) .df-severity-choice[data-value="critical"]>span { background: #362630; color: #f5b1c0; border-color: #6a424f; }
:host([data-theme="dark"]) .df-severity-choice[data-value="minor"]>input:checked+span { background: #29496f; color: #d5e6ff; border-color: #8bb7ff; box-shadow: inset 0 0 0 1px #8bb7ff; }
:host([data-theme="dark"]) .df-severity-choice[data-value="major"]>input:checked+span { background: #4c3e23; color: #ffdda1; border-color: #d7ae63; box-shadow: inset 0 0 0 1px #d7ae63; }
:host([data-theme="dark"]) .df-severity-choice[data-value="critical"]>input:checked+span { background: #553344; color: #ffd0dc; border-color: #ea97b0; box-shadow: inset 0 0 0 1px #ea97b0; }
@media (forced-colors: active) {
  :host([data-theme="dark"]) { --panel: Canvas; --raised: Canvas; --text: CanvasText; --muted: CanvasText; --line: ButtonText; --accent: Highlight; }
  :host([data-theme="dark"]) :is(.df-select, .df-severity, .df-select-menu) { --ds-bg: Canvas; --ds-ink: CanvasText; --ds-muted: CanvasText; --ds-line: ButtonText; --ds-focus: Highlight; --ds-option: Highlight; }
  :host([data-theme="dark"]) .df-severity-choice>input:checked+span { outline: 2px solid Highlight; outline-offset: -3px; }
  :host([data-theme="dark"]) * { scrollbar-color: auto; }
}
`;
