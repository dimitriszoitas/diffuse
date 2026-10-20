/* Recording-only pointer feedback. No keyboard events or page data are read. */
(() => {
  const KEY = '__diffuseRecordingPointerV1';
  if (globalThis[KEY]) return;
  const namespace = 'diffuse-recording-pointer';
  let enabled = false, paused = false, suspended = false;
  let host = null, halo = null, ring = null, timer = null, animation = null;
  const clear = () => {
    clearTimeout(timer); timer = null;
    animation?.cancel(); animation = null;
    host?.remove(); host = null; halo = null; ring = null;
  };
  function create() {
    if (host?.isConnected) return;
    host = document.createElement('diffuse-recording-pointer');
    host.setAttribute('data-diffuse-ui', 'true');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;display:block!important;z-index:2147483647!important;pointer-events:none!important;contain:strict!important;isolation:isolate!important;';
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = '<style>:host,*{pointer-events:none!important;box-sizing:border-box}div{position:absolute;border-radius:50%;transform:translate(-50%,-50%)}#halo{width:38px;height:38px;background:rgba(255,210,64,.28);border:1px solid rgba(178,126,0,.28);box-shadow:0 0 0 1px rgba(255,255,255,.24)}#ring{width:42px;height:42px;border:2px solid rgba(196,140,0,.8);background:rgba(255,211,61,.18)}#ring:after{content:"";position:absolute;width:5px;height:5px;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:50%;background:rgba(163,111,0,.85)}</style><div id="halo"></div><div id="ring" hidden></div>';
    halo = shadow.getElementById('halo'); ring = shadow.getElementById('ring');
    document.documentElement.append(host);
  }
  const point = value => Number.isFinite(value?.x) && Number.isFinite(value?.y) && value.x >= 0 && value.y >= 0 && value.x <= innerWidth && value.y <= innerHeight;
  function position(element, value) { element.style.left = `${value.x}px`; element.style.top = `${value.y}px`; }
  function show(value, pulse = false) {
    if (paused || suspended || document.hidden || !point(value)) return false;
    create(); position(halo, value);
    if (pulse) {
      clearTimeout(timer); animation?.cancel(); position(ring, value); ring.hidden = false;
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      animation = ring.animate(reduced ? [{opacity: 1}, {opacity: 0}] : [
        {transform: 'translate(-50%,-50%) scale(.85)', opacity: 1},
        {transform: 'translate(-50%,-50%) scale(1.35)', opacity: .7, offset: .6},
        {transform: 'translate(-50%,-50%) scale(1.65)', opacity: 0},
      ], {duration: 650, easing: 'cubic-bezier(.2,.65,.3,1)', fill: 'forwards'});
      timer = setTimeout(() => { if (ring) ring.hidden = true; if (!enabled) clear(); }, 680);
    }
    return true;
  }
  const isPageEvent = event => event.isTrusted && !event.composedPath().some(node => node?.matches?.('[data-diffuse-ui],diffuse-live-overlay'));
  const move = event => { if (enabled && isPageEvent(event)) show({x: event.clientX, y: event.clientY}); };
  const down = event => { if (enabled && event.button === 0 && isPageEvent(event)) show({x: event.clientX, y: event.clientY}, true); };
  const visibility = () => { if (document.hidden) clear(); };
  const stop = () => {
    enabled = false; paused = true; clear();
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', stop);
    chrome.runtime.onMessage.removeListener(listener);
    delete globalThis[KEY];
  };
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    // Existing screenshot preparation hides recording feedback without taking
    // over the content script's response to these messages.
    if (message?.namespace === 'diffuse') {
      if (message.type === 'PREPARE_EVIDENCE') { suspended = true; clear(); }
      if (message.type === 'RESTORE_EVIDENCE') suspended = false;
      return;
    }
    if (message?.namespace !== namespace) return;
    if (message.type === 'START') { enabled = message.trackPointer !== false; paused = false; suspended = false; clear(); }
    else if (message.type === 'PAUSE') { paused = true; clear(); }
    else if (message.type === 'RESUME') { paused = false; }
    else if (message.type === 'CLEAR') clear();
    else if (message.type === 'PULSE') {
      if (!show(message.point, true)) { respond({ok: false, error: 'The recording pointer is paused or unavailable.'}); return; }
      // A DOM update is not yet a captured frame. Acknowledge after paint so
      // journey navigation cannot replace the document before the halo appears.
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(deadline);
        respond({ok: Boolean(host?.isConnected && !paused && !suspended && !document.hidden)});
      };
      const deadline = setTimeout(finish, 250);
      requestAnimationFrame(() => requestAnimationFrame(finish));
      return true;
    }
    else if (message.type === 'STOP') stop();
    else { respond({ok: false, error: 'Unknown recording pointer action.'}); return; }
    respond({ok: true});
  };
  globalThis[KEY] = true;
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stop);
  chrome.runtime.onMessage.addListener(listener);
})();
