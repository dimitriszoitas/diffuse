import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({mediaGate} = {}) {
  let now = Date.parse('2026-10-20T12:00:00.000Z'), nextTimer = 0;
  const state = {timers: new Map(), reports: [], stoppedTracks: 0, constraints: null, options: null, recorder: null};
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const track = {getSettings: () => ({width: 1280, height: 720}), stop() { state.stoppedTracks++; }};
  const media = {active: true, getTracks: () => [track], getVideoTracks: () => [track]};
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(value, options) { this.state = 'inactive'; this.media = value; state.options = options; state.recorder = this; }
    start(timeslice) { this.state = 'recording'; state.timeslice = timeslice; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; void Promise.resolve().then(() => this.onstop?.()); }
  }
  const context = vm.createContext({
    Blob, MediaRecorder: Recorder, Date: ClockDate,
    FileReader: class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then(bytes => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
          this.onload();
        }, error => { this.error = error; this.onerror(); });
      }
    },
    navigator: {mediaDevices: {getUserMedia: async constraints => { state.constraints = constraints; if (mediaGate) await mediaGate; return media; }}},
    chrome: {runtime: {onMessage: {addListener() {}}, sendMessage: async message => { state.reports.push(structuredClone(message)); return {ok: true}; }}},
    setTimeout(fn, delay) { const id = ++nextTimer; state.timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { state.timers.delete(id); },
  });
  vm.runInContext(source + `
    currentSessionId = 'journey-session';
    globalThis.api = {
      receive,
      current() { return recording; },
      retained() { return lastRecording; },
    };
  `, context, {filename: 'offscreen.js'});
  const message = (type, fields = {}) => context.api.receive({type, sessionId: 'journey-session', recordingId: 'journey-recording', ...fields});
  return {
    state, track, context,
    message,
    async start(fields = {}) { return message('START_RECORDING', {streamId: 'trusted-tab-stream', viewport: {width: 3840, height: 2160, dpr: 1}, ...fields}); },
    advance(ms) { now += ms; },
    data(bytes = 'video-content') { state.recorder.ondataavailable({data: new Blob([bytes])}); },
    fireTimer() { const timer = [...state.timers.values()][0]; assert.ok(timer); timer.fn(); },
  };
}

test('journey recording gets a bounded ten-minute budget without changing ordinary or PR proof limits', async () => {
  for (const [fields, delay, bitrate, width, kind] of [
    [{journey: true}, 600000, 600000, 1920, 'journey-recording'],
    [{proof: true}, 29000, 300000, 1920, 'pr-proof'],
    [{}, 30000, 3000000, 3840, 'comparison-recording'],
  ]) {
    const h = harness();
    await h.start(fields);
    assert.equal([...h.state.timers.values()][0].delay, delay);
    assert.equal(h.state.options.videoBitsPerSecond, bitrate);
    assert.equal(h.state.constraints.video.mandatory.maxWidth, width);
    assert.equal(h.state.constraints.audio, false);
    assert.equal(h.state.timeslice, 500);
    h.data(); h.advance(2500);
    const result = await h.message('STOP_RECORDING');
    assert.equal(result.video.kind, kind);
    assert.equal(result.video.durationMs, 2500);
    assert.equal(result.video.width, 1280, 'Store actual captured track dimensions.');
    assert.equal(h.state.stoppedTracks, 1);
    assert.equal(h.state.timers.size, 0);
    assert.equal(h.state.reports.length, 0, 'Manual stop returns evidence rather than opening a comment automatically.');
  }
});

test('pause and resume preserve one recording and exclude paused time from its duration', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data(); h.advance(2000);
  assert.equal((await h.message('PAUSE_JOURNEY_RECORDING')).paused, true);
  assert.equal(h.state.recorder.state, 'paused');
  h.advance(10000);
  await h.message('PAUSE_JOURNEY_RECORDING'); // Repeated pause must not reset the original timestamp.
  assert.equal((await h.message('RESUME_JOURNEY_RECORDING')).paused, false);
  h.advance(3000);
  await h.message('RESUME_JOURNEY_RECORDING'); // Repeated resume must not add time twice.
  const result = await h.message('STOP_RECORDING');
  assert.equal(result.video.durationMs, 5000);
  assert.equal(Date.parse(result.video.stoppedAt) - Date.parse(result.video.startedAt), 15000);
  assert.match(result.video.filename, /^diffuse-journey-/);
  assert.equal(h.state.stoppedTracks, 1);
});

test('stopping while paused excludes the final paused interval', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data(); h.advance(4000);
  await h.message('PAUSE_JOURNEY_RECORDING');
  h.advance(12000);
  const result = await h.message('STOP_RECORDING');
  assert.equal(result.video.durationMs, 4000);
  assert.equal(result.video.stopReason, 'manual');
});

test('automatic time-limit sends one lightweight journey event and retains the movie for explicit retrieval', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data(); h.advance(600000);
  const finished = h.context.api.current().finished;
  h.fireTimer();
  const video = await finished;
  await tick();
  assert.equal(video.durationMs, 600000);
  assert.equal(video.stopReason, 'time-limit');
  assert.equal(h.state.reports.length, 1);
  assert.equal(h.state.reports[0].type, 'JOURNEY_CAPTURE_ENDED');
  assert.equal(h.state.reports[0].recordingId, 'journey-recording');
  assert.equal(h.state.reports[0].reason, 'time-limit');
  assert.equal(h.state.reports[0].video, undefined, 'Avoid sending a large movie twice through the event channel.');
  const result = await h.message('STOP_RECORDING');
  assert.equal(result.video.dataUrl, video.dataUrl);
  assert.equal(h.context.api.current(), null);
  assert.equal(h.state.stoppedTracks, 1);
});

test('browser capture ending preserves completed bytes and does not produce a normal comment recording event', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data(); h.advance(2000);
  const finished = h.context.api.current().finished;
  h.track.onended();
  const video = await finished;
  await tick();
  assert.equal(video.stopReason, 'capture-ended');
  assert.equal(h.state.reports[0].type, 'JOURNEY_CAPTURE_ENDED');
  assert.equal(h.state.reports[0].reason, 'capture-ended');
  assert.equal((await h.message('STOP_RECORDING')).video.dataUrl, video.dataUrl);
});

test('pause controls reject wrong sessions, recording IDs and ordinary captures', async () => {
  for (const fields of [{journey: true}, {}]) {
    const h = harness();
    await h.start(fields);
    await assert.rejects(h.message('PAUSE_JOURNEY_RECORDING', {sessionId: 'other-session'}), /no longer active/);
    await assert.rejects(h.message('RESUME_JOURNEY_RECORDING', {recordingId: 'other-recording'}), /no longer active/);
    if (!fields.journey) await assert.rejects(h.message('PAUSE_JOURNEY_RECORDING'), /no longer active/);
    h.data(); await h.message('STOP_RECORDING');
  }
});

test('discarding a journey stops media and removes retained bytes', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data();
  const finished = h.context.api.current().finished;
  await h.message('DISCARD_RECORDING');
  assert.equal(await finished, null);
  assert.equal(h.context.api.retained(), null);
  assert.equal(h.context.api.current(), null);
  assert.ok(h.state.stoppedTracks >= 1);
});

test('capture errors release tracks and report a journey interruption', async () => {
  const h = harness();
  await h.start({journey: true});
  const finished = h.context.api.current().finished;
  h.state.recorder.onerror({error: new Error('Encoder stopped')});
  await assert.rejects(finished, /Encoder stopped/);
  await tick();
  assert.equal(h.state.stoppedTracks, 1);
  assert.equal(h.state.timers.size, 0);
  assert.equal(h.context.api.current(), null);
  assert.equal(h.state.reports[0].type, 'JOURNEY_CAPTURE_ENDED');
  assert.equal(h.state.reports[0].reason, 'capture-error');
});

test('a delayed final chunk cannot retain a movie above the strict twenty MiB limit', async () => {
  const h = harness();
  await h.start({journey: true});
  const finished = h.context.api.current().finished;
  h.data(new Uint8Array(21 * 1024 * 1024));
  await assert.rejects(finished, /size limit/);
  await tick();
  assert.equal(h.context.api.retained(), null);
  assert.equal(h.state.stoppedTracks, 1);
  assert.equal(h.state.reports[0].type, 'JOURNEY_CAPTURE_ENDED');
  assert.equal(h.state.reports[0].reason, 'capture-error');
});

test('ending the review discards a late recorder callback instead of restoring old media', async () => {
  const h = harness();
  await h.start({journey: true});
  h.data();
  const finished = h.context.api.current().finished;
  await h.message('STOP_CAPTURE');
  assert.equal(await finished, null);
  await tick();
  assert.equal(h.context.api.retained(), null);
  assert.equal(h.context.api.current(), null);
  assert.ok(h.state.stoppedTracks >= 1);
  assert.equal(h.state.reports.length, 0);
});

test('ending the review while acquiring a tab stream stops the late stream before a recorder can start', async () => {
  let release;
  const mediaGate = new Promise(resolve => { release = resolve; });
  const h = harness({mediaGate});
  const starting = h.start({journey: true});
  await h.message('STOP_CAPTURE');
  release();
  try {
    await assert.rejects(starting, /ended|changed|cancelled|active/i);
    assert.equal(h.state.recorder, null);
    assert.ok(h.state.stoppedTracks >= 1);
    assert.equal(h.context.api.current(), null);
  } finally {
    // Keep the harness deterministic if this regression ever reappears.
    if (h.context.api.current()) await h.message('STOP_CAPTURE');
  }
});

test('restarting an audit with the same ID invalidates an earlier pending recording acquisition', async () => {
  let release;
  const mediaGate = new Promise(resolve => { release = resolve; });
  const h = harness({mediaGate});
  const starting = h.start({journey: true});
  await h.message('START_AUDIT');
  release();
  try {
    await assert.rejects(starting, /ended|changed|cancelled|active/i);
    assert.equal(h.state.recorder, null);
    assert.ok(h.state.stoppedTracks >= 1);
    assert.equal(h.context.api.current(), null);
  } finally {
    if (h.context.api.current()) await h.message('STOP_CAPTURE');
  }
});
