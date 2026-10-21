/* The persona form stays mounted while the journey panel receives updates. */
(() => {
  'use strict';
  const form = document.getElementById('journey-form');
  if (!form || window.diffuseJourneyPersona) return;
  const defaults = Object.freeze({description: 'First-time user', technicalConfidence: 3, productFamiliarity: 1, taskFamiliarity: 3, persistence: 3});
  const traits = [
    {key: 'technicalConfidence', label: 'Technical confidence', low: 'Needs guidance', high: 'Very confident', words: ['Needs guidance', 'A little unsure', 'Comfortable', 'Confident', 'Very confident']},
    {key: 'productFamiliarity', label: 'Knows this product', low: 'First visit', high: 'Knows it well', words: ['First visit', 'Seen it before', 'Some experience', 'Regular user', 'Knows it well']},
    {key: 'taskFamiliarity', label: 'Knows this kind of task', low: 'New task', high: 'Very familiar', words: ['New task', 'Tried it before', 'Some experience', 'Often does this', 'Very familiar']},
    {key: 'persistence', label: 'Willingness to keep trying', low: 'Stops quickly', high: 'Keeps trying', words: ['Stops quickly', 'A few attempts', 'Some retries', 'Keeps exploring', 'Keeps trying']}
  ];
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const section = node('section', undefined, 'journey-persona');
  section.id = 'journey-persona';
  section.setAttribute('aria-labelledby', 'journey-persona-title');
  const label = node('label', 'Who is trying this?', 'journey-persona-heading');
  label.id = 'journey-persona-title';
  label.htmlFor = 'journey-persona-description';
  const description = node('textarea');
  description.id = 'journey-persona-description';
  description.name = 'persona-description';
  description.rows = 2;
  description.required = true;
  description.maxLength = 1500;
  description.placeholder = 'For example, a new teammate adding their first ingredient.';
  description.setAttribute('aria-describedby', 'journey-persona-help');
  const help = node('p', 'Describe their role and what they already know.', 'journey-persona-help');
  help.id = 'journey-persona-help';
  const sliders = node('div', undefined, 'journey-persona-sliders');
  const controls = new Map();
  const update = trait => {
    const {input, output} = controls.get(trait.key);
    const value = Number(input.value);
    const word = trait.words[value - 1];
    output.value = word;
    input.setAttribute('aria-valuetext', `${word}, ${value} of 5`);
    input.style.setProperty('--persona-progress', `${(value - 1) * 25}%`);
  };
  for (const trait of traits) {
    const row = node('div', undefined, 'journey-persona-trait');
    const heading = node('div', undefined, 'journey-persona-trait-heading');
    const traitLabel = node('label', trait.label);
    const id = `journey-persona-${trait.key}`;
    traitLabel.htmlFor = id;
    const output = node('output');
    output.id = `${id}-value`;
    output.htmlFor = id;
    heading.append(traitLabel, output);
    const input = node('input');
    input.id = id;
    input.name = `persona-${trait.key}`;
    input.type = 'range'; input.min = '1'; input.max = '5'; input.step = '1';
    input.setAttribute('aria-describedby', `${id}-anchors`);
    const anchors = node('div', undefined, 'journey-persona-anchors');
    anchors.id = `${id}-anchors`;
    anchors.append(node('span', trait.low), node('span', trait.high));
    row.append(heading, input, anchors);
    sliders.append(row);
    controls.set(trait.key, {input, output});
    input.addEventListener('input', () => update(trait));
    input.addEventListener('change', () => update(trait));
  }
  const note = node('p', 'AI simulation, not research with real participants.', 'journey-persona-note');
  section.append(label, description, help, sliders, note);
  const intro = form.querySelector('.journey-intro');
  if (intro) intro.after(section); else form.prepend(section);

  function read() {
    return {description: description.value.trim(), ...Object.fromEntries([...controls].map(([key, {input}]) => [key, Number(input.value)]))};
  }
  function set(persona) {
    description.value = typeof persona?.description === 'string' ? persona.description.slice(0, 1500) : defaults.description;
    for (const trait of traits) {
      const value = persona?.[trait.key];
      controls.get(trait.key).input.value = String(typeof value === 'number' && Number.isFinite(value) ? Math.min(5, Math.max(1, Math.round(value))) : defaults[trait.key]);
      update(trait);
    }
  }
  function reset() { set(defaults); }
  function setDisabled(disabled) {
    const locked = Boolean(disabled);
    description.disabled = locked;
    for (const {input} of controls.values()) input.disabled = locked;
    section.classList.toggle('is-disabled', locked);
  }
  const focusDefinitions = [
    ['completion', 'Task completion'], ['discoverability', 'Discoverability & clarity'],
    ['feedback', 'Feedback & recovery'], ['interaction', 'Interaction states'],
    ['accessibility', 'Accessibility'], ['layout', 'Layout consistency']
  ];
  const defaultFocus = ['completion', 'discoverability', 'feedback'];
  const checks = node('details', undefined, 'journey-run-options journey-focus-checks');
  checks.id = 'journey-focus-checks';
  const checksSummary = node('summary', 'What should AI check?');
  const checksCount = node('span', '', 'journey-check-count');
  checksCount.id = 'journey-check-count'; checksSummary.append(checksCount);
  const checkList = node('div', undefined, 'journey-check-list');
  const checkInputs = new Map();
  for (const [key, copy] of focusDefinitions) {
    const label = node('label', undefined, 'journey-record-moves');
    const input = node('input'); input.type = 'checkbox'; input.value = key;
    input.id = `journey-check-${key}`;
    label.append(input, node('span', copy)); checkList.append(label); checkInputs.set(key, input);
  }
  const checksHelp = node('p', 'Checks without captured evidence stay Not tested. Run duration is not a measure of human task time.', 'journey-persona-help');
  checksHelp.id = 'journey-checks-help';
  checkInputs.get('completion').setAttribute('aria-describedby', 'journey-checks-help');
  checks.append(checksSummary, checkList, checksHelp);
  function updateChecks() {
    const count = [...checkInputs.values()].filter(input => input.checked).length;
    checksCount.textContent = `${count} selected`;
    checkInputs.get('completion').setCustomValidity(count ? '' : 'Choose at least one thing for AI to check.');
  }
  for (const input of checkInputs.values()) input.addEventListener('change', updateChecks);
  checks.addEventListener('invalid', () => { checks.open = true; }, true);
  const options = node('details', undefined, 'journey-run-options');
  options.id = 'journey-exploration-options';
  options.append(node('summary', 'How should it explore?'));
  const explorationLabel = node('label', 'Exploration', 'journey-option-label');
  explorationLabel.htmlFor = 'journey-exploration';
  const exploration = node('select');
  exploration.id = 'journey-exploration';
  exploration.setAttribute('aria-describedby', 'journey-exploration-help');
  for (const [value, label] of [['balanced', 'Balanced'], ['thorough', 'Thorough']]) {
    const option = node('option', label); option.value = value; exploration.append(option);
  }
  const explorationHelp = node('p', 'Balanced follows the clearest route. Thorough checks more visible alternatives within the action limit.', 'journey-persona-help');
  explorationHelp.id = 'journey-exploration-help';
  const movesLabel = node('label', undefined, 'journey-record-moves');
  const moves = node('input');
  moves.type = 'checkbox'; moves.id = 'journey-allow-record-moves';
  moves.setAttribute('aria-describedby', 'journey-record-moves-help');
  const movesCopy = node('span', 'Allow moving test records');
  movesLabel.append(moves, movesCopy);
  const movesHelp = node('p', 'Only move the test records needed for this goal. Leave this off for tasks that should keep records in place.', 'journey-persona-help');
  movesHelp.id = 'journey-record-moves-help';
  const extraLabel = node('label', 'Additional instructions', 'journey-option-label');
  extraLabel.htmlFor = 'journey-extra-instructions';
  const extra = node('textarea');
  extra.id = 'journey-extra-instructions'; extra.rows = 3; extra.maxLength = 2000;
  extra.placeholder = 'For example, check the setup wizard before trying the main navigation.';
  options.append(explorationLabel, exploration, explorationHelp, movesLabel, movesHelp, extraLabel, extra);
  const existingOptions = form.querySelector('.journey-options');
  if (existingOptions) existingOptions.after(checks, options); else section.after(checks, options);
  function readOptions() {
    return {exploration: exploration.value === 'thorough' ? 'thorough' : 'balanced', allowRecordMoves: moves.checked, extraInstructions: extra.value.trim(), focusChecks: [...checkInputs].filter(([, input]) => input.checked).map(([key]) => key)};
  }
  function setOptions(value) {
    exploration.value = value?.exploration === 'thorough' ? 'thorough' : 'balanced';
    moves.checked = value?.allowRecordMoves === true;
    extra.value = typeof value?.extraInstructions === 'string' ? value.extraInstructions.slice(0, 2000) : '';
    const selected = Array.isArray(value?.focusChecks) ? value.focusChecks : defaultFocus;
    for (const [key, input] of checkInputs) input.checked = selected.includes(key);
    updateChecks();
  }
  function disableOptions(disabled) {
    for (const field of [exploration, moves, extra, ...checkInputs.values()]) field.disabled = Boolean(disabled);
    options.classList.toggle('is-disabled', Boolean(disabled));
    checks.classList.toggle('is-disabled', Boolean(disabled));
  }
  setOptions();
  window.diffuseJourneyOptions = Object.freeze({read: readOptions, set: setOptions, reset: () => setOptions(), setDisabled: disableOptions});
  reset();
  window.diffuseJourneyPersona = Object.freeze({read, set, reset, setDisabled});
})();
