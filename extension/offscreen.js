/* Local capture and evidence processing. No STUN server or upload. */
let stream = null;
let sourceVideo = null;
let peer = null;
let currentSessionId = null;
let connectionId = null;
let recording = null;
let lastRecording = null;
let stagedReference = null;
let displayRequest = null;

function discardReference(requestId) {
  if(displayRequest&&(!requestId||displayRequest.requestId===requestId))displayRequest.cancelled=true;
  if(!stagedReference||(requestId&&stagedReference.requestId!==requestId))return;
  clearTimeout(stagedReference.timer);
  stagedReference.media.getTracks().forEach(track=>track.stop());
  stagedReference.video.srcObject=null;stagedReference.video.remove();stagedReference=null;
}

function watchReference(media,sessionId,expectedHandle) {
  const track=media.getVideoTracks()[0];
  const end=error=>{if(stream!==media||currentSessionId!==sessionId)return;media.getTracks().forEach(item=>item.stop());report('STREAM_ENDED',{sessionId,error}).catch(()=>{});};
  track.onended=()=>end('Reference sharing ended. Use Diff to choose a reference again.');
  if(expectedHandle)track.oncapturehandlechange=()=>{if(track.getCaptureHandle?.()?.handle!==expectedHandle)end('The reference reloaded or changed its identity. Use Diff to choose it again. Your saved comments are kept.');};
}

async function chooseReference(message) {
  if(message.sessionId!==currentSessionId)throw new Error('This review is no longer active.');
  if(recording||displayRequest)throw new Error('Finish the current recording or tab selection first.');
  if(typeof message.expectedHandle!=='string'||!message.expectedHandle||typeof message.requestId!=='string')throw new Error('Choose a reference tab first.');
  discardReference();
  const request={requestId:message.requestId,sessionId:currentSessionId,cancelled:false};displayRequest=request;
  let media=null,video=null;
  try {
    const size=captureSize(message.viewport);
    media=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{displaySurface:'browser',width:{max:size.width},height:{max:size.height},frameRate:{max:30}},preferCurrentTab:false,systemAudio:'exclude',surfaceSwitching:'exclude',monitorTypeSurfaces:'exclude'});
    if(request.cancelled||currentSessionId!==request.sessionId)throw new Error('This reference selection was cancelled.');
    const track=media.getVideoTracks()[0];
    if(track.getSettings().displaySurface!=='browser'||track.getCaptureHandle?.()?.handle!==message.expectedHandle)throw new Error('The shared tab does not match your selected reference. Choose the same tab in Chrome’s sharing dialog.');
    track.contentHint='detail';
    video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=media;document.body.append(video);await video.play();
    if(request.cancelled||currentSessionId!==request.sessionId)throw new Error('This review changed before the reference was connected.');
    const candidate={requestId:message.requestId,media,video,expectedHandle:message.expectedHandle};
    candidate.timer=setTimeout(()=>discardReference(candidate.requestId),120000);stagedReference=candidate;
    return {ok:true,capture:track.getSettings()};
  } catch(error) {
    media?.getTracks().forEach(track=>track.stop());if(video){video.srcObject=null;video.remove();}
    if(error.name==='NotAllowedError'||request.cancelled)return {ok:true,cancelled:true};
    throw error;
  } finally {if(displayRequest===request)displayRequest=null;}
}

const report = (type, data = {}) => chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, sessionId: currentSessionId, ...data});

function captureSize(viewport) {
  return {width: Math.min(8192, Math.max(2, Math.round(viewport.width * viewport.dpr))), height: Math.min(8192, Math.max(2, Math.round(viewport.height * viewport.dpr)))};
}

async function reviewerImage(evidence) {
  if (!evidence?.dataUrl) return null;
  const image = await createImageBitmap(await (await fetch(evidence.dataUrl)).blob());
  try {
    const scale = Math.min(1, 1568 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return {dataUrl: canvas.toDataURL('image/jpeg', 0.86), width: canvas.width, height: canvas.height};
  } finally { image.close(); }
}

function stop() {
  discardReference();
  const old = stream;
  stream = null;
  currentSessionId = null;
  connectionId = null;
  if (peer) { peer.onconnectionstatechange = null; peer.close(); peer = null; }
  old?.getTracks().forEach(track => track.stop());
  if (sourceVideo) { sourceVideo.srcObject = null; sourceVideo.remove(); sourceVideo = null; }
  if (recording) {
    clearTimeout(recording.timer);
    recording.notify = false;
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    recording.media.getTracks().forEach(track => track.stop());
  }
  lastRecording = null;
}

async function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function sourceFrame() {
  if (!sourceVideo || !stream?.active) throw new Error('The prototype stream is unavailable. Reconnect before capturing evidence.');
  if (sourceVideo.readyState < 2 || !sourceVideo.videoWidth) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sourceVideo?.removeEventListener('loadeddata', loaded); reject(new Error('The prototype frame is not ready yet. Try again.')); }, 5000);
    const loaded = () => { clearTimeout(timer); sourceVideo.removeEventListener('loadeddata', loaded); resolve(); };
    sourceVideo.addEventListener('loadeddata', loaded);
  });
  const canvas = document.createElement('canvas');
  canvas.width = sourceVideo.videoWidth; canvas.height = sourceVideo.videoHeight;
  canvas.getContext('2d').drawImage(sourceVideo, 0, 0);
  return {dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, capturedAt: new Date().toISOString()};
}

async function annotateProduction(message) {
  if (!/^data:image\/png;base64,/.test(message.dataUrl)) throw new Error('Expected a PNG screenshot.');
  // HTMLImageElement.decode can stall in a non-rendered offscreen document.
  const image = await createImageBitmap(await (await fetch(message.dataUrl)).blob());
  try {
    const result = {dataUrl: message.dataUrl, width: image.width, height: image.height, capturedAt: message.capturedAt};
    const rect = message.selection?.rect?.viewport;
    const viewport = message.viewport;
    if (!rect || !viewport?.width || !viewport?.height) return result;
    const scaleX = image.width / viewport.width;
    const scaleY = image.height / viewport.height;
    const x = Math.max(0, rect.x * scaleX), y = Math.max(0, rect.y * scaleY);
    const right = Math.min(image.width, (rect.x + rect.width) * scaleX);
    const bottom = Math.min(image.height, (rect.y + rect.height) * scaleY);
    if (right <= x || bottom <= y) return result;
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    ctx.strokeStyle = '#e45435'; ctx.lineWidth = Math.max(2, 2 * scaleX);
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, Math.max(1, right - x - ctx.lineWidth), Math.max(1, bottom - y - ctx.lineWidth));
    result.annotatedDataUrl = canvas.toDataURL('image/png');
    const padding = 24 * Math.max(scaleX, scaleY);
    const cropX = Math.max(0, Math.floor(x - padding)), cropY = Math.max(0, Math.floor(y - padding));
    const cropRight = Math.min(canvas.width, Math.ceil(right + padding)), cropBottom = Math.min(canvas.height, Math.ceil(bottom + padding));
    const crop = document.createElement('canvas'); crop.width = cropRight - cropX; crop.height = cropBottom - cropY;
    crop.getContext('2d').drawImage(canvas, cropX, cropY, crop.width, crop.height, 0, 0, crop.width, crop.height);
    result.cropDataUrl = crop.toDataURL('image/png');
    result.crop = {x: cropX, y: cropY, width: crop.width, height: crop.height};
    return result;
  } finally { image.close(); }
}

async function startRecording(message) {
  if (recording) throw new Error('A recording is already running.');
  const size = captureSize(message.viewport);
  const media = await navigator.mediaDevices.getUserMedia({audio: false, video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, maxWidth: size.width, maxHeight: size.height, maxFrameRate: 24}}});
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) { media.getTracks().forEach(track => track.stop()); throw new Error('This browser cannot record WebM video.'); }
  const recorder = new MediaRecorder(media, {mimeType, videoBitsPerSecond: 3000000});
  const item = {id: message.recordingId, sessionId: currentSessionId, media, recorder, chunks: [], bytes: 0, startedAt: new Date().toISOString(), notify: false, reason: 'manual'};
  item.finished = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
  // Auto-stop errors are reported to the worker rather than becoming unhandled.
  item.finished.catch(() => {});
  recording = item;
  const autoStop = reason => {
    if (recording !== item || recorder.state === 'inactive') return;
    item.notify = true; item.reason = reason; recorder.stop();
  };
  recorder.ondataavailable = event => {
    if (event.data.size) { item.chunks.push(event.data); item.bytes += event.data.size; }
    if (item.bytes > 16 * 1024 * 1024) autoStop('size-limit');
  };
  recorder.onerror = event => {
    clearTimeout(item.timer); media.getTracks().forEach(track => track.stop());
    item.failed = true;
    if (recording === item) recording = null;
    const error = new Error(event.error?.message || 'The recording could not be saved.');
    item.reject(error);
    report('RECORDING_ERROR', {sessionId: item.sessionId, recordingId: item.id, error: error.message}).catch(() => {});
  };
  recorder.onstop = async () => {
    clearTimeout(item.timer); media.getTracks().forEach(track => track.stop());
    if (item.failed) return;
    try {
      const blob = new Blob(item.chunks, {type: mimeType});
      if (!blob.size) throw new Error('The recording was empty. The paired screenshots are still available.');
      const stoppedAt = new Date().toISOString();
      const video = {dataUrl: await dataURL(blob), mimeType, durationMs: Date.parse(stoppedAt) - Date.parse(item.startedAt), filename: `diffuse-${item.id.slice(0, 8)}.webm`, kind: 'comparison-recording', startedAt: item.startedAt, stoppedAt, stopReason: item.reason, bytes: blob.size};
      lastRecording = {id: item.id, video};
      if (recording === item) recording = null;
      item.resolve(video);
      if (item.notify) await report('RECORDING_FINISHED', {sessionId: item.sessionId, recordingId: item.id, video});
    } catch (error) {
      if (recording === item) recording = null;
      item.reject(error);
      report('RECORDING_ERROR', {sessionId: item.sessionId, recordingId: item.id, error: error.message}).catch(() => {});
    }
  };
  media.getVideoTracks()[0].onended = () => autoStop('capture-ended');
  recorder.start(500);
  item.timer = setTimeout(() => autoStop('time-limit'), 30000);
  return {ok: true, recording: {id: item.id, startedAt: item.startedAt}};
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

async function receive(message) {
  if(message.type==='CHOOSE_REFERENCE')return chooseReference(message);
  if(message.type==='ABORT_REFERENCE'){discardReference(message.requestId);return {ok:true};}
  if(message.type==='COMMIT_REFERENCE'){
    if(typeof message.newSessionId!=='string'||!message.newSessionId.trim())throw new Error('The destination review is unavailable. Choose the reference again.');
    if(message.sessionId!==currentSessionId||stagedReference?.requestId!==message.requestId)throw new Error('This reference selection is no longer available.');
    const candidate=stagedReference,track=candidate.media.getVideoTracks()[0];
    if(!candidate.media.active||track.getCaptureHandle?.()?.handle!==candidate.expectedHandle){discardReference(message.requestId);throw new Error('The reference changed before it could connect. Choose it again.');}
    stagedReference=null;clearTimeout(candidate.timer);stop();
    currentSessionId=message.newSessionId;stream=candidate.media;sourceVideo=candidate.video;
    watchReference(stream,currentSessionId,candidate.expectedHandle);
    return {ok:true,capture:track.getSettings()};
  }
  if (message.type === 'STOP_CAPTURE') { stop(); return {ok: true}; }
  if (message.type === 'START_AUDIT') { stop(); currentSessionId = message.sessionId; return {ok: true}; }
  if (message.type === 'CAPTURE_STATUS') return {ok: true, active: !!stream?.active, sessionId: currentSessionId, recording: recording ? {id: recording.id, startedAt: recording.startedAt} : null};
  if (message.type === 'START_CAPTURE') {
    stop();
    currentSessionId = message.sessionId;
    try {
      const size = captureSize(message.viewport);
      stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, maxWidth: size.width, maxHeight: size.height, maxFrameRate: 30}}});
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      watchReference(stream,currentSessionId);
      sourceVideo = document.createElement('video'); sourceVideo.muted = true; sourceVideo.autoplay = true; sourceVideo.playsInline = true; sourceVideo.srcObject = stream; document.body.append(sourceVideo);
      await sourceVideo.play();
      return {ok: true, capture: track.getSettings()};
    } catch (error) { stop(); throw error; }
  }
  if (message.type === 'STOP_RECORDING') {
    if (message.sessionId !== currentSessionId) throw new Error('This recording belongs to a different comparison.');
    if (!recording) {
      if (lastRecording?.id === message.recordingId) return {ok: true, video: lastRecording.video};
      throw new Error('There is no active recording.');
    }
    const item = recording;
    if (item.id !== message.recordingId) throw new Error('This recording is no longer active.');
    item.notify = false;
    if (item.recorder.state !== 'inactive') item.recorder.stop();
    return {ok: true, video: await item.finished};
  }
  if (message.sessionId !== currentSessionId) throw new Error('This audit or comparison is no longer active.');
  if (message.type === 'SNAPSHOT_EVIDENCE') {
    const prototype = message.includePrototype === false ? null : await sourceFrame();
    const production = await annotateProduction(message);
    return {ok: true, evidence: {production, ...(prototype ? {prototype, captureSkewMs: Math.abs(Date.parse(prototype.capturedAt) - Date.parse(production.capturedAt))} : {})}};
  }
  if (message.type === 'ANNOTATE_EVIDENCE') return {ok: true, production: await annotateProduction(message)};
  if (message.type === 'PREPARE_AI_IMAGES') return {ok: true, production: await reviewerImage(message.evidence.production), prototype: await reviewerImage(message.evidence.prototype)};
  if (message.type === 'START_RECORDING') return startRecording(message);
  if (!stream?.active) throw new Error('The live source is no longer available. Start a new comparison from the prototype tab.');
  if (message.type === 'RESIZE_CAPTURE') {
    const size = captureSize(message.viewport);
    await stream.getVideoTracks()[0].applyConstraints({width: {ideal: size.width, max: size.width}, height: {ideal: size.height, max: size.height}, frameRate: {ideal: 30, max: 30}});
    return {ok: true};
  }
  if (message.type === 'CONNECT_TARGET') {
    if (peer) { peer.onconnectionstatechange = null; peer.close(); }
    const pc = new RTCPeerConnection({iceServers: []});
    peer = pc;
    connectionId = message.connectionId;
    const thisConnectionId = connectionId;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onconnectionstatechange = () => {
      if (peer === pc && ['failed', 'disconnected'].includes(pc.connectionState)) report('STREAM_STATUS', {status: 'reconnecting'}).catch(() => {});
    };
    await pc.setLocalDescription(await pc.createOffer());
    for (const sender of pc.getSenders()) {
      const parameters = sender.getParameters();
      parameters.degradationPreference = 'maintain-resolution';
      for (const encoding of parameters.encodings || []) encoding.maxBitrate = 20000000;
      await sender.setParameters(parameters);
    }
    await gathered(pc);
    if (peer !== pc) return {ok: true};
    const routed = await report('RTC_OFFER', {connectionId: thisConnectionId, description: pc.localDescription.toJSON()});
    if (!routed?.ok) throw new Error(routed?.error || 'The comparison page did not accept the live connection.');
    return {ok: true};
  }
  if (message.type === 'RTC_ANSWER') {
    if (message.connectionId !== connectionId || !peer) return {ok: true};
    await peer.setRemoteDescription(message.description);
    return {ok: true};
  }
  throw new Error('Unknown capture command.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.namespace !== 'diffuse' || message.target !== 'offscreen') return;
  receive(message).then(respond, error => respond({ok: false, error: error.message}));
  return true;
});
