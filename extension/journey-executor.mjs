const NAMESPACE = 'diffuse-journey';
const error = (message, code = 'JOURNEY_BLOCKED') => Object.assign(new Error(message), {code});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function journeyOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw error('Open a website before testing a journey.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw error('Journey testing supports HTTP and HTTPS websites without credentials in the address.');
  }
  return url.origin;
}

export function validateJourneyAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('The next action is invalid.', 'JOURNEY_INVALID_ACTION');
  const type = input.type;
  if (!['click', 'type', 'select', 'scroll', 'back', 'wait'].includes(type)) throw error('That browser action is not supported.', 'JOURNEY_INVALID_ACTION');
  const allowed = {click: ['targetId'], type: ['targetId', 'text'], select: ['targetId', 'value'], scroll: ['targetId', 'direction'], back: [], wait: []}[type];
  if (Object.keys(input).some(key => key !== 'type' && !allowed.includes(key))) throw error('The browser action contains unsupported fields.', 'JOURNEY_INVALID_ACTION');
  const action = {type};
  if (['click', 'type', 'select'].includes(type) || input.targetId !== undefined) {
    if (typeof input.targetId !== 'string' || !/^control-[1-9]\d{0,2}$/.test(input.targetId)) throw error('Choose a visible control from the latest observation.', 'JOURNEY_INVALID_ACTION');
    action.targetId = input.targetId;
  }
  if (type === 'type') {
    if (typeof input.text !== 'string' || input.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) throw error('Text entry must contain at most 4,000 ordinary characters.', 'JOURNEY_INVALID_ACTION');
    action.text = input.text;
  }
  if (type === 'select') {
    if (typeof input.value !== 'string' || input.value.length > 500) throw error('Choose a valid option value.', 'JOURNEY_INVALID_ACTION');
    action.value = input.value;
  }
  if (type === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) throw error('Choose a valid scroll direction.', 'JOURNEY_INVALID_ACTION');
    action.direction = input.direction;
  }
  return action;
}

export function createJourneyExecutor({
  chromeApi, tabId, startUrl, assertPageAccess, captureScreenshot, isCurrent = () => true,
  debuggerOwned = () => false, onDebuggerOwnership = async () => {}, onBlocked = async () => {},
}) {
  const origin = journeyOrigin(startUrl);
  let closed = false;
  let latest = null;
  let ownsDebugger = false;
  let listening = false;
  let debuggerReady = false;
  let blocked = '';
  let mainFrameId = null;
  let operationSignal = null;
  const visited = [startUrl];
  let queue = Promise.resolve();
  const serial = (operation, signal) => {
    const next = queue.catch(() => {}).then(async () => {
      operationSignal = signal || null;
      current();
      try { return await operation(); }
      finally { operationSignal = null; }
    });
    queue = next.catch(() => {});
    return next;
  };
  const current = () => {
    if (closed || operationSignal?.aborted || !isCurrent()) throw error('This journey was stopped.', 'JOURNEY_CANCELLED');
    if (blocked) throw error(blocked);
  };
  const command = (method, params = {}) => chromeApi.debugger.sendCommand({tabId}, method, params);
  const block = reason => {
    if (blocked) return;
    blocked = reason;
    Promise.resolve().then(() => onBlocked(reason)).catch(() => {});
  };
  const onDebugEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      block('The page opened a browser dialog. It was dismissed without approval; a person needs to continue.');
      command('Page.handleJavaScriptDialog', {accept: false}).catch(() => {});
    } else if (method === 'Page.windowOpen') {
      block('The page opened another window. Continue this journey in the original tab with a person.');
    } else if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      mainFrameId = params.frame?.id || mainFrameId;
    } else if (method === 'Page.frameRequestedNavigation' && params.url && params.frameId === mainFrameId) {
      try {
        if (journeyOrigin(params.url) !== origin) {
          block('The page attempted to leave the approved website.');
          command('Page.stopLoading').catch(() => {});
        }
      } catch {
        block('The page attempted an unsupported navigation.');
        command('Page.stopLoading').catch(() => {});
      }
    }
  };
  const onDebugDetach = source => {
    if (source.tabId === tabId && !closed) {
      block('Browser control was disconnected. Start the journey again when the page is ready.');
      ownsDebugger = false;
      debuggerReady = false;
      onDebuggerOwnership(null).catch(() => {});
    }
  };
  async function ensureDebugger() {
    if (debuggerReady) return;
    current();
    if (!chromeApi.debugger?.onEvent) throw error('Reload Diffuse to enable browser control for journey testing.');
    if (!listening) {
      chromeApi.debugger.onEvent.addListener(onDebugEvent);
      chromeApi.debugger.onDetach?.addListener(onDebugDetach);
      listening = true;
    }
    if (!debuggerOwned()) {
      try { await chromeApi.debugger.attach({tabId}, '1.3'); }
      catch { throw error('Close DevTools or another browser debugger before testing a journey.'); }
      ownsDebugger = true;
      await onDebuggerOwnership(tabId);
    }
    await command('Page.enable');
    mainFrameId = (await command('Page.getFrameTree'))?.frameTree?.frame?.id || null;
    debuggerReady = true;
    current();
  }
  async function page() {
    current();
    const tab = await chromeApi.tabs.get(tabId);
    if (tab?.active === false) throw error('Return to the journey’s tab before continuing.');
    if (!tab || journeyOrigin(tab.url) !== origin) throw error('The journey left the approved website. Return to the original site to continue.');
    if (tab.pendingUrl && journeyOrigin(tab.pendingUrl) !== origin) throw error('The page is navigating outside the approved website.');
    await assertPageAccess?.(tab.url, chromeApi);
    current();
    return tab;
  }
  const send = async (type, payload = {}, timeout = 5000) => {
    let timer;
    try {
      const response = await Promise.race([
        chromeApi.tabs.sendMessage(tabId, {namespace: NAMESPACE, type, ...payload}, {frameId: 0}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(error('The page did not respond. A dialog or unsupported control may need your attention.', 'JOURNEY_TIMEOUT')), timeout); }),
      ]);
      if (!response?.ok) throw error(response?.error || 'The page did not respond to the journey.', response?.code || 'JOURNEY_ACTION_FAILED');
      return response.result;
    } finally { clearTimeout(timer); }
  };
  const pointer = (type, payload = {}) => chromeApi.tabs.sendMessage(tabId, {namespace: 'diffuse-recording-pointer', type, ...payload}, {frameId: 0});
  async function clickLeadIn(action, observation) {
    const preview = await send('PREVIEW_CLICK', {action, context: observation.context, origin});
    current();
    if (!Number.isFinite(preview?.point?.x) || !Number.isFinite(preview?.point?.y)) throw error('The click location could not be verified.', 'JOURNEY_STALE');
    const signal = operationSignal;
    const abort = () => { void pointer('CLEAR').catch(() => {}); };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      current();
      const result = await pointer('PULSE', {point: preview.point});
      if (!result?.ok) { current(); throw error('The recording pointer could not show this action.', 'JOURNEY_ACTION_FAILED'); }
      // Give the actual recording several frames of context before navigation
      // replaces the document. Revalidate below; this is never an action retry.
      await delay(160);
      current();
      await page();
      await send('VALIDATE', {context: observation.context});
      current();
      return preview.point;
    } catch (failure) {
      await pointer('CLEAR').catch(() => {});
      throw failure;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async function install() {
    await page();
    await ensureDebugger();
    await chromeApi.scripting.executeScript({target: {tabId, frameIds: [0]}, world: 'ISOLATED', files: ['journey-page.js', 'recording-pointer.js']});
  }
  async function settled() {
    const end = Date.now() + 8000;
    do {
      const tab = await page();
      if (tab.status !== 'loading') {
        try {
          await install();
          await send('SETTLE', {}, 2500);
          await page();
          return;
        } catch (failure) {
          if (['JOURNEY_BLOCKED', 'JOURNEY_CANCELLED'].includes(failure.code)) throw failure;
          // A full navigation destroys the previous isolated world. Reinject
          // once the replacement document is ready rather than replaying a click.
        }
      }
      await delay(120);
    } while (Date.now() < end);
    throw error('The page did not finish loading. The journey is paused for inspection.', 'JOURNEY_TIMEOUT');
  }
  const validateObservation = observation => {
    if (!latest || !observation?.context?.documentId || !observation.context?.observationId ||
      observation.context.documentId !== latest.context.documentId ||
      observation.context.observationId !== latest.context.observationId || observation.url !== latest.url) {
      throw error('Read the page again before acting.', 'JOURNEY_STALE');
    }
  };
  async function observe() {
    current();
    await settled();
    await pointer('CLEAR').catch(() => {});
    const observation = await send('OBSERVE');
    if (journeyOrigin(observation.url) !== origin) throw error('The observation left the approved website.');
    await page();
    current();
    const screenshot = await captureScreenshot?.(observation);
    // A navigation during capture cannot be associated with the old controls.
    await page();
    await send('VALIDATE', {context: observation.context});
    latest = {...observation, ...(screenshot ? {screenshot} : {})};
    if (visited.at(-1) !== observation.url) visited.push(observation.url);
    return latest;
  }
  async function execute(input, observation) {
    current();
    validateObservation(observation);
    const action = validateJourneyAction(input);
    await page();
    await send('VALIDATE', {context: observation.context});
    current();
    if (action.targetId) {
      const control = latest.controls.find(item => item.id === action.targetId);
      if (!control) throw error('That control is not in the latest observation.', 'JOURNEY_STALE');
      if (control.blockedReason) throw error(control.blockedReason);
      if (control.disabled) throw error('The selected control is disabled.');
    }
    let result;
    latest = null;
    current();
    if (action.type === 'back') {
      if (visited.length < 2) throw error('Going back would leave this journey’s observed history.');
      await chromeApi.tabs.goBack(tabId);
      visited.pop();
      result = {type: 'back', performed: true};
    } else {
      let point;
      try { point = action.type === 'click' ? await clickLeadIn(action, observation) : undefined; }
      catch (failure) {
        await pointer('CLEAR').catch(() => {});
        if (failure.code) throw failure;
        throw error('The page changed while preparing the click. Read the page again.', 'JOURNEY_STALE');
      }
      // A rejected/disconnected click is never retried: it may already have
      // submitted a form before the old document disappeared.
      try {
        current();
        result = await send('EXECUTE', {action, context: observation.context, origin, ...(point ? {point} : {})}, 5000);
      } catch (failure) {
        await pointer('CLEAR').catch(() => {});
        if (failure.code || !/receiving end|message port|frame|context|closed/i.test(failure.message)) throw failure;
        result = {type: action.type, performed: true, navigation: true};
      }
      if (action.type === 'wait') await delay(700);
    }
    await settled();
    current();
    const tab = await page();
    if (visited.at(-1) !== tab.url) visited.push(tab.url);
    return {...result, url: tab.url};
  }
  return {
    observe: (options = {}) => serial(observe, options.signal),
    execute: (action, observation, options = {}) => serial(() => execute(action, observation), options.signal),
    cleanup: async () => {
      closed = true;
      latest = null;
      await pointer('STOP').catch(() => {});
      await send('CLEANUP', {}, 1000).catch(() => {});
      if (listening) {
        chromeApi.debugger.onEvent.removeListener(onDebugEvent);
        chromeApi.debugger.onDetach?.removeListener(onDebugDetach);
        listening = false;
      }
      if (ownsDebugger) {
        ownsDebugger = false;
        await chromeApi.debugger.detach({tabId}).catch(() => {});
        await onDebuggerOwnership(null);
      }
    },
  };
}
