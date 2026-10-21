import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/journey-panel.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

// Execute the complete shipped controller. The small DOM below models only
// nodes/events; the actual controller owns state, request ordering and rendering.
async function harness({stateReply = async () => ({ok: true, run: null}), messageReply = null, historyReply = async () => ({ok: true, runs: []})} = {}) {
  const elements = new Map(), requests = [], timers = new Map();
  let timerId = 0;
  class Events {
    listeners = new Map();
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    async emit(type, data = {}) {
      await Promise.all((this.listeners.get(type) || []).map(listener => listener({target: this, preventDefault() {}, ...data})));
    }
  }
  class Element extends Events {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
      this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this.ownText = '';
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set textContent(value) { this.ownText = String(value ?? ''); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...values) {
      for (const value of values) {
        if (value.tagName === '#FRAGMENT') { this.append(...value.children); continue; }
        value.parent = this; this.children.push(value);
      }
    }
    prepend(...values) { const previous = this.children; this.children = []; this.append(...values, ...previous); }
    before(...values) { document.body.append(...values); }
    after(...values) { document.body.append(...values); }
    replaceChildren(...values) { this.children = []; this.append(...values); }
    replaceWith(value) { const index = this.parent.children.indexOf(this); this.parent.children[index] = value; value.parent = this.parent; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelectorAll(selector) {
      const matches = element => selector.split(',').some(part => {
        part = part.trim();
        if (part.startsWith('.')) return element.className.split(' ').includes(part.slice(1));
        if (part.startsWith('[data-step=')) return element.dataset.step === part.match(/"([^"]+)"/)?.[1];
        if (part === 'details[open]') return element.tagName === 'DETAILS' && element.open;
        return element.tagName === part.toUpperCase();
      });
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    pause() {}
    load() {}
    play() { return Promise.resolve(); }
    reportValidity() { return true; }
    reset() { for (const field of this.querySelectorAll('textarea,select')) field.value = ''; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const document = Object.assign(new Events(), {
    hidden: false, body: new Element('body'), activeElement: null,
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'),
  });
  for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1]); element.id = match[3]; element.hidden = /\bhidden\b/.test(match[2]); document.body.append(element);
  }
  const window = new Events();
  const session = {id: 'session', reviewId: 'review', target: {url: 'https://example.test/'}};
  const chrome = {
    windows: {getCurrent: async () => ({id: 1})},
    runtime: {sendMessage: async message => {
      requests.push(structuredClone(message));
      if (message.type === 'PANEL_STATE') return {ok: true, session, state: {}};
      if (message.type === 'GET_AI_CONFIG') return {ok: true, config: {hasKey: true}};
      if (message.type === 'JOURNEY_HISTORY') return historyReply(message);
      if (message.type === 'JOURNEY_STATE') return stateReply(message);
      if (messageReply) return messageReply(message);
      throw new Error(`Unexpected request: ${message.type}`);
    }},
  };
  const context = vm.createContext({document, window, chrome, URL, console,
    matchMedia: () => ({matches: true}),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context, {filename: 'journey-panel.js'});
  await tick();
  const flushRefresh = async () => {
    for (let turns = 0; turns < 10; turns++) {
      const entry = [...timers].find(([, timer]) => timer.delay <= 700);
      if (!entry) { await tick(); if (![...timers.values()].some(timer => timer.delay <= 700)) return; continue; }
      timers.delete(entry[0]); entry[1].callback(); await tick();
    }
    throw new Error('Controller kept scheduling refreshes unexpectedly');
  };
  return {
    elements, requests, session, document,
    async open() { await elements.get('panel-journey').emit('click'); await flushRefresh(); },
    async refresh() { await window.emit('diffuse-panel-state', {detail: {session, state: {}}}); await flushRefresh(); },
    async changeSession(next) { await window.emit('diffuse-panel-state', {detail: {session: next, state: {}}}); await flushRefresh(); },
    flushRefresh,
  };
}

function assertCleanSetup(h) {
  assert.equal(h.elements.get('journey-error').hidden, true, h.elements.get('journey-error').textContent);
  assert.equal(h.elements.get('journey-error').textContent, '');
  assert.equal(h.elements.get('journey-form').hidden, false);
  assert.equal(h.elements.get('journey-start').disabled, false);
}

test('the real journey controller opens and repeatedly refreshes with no saved run and no error banner', async () => {
  const h = await harness();
  await h.open();
  assertCleanSetup(h);
  await h.refresh();
  await h.refresh();
  assertCleanSetup(h);
  assert.equal(h.requests.filter(message => message.type === 'JOURNEY_STATE').length, 3);
  assert.equal(h.requests.some(message => message.type === 'JOURNEY_START'), false, 'Opening the empty form must not run a task');
});

test('empty-state refresh tolerates omitted run and unchanged responses without dereferencing a missing timestamp', async () => {
  const replies = [{ok: true}, {ok: true, unchanged: true}, {ok: true, run: null}];
  const h = await harness({stateReply: async () => replies.shift()});
  await h.open(); await h.refresh(); await h.refresh();
  assertCleanSetup(h);
  assert.equal(replies.length, 0);
});

test('a delayed empty-state response from an ended session cannot replace the next review or show an error', async () => {
  const gate = deferred();
  const h = await harness({stateReply: async message => message.sessionId === 'session' ? gate.promise : {ok: true, run: null}});
  await h.open();
  await h.changeSession(null);
  const next = {...h.session, id: 'replacement'};
  await h.changeSession(next);
  gate.resolve({ok: true, run: null});
  await tick(); await h.flushRefresh();
  await h.open();
  assertCleanSetup(h);
  assert.equal(h.requests.filter(message => message.type === 'JOURNEY_STATE').at(-1).sessionId, next.id);
});

const savedRun = () => ({id: 'saved-run', status: 'blocked', goal: 'Import four recipes', createdAt: '2026-10-21T09:00:00Z', updatedAt: '2026-10-21T09:01:00Z', startUrl: 'https://example.test/project', metrics: {actions: 1}, steps: [{index: 1, action: {type: 'click', targetId: 'recipes'}, reason: 'Open the recipe picker', observation: {url: 'https://example.test/project', title: 'Recipes', controls: []}}], followUps: []});

test('Ask AI opens a conversation, renders the outgoing message immediately, and keeps follow-up context', async () => {
  let record = savedRun(); const gate = deferred();
  const h = await harness({stateReply: async () => ({ok: true, run: record}), messageReply: async message => {
    assert.equal(message.type, 'JOURNEY_ASK');
    await gate.promise;
    record = {...record, followUps: [...record.followUps, {question: message.question, answer: 'The saved picker had a scrollable list.', evidenceSteps: [1]}]};
    return {ok: true, run: record};
  }});
  await h.open(); await h.open();
  await h.elements.get('journey-chat-open').emit('click');
  assert.equal(h.document.body.dataset.journeyChat, 'open');
  assert.equal(h.elements.get('journey-discussion').hidden, false);
  h.elements.get('journey-question').value = 'Why did you stop?';
  const sending = h.elements.get('journey-question-form').emit('submit');
  await tick();
  assert.match(h.elements.get('journey-conversation').textContent, /Why did you stop/);
  assert.match(h.elements.get('journey-conversation').textContent, /reading the journey/);
  assert.equal(h.elements.get('journey-question').value, '');
  assert.equal(h.elements.get('journey-ask').disabled, true);
  gate.resolve(); await sending;
  assert.match(h.elements.get('journey-conversation').textContent, /saved picker/);
  assert.equal(h.elements.get('journey-ask').textContent, 'Send');
  h.elements.get('journey-question').value = 'Could you scroll it?';
  await h.elements.get('journey-question-form').emit('submit');
  assert.equal(h.elements.get('journey-conversation').querySelectorAll('.journey-exchange').length, 2);
  assert.deepEqual(h.requests.filter(item => item.type === 'JOURNEY_ASK').map(item => item.runId), ['saved-run', 'saved-run']);
  h.elements.get('journey-question').value = 'Draft survives going back';
  await h.elements.get('journey-chat-back').emit('click');
  assert.equal(h.document.body.dataset.journeyChat, 'closed');
  await h.elements.get('journey-chat-open').emit('click');
  assert.equal(h.elements.get('journey-question').value, 'Draft survives going back');
});

test('failed chat requests restore the exact draft and retry without duplicate saved messages', async () => {
  const record = savedRun(); let fail = true;
  const h = await harness({stateReply: async () => ({ok: true, run: record}), messageReply: async message => {
    if (fail) return {ok: false, error: 'Connection interrupted'};
    return {ok: true, run: {...record, followUps: [{question: message.question, answer: 'Try the list scrollbar.', evidenceSteps: []}]}};
  }});
  await h.open(); await h.open(); await h.elements.get('journey-chat-open').emit('click');
  h.elements.get('journey-question').value = 'Should you have searched first?';
  await h.elements.get('journey-question-form').emit('submit');
  assert.equal(h.elements.get('journey-question').value, 'Should you have searched first?');
  assert.equal(h.elements.get('journey-question-error').hidden, false);
  assert.equal(h.elements.get('journey-conversation').querySelectorAll('.journey-pending-exchange').length, 0);
  fail = false; await h.elements.get('journey-question-form').emit('submit');
  assert.equal(h.elements.get('journey-question-error').hidden, true);
  assert.equal(h.elements.get('journey-conversation').querySelectorAll('.journey-exchange').length, 1);
});


test('changing reviews immediately clears the old chat while the new state is still loading', async () => {
  const gate = deferred();
  const record = {...savedRun(), followUps: [{question: 'Old review question', answer: 'Old review evidence', evidenceSteps: []}]};
  const h = await harness({stateReply: async message => message.sessionId === 'session' ? {ok: true, run: record} : gate.promise});
  await h.open(); await h.open(); await h.elements.get('journey-chat-open').emit('click');
  assert.match(h.elements.get('journey-conversation').textContent, /Old review evidence/);
  h.elements.get('journey-question').value = 'Private draft for old review';
  await h.changeSession({...h.session, id: 'new-review'});
  assert.equal(h.document.body.dataset.journeyChat, 'closed');
  assert.equal(h.elements.get('journey-discussion').hidden, true);
  assert.equal(h.elements.get('journey-conversation').textContent, '');
  assert.equal(h.elements.get('journey-question').value, '');
  gate.resolve({ok: true, run: null}); await tick(); await h.flushRefresh();
});

test('a history request from a previous review cannot show its error in a replacement review', async () => {
  const gate = deferred(); const record = savedRun();
  const h = await harness({stateReply: async message => ({ok: true, run: message.sessionId === 'session' ? record : null}),
    historyReply: async message => ({ok: true, runs: message.sessionId === 'session' ? [record] : []}),
    messageReply: async message => {assert.equal(message.type, 'JOURNEY_LOAD'); return gate.promise;}});
  await h.open(); await h.open();
  const loading = h.elements.get('journey-history-list').children[0].emit('click');
  await tick(); await h.changeSession({...h.session, id: 'replacement-review'});
  gate.resolve({ok: false, error: 'Old review error'}); await loading;
  assert.equal(h.elements.get('journey-error').textContent, '');
  assert.equal(h.elements.get('journey-error').hidden, true);
});
