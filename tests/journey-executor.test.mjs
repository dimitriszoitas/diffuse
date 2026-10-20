import test from 'node:test';
import assert from 'node:assert/strict';
import {createJourneyExecutor, journeyOrigin, validateJourneyAction} from '../extension/journey-executor.mjs';

function fixture({owned = false} = {}) {
  const calls = [], listeners = new Set(), detachListeners = new Set();
  let url = 'https://example.test/dashboard', observation = 0, captureCount = 0, cancelled = false, active = true;
  const observationResult = () => ({
    url, title: 'Fixture', text: 'Ingredients', controls: [{id: 'control-1', role: 'button', label: 'Ingredients'}],
    context: {documentId: 'doc-1', observationId: `obs-${++observation}`, viewport: {width: 900, height: 700}, scroll: {x: 0, y: 0}},
  });
  let handler = async message => {
    if (message.type === 'OBSERVE') return {ok: true, result: observationResult()};
    if (message.type === 'EXECUTE') url = 'https://example.test/ingredients';
    return {ok: true, result: {performed: true}};
  };
  const chromeApi = {
    tabs: {
      get: async () => ({url, status: 'complete', active}),
      sendMessage: async (id, message, options) => {
        calls.push(['message', message, options]);
        if (message.namespace === 'diffuse-recording-pointer') return {ok: true};
        if (message.type === 'PREVIEW_CLICK') return {ok: true, result: {point: {x: 30, y: 40}}};
        return handler(message);
      },
      goBack: async () => { calls.push(['back']); url = 'https://example.test/dashboard'; },
    },
    scripting: {executeScript: async args => { calls.push(['inject', args]); }},
    debugger: {
      attach: async () => { calls.push(['attach']); },
      detach: async () => { calls.push(['detach']); },
      sendCommand: async (target, method, params) => { calls.push(['command', method, params]); return {frameTree: {frame: {id: 'main'}}}; },
      onEvent: {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)},
      onDetach: {addListener: fn => detachListeners.add(fn), removeListener: fn => detachListeners.delete(fn)},
    },
  };
  const executor = createJourneyExecutor({
    chromeApi, tabId: 4, startUrl: url, debuggerOwned: () => owned,
    assertPageAccess: async requested => { calls.push(['access', requested]); },
    captureScreenshot: async page => { captureCount++; calls.push(['capture', page.url]); return {dataUrl: 'data:image/png;base64,AA==', width: 900, height: 700}; },
    isCurrent: () => !cancelled,
    onDebuggerOwnership: async id => { calls.push(['owner', id]); },
    onBlocked: async reason => { calls.push(['blocked', reason]); },
  });
  return {
    executor, calls, chromeApi, captures: () => captureCount,
    setUrl: value => { url = value; }, cancel: () => { cancelled = true; },
    setActive: value => { active = value; },
    setHandler: value => { handler = value; }, observationResult,
    event: (method, params) => { for (const fn of listeners) fn({tabId: 4}, method, params); },
    listenerCount: () => listeners.size + detachListeners.size,
  };
}

test('journey scope allows only a single HTTP(S) origin without credentials', () => {
  assert.equal(journeyOrigin('https://example.test/a?x=1#b'), 'https://example.test');
  for (const value of ['file:///tmp/test', 'chrome://settings', 'javascript:void(0)', 'https://name:password@example.test', 'invalid']) {
    assert.throws(() => journeyOrigin(value), {code: 'JOURNEY_BLOCKED'});
  }
});

test('only bounded structured actions can reach the executor', () => {
  assert.deepEqual(validateJourneyAction({type: 'click', targetId: 'control-12'}), {type: 'click', targetId: 'control-12'});
  assert.deepEqual(validateJourneyAction({type: 'scroll', direction: 'down'}), {type: 'scroll', direction: 'down'});
  assert.deepEqual(validateJourneyAction({type: 'type', targetId: 'control-1', text: ''}), {type: 'type', targetId: 'control-1', text: ''});
  for (const action of [
    {type: 'evaluate', expression: 'alert(1)'}, {type: 'navigate', url: 'https://evil.test'},
    {type: 'click', targetId: '#button'}, {type: 'click', targetId: 'control-1', url: 'https://evil.test'},
    {type: 'type', targetId: 'control-1', text: 'x'.repeat(4001)}, {type: 'type', targetId: 'control-1', text: '\0'},
    {type: 'select', targetId: 'control-1', value: 'x'.repeat(501)}, {type: 'wait', seconds: 99999},
    {type: 'scroll', direction: 'anywhere'}, {type: 'click'},
  ]) assert.throws(() => validateJourneyAction(action), {code: 'JOURNEY_INVALID_ACTION'});
});

test('one observation permits one action and the next page gets fresh controls', async () => {
  const f = fixture();
  const first = await f.executor.observe();
  assert.equal(first.url, 'https://example.test/dashboard');
  assert.equal(first.screenshot.width, 900);
  const result = await f.executor.execute({type: 'click', targetId: 'control-1'}, first);
  assert.equal(result.url, 'https://example.test/ingredients');
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, first), {code: 'JOURNEY_STALE'});
  const second = await f.executor.observe();
  assert.equal(second.url, 'https://example.test/ingredients');
  assert.notEqual(second.context.observationId, first.context.observationId);
  assert.equal(f.captures(), 2);
  const injections = f.calls.filter(call => call[0] === 'inject');
  assert.ok(injections.every(([, args]) => args.world === 'ISOLATED' && args.target.frameIds[0] === 0 && args.files[0] === 'journey-page.js'));
  assert.equal(f.calls.filter(call => call[0] === 'attach').length, 1);
  await f.executor.cleanup();
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.calls.filter(call => call[0] === 'detach').length, 1);
});

test('out-of-scope navigation is stopped before reading or capturing the new page', async () => {
  const f = fixture();
  await f.executor.observe();
  const readsBefore = f.calls.filter(call => call[0] === 'message' && call[1].type === 'OBSERVE').length;
  f.setUrl('https://other.test/sign-in');
  await assert.rejects(f.executor.observe(), {code: 'JOURNEY_BLOCKED'});
  assert.equal(f.captures(), 1);
  assert.equal(f.calls.filter(call => call[0] === 'message' && call[1].type === 'OBSERVE').length, readsBefore);
  await f.executor.cleanup();
});

test('unknown, disabled, and guarded controls never reach page execution', async () => {
  const f = fixture();
  const observed = await f.executor.observe();
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-2'}, observed), {code: 'JOURNEY_STALE'});
  observed.controls[0].disabled = true;
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed), {code: 'JOURNEY_BLOCKED'});
  observed.controls[0].disabled = false;
  observed.controls[0].blockedReason = 'Payment needs a person.';
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed), /Payment/);
  assert.equal(f.calls.filter(call => call[0] === 'message' && call[1].type === 'EXECUTE').length, 0);
  await f.executor.cleanup();
});

test('back cannot leave the journey starting point and works after observed navigation', async () => {
  const f = fixture();
  const first = await f.executor.observe();
  await assert.rejects(f.executor.execute({type: 'back'}, first), {code: 'JOURNEY_BLOCKED'});
  const refreshed = await f.executor.observe();
  await f.executor.execute({type: 'click', targetId: 'control-1'}, refreshed);
  const second = await f.executor.observe();
  assert.equal((await f.executor.execute({type: 'back'}, second)).url, 'https://example.test/dashboard');
  assert.equal(f.calls.filter(call => call[0] === 'back').length, 1);
  await f.executor.cleanup();
});

test('stop prevents actions and captures immediately', async () => {
  const f = fixture();
  const observed = await f.executor.observe();
  f.cancel();
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed), {code: 'JOURNEY_CANCELLED'});
  await assert.rejects(f.executor.observe(), {code: 'JOURNEY_CANCELLED'});
  assert.equal(f.captures(), 1);
  await f.executor.cleanup();
});

test('native dialogs are declined and reported as a block, never accepted', async () => {
  const f = fixture();
  const observed = await f.executor.observe();
  f.event('Page.javascriptDialogOpening', {type: 'confirm', message: 'Proceed?'});
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed), {code: 'JOURNEY_BLOCKED'});
  const dialog = f.calls.find(call => call[1] === 'Page.handleJavaScriptDialog');
  assert.deepEqual(dialog[2], {accept: false});
  assert.equal(f.captures(), 1);
  await f.executor.cleanup();
});

test('viewport debugger is reused and never detached by the journey', async () => {
  const f = fixture({owned: true});
  await f.executor.observe();
  await f.executor.cleanup();
  assert.equal(f.calls.some(call => call[0] === 'attach' || call[0] === 'detach' || call[0] === 'owner'), false);
  assert.equal(f.listenerCount(), 0);
});

test('main-frame off-origin navigation is interrupted but embedded frames do not block the journey', async () => {
  const f = fixture();
  await f.executor.observe();
  f.event('Page.frameRequestedNavigation', {frameId: 'embedded', url: 'https://other.test/ad'});
  await f.executor.observe();
  f.event('Page.frameRequestedNavigation', {frameId: 'main', url: 'https://other.test/checkout'});
  await assert.rejects(f.executor.observe(), {code: 'JOURNEY_BLOCKED'});
  assert.equal(f.captures(), 2);
  assert.ok(f.calls.some(call => call[1] === 'Page.stopLoading'));
  await f.executor.cleanup();
});

test('a full-document navigation during click does not cause a duplicate submission', async () => {
  const f = fixture();
  const observed = await f.executor.observe();
  f.setHandler(async message => {
    if (message.type === 'EXECUTE') {
      f.setUrl('https://example.test/created');
      throw new Error('The message port closed before a response was received.');
    }
    return {ok: true, result: {}};
  });
  const result = await f.executor.execute({type: 'click', targetId: 'control-1'}, observed);
  assert.equal(result.url, 'https://example.test/created');
  assert.equal(f.calls.filter(call => call[0] === 'message' && call[1].type === 'EXECUTE').length, 1);
  await f.executor.cleanup();
});

test('a screenshot is discarded if the document changed during its capture', async () => {
  const f = fixture();
  f.setHandler(async message => message.type === 'OBSERVE'
    ? {ok: true, result: f.observationResult()}
    : message.type === 'VALIDATE' ? {ok: false, code: 'JOURNEY_STALE', error: 'Document changed'}
      : {ok: true, result: {}});
  await assert.rejects(f.executor.observe(), {code: 'JOURNEY_STALE'});
  await f.executor.cleanup();
});

test('runner may clone an observation but cannot substitute its identity', async () => {
  const f = fixture();
  const observation = structuredClone(await f.executor.observe());
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'},
    {...observation, context: {...observation.context, observationId: 'another-observation'}}), {code: 'JOURNEY_STALE'});
  assert.equal((await f.executor.execute({type: 'click', targetId: 'control-1'}, observation)).url, 'https://example.test/ingredients');
  await f.executor.cleanup();
});

test('abort after page validation prevents the pending click', async () => {
  const f = fixture(), controller = new AbortController();
  const observed = await f.executor.observe();
  f.setHandler(async message => {
    if (message.type === 'VALIDATE') controller.abort();
    return {ok: true, result: {}};
  });
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed, {signal: controller.signal}), {code: 'JOURNEY_CANCELLED'});
  assert.equal(f.calls.filter(call => call[0] === 'message' && call[1].type === 'EXECUTE').length, 0);
  await f.executor.cleanup();
});

test('already-aborted queued observations do not inject or capture', async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.executor.observe({signal: controller.signal}), {code: 'JOURNEY_CANCELLED'});
  assert.equal(f.captures(), 0);
  assert.equal(f.calls.length, 0);
  await f.executor.cleanup();
});

test('switching away while deciding stops the pending action', async () => {
  const f = fixture();
  const observed = await f.executor.observe();
  f.setActive(false);
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observed), {code: 'JOURNEY_BLOCKED'});
  assert.equal(f.calls.filter(call => call[0] === 'message' && call[1].type === 'EXECUTE').length, 0);
  await f.executor.cleanup();
});

test('browser guard notifies the runner immediately only once', async () => {
  const f = fixture();
  await f.executor.observe();
  f.event('Page.javascriptDialogOpening', {type: 'confirm'});
  f.event('Page.windowOpen', {url: 'https://example.test/another'});
  await Promise.resolve();
  assert.equal(f.calls.filter(call => call[0] === 'blocked').length, 1);
  await f.executor.cleanup();
});

test('recorded click shows a location before execution and passes that location for revalidation', async () => {
  const f = fixture();
  const observation = await f.executor.observe();
  await f.executor.execute({type: 'click', targetId: 'control-1'}, observation);
  const pulse = f.calls.findIndex(call => call[0] === 'message' && call[1].namespace === 'diffuse-recording-pointer' && call[1].type === 'PULSE');
  const executed = f.calls.findIndex(call => call[0] === 'message' && call[1].type === 'EXECUTE');
  assert.ok(pulse >= 0 && executed > pulse);
  assert.deepEqual(f.calls[executed][1].point, {x: 30, y: 40});
  await f.executor.cleanup();
});

test('cancelling during the visible click lead-in clears the marker and prevents the click', async () => {
  const f = fixture(), controller = new AbortController();
  const observation = await f.executor.observe();
  const original = f.chromeApi.tabs.sendMessage;
  f.chromeApi.tabs.sendMessage = async (...args) => {
    const result = await original(...args);
    if (args[1].type === 'PULSE') setTimeout(() => controller.abort(), 30);
    return result;
  };
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observation, {signal: controller.signal}), {code: 'JOURNEY_CANCELLED'});
  assert.equal(f.calls.some(call => call[0] === 'message' && call[1].type === 'EXECUTE'), false);
  assert.ok(f.calls.some(call => call[0] === 'message' && call[1].namespace === 'diffuse-recording-pointer' && call[1].type === 'CLEAR'));
  await f.executor.cleanup();
});

test('page changes during the click lead-in are rejected without executing', async () => {
  const f = fixture();
  const observation = await f.executor.observe();
  let validation = 0;
  f.setHandler(async message => message.type === 'VALIDATE' && ++validation > 1
    ? {ok: false, code: 'JOURNEY_STALE', error: 'The page changed during the pulse.'}
    : {ok: true, result: {}});
  await assert.rejects(f.executor.execute({type: 'click', targetId: 'control-1'}, observation), {code: 'JOURNEY_STALE'});
  assert.equal(f.calls.some(call => call[0] === 'message' && call[1].type === 'EXECUTE'), false);
  await f.executor.cleanup();
});
