import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 25;
const FONT = 'Arial';
const FONT_DIR = '/System/Library/Fonts/Supplemental';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const n = value => Number(value.toFixed(6)).toString();

/**
 * Render real screen captures, without a presentation stage or browser frame.
 *
 * `output`: MP4 filename, or a directory (writes diffuse-showcase.mp4).
 * `encoder`: path to an FFmpeg binary with libass and libx264.
 * `timeline`: an array, or {scenes, durationScale?, transition?}. Each scene has:
 *   sourcePath, sourceStart (seconds), duration (real-time source seconds),
 *   caption, zoom: [{t,z,x,y}], cursor: [{t,x,y,down?}], simulated?: boolean.
 * Camera x/y are the desired center in 1920×1080 SOURCE PIXELS, constrained
 * to the image edges. Cursor coordinates use the same space. All t values
 * are relative to the scene. Between camera keys, cubic easing is applied.
 * Missing camera values default to z=1, x=960, y=540. Explicitly include a
 * start and end key 0.65–1.2 seconds apart to create a timed push or pan.
 *
 * Optional scene fields: captionY (default 1044), captionStart, captionEnd,
 * captionFontSize (default 28), sourceWidth/sourceHeight (normally1920/1080).
 * Optional durationScale multiplies playback time, including camera/cursor
 * timing. Keep it at1 for real time; e.g. 103/rawDuration targets103seconds.
 * Set timeline.transition=0.2 for a five-frame dissolve between actual scenes.
 * It overlaps their durations and returned scene timings reflect the overlap.
 * The default0 uses exact cuts. Caption fades are120ms; no staged UI or frames.
 * Resolves after the final MP4 is complete, with its path and scene timings.
 * Importing this module never starts capture or rendering.
 */
export async function renderShowcase({output, encoder, timeline, durationScale}) {
  if (!output || !encoder) throw new TypeError('output and encoder are required');
  const inputScenes = Array.isArray(timeline) ? timeline : timeline?.scenes;
  if (!Array.isArray(inputScenes) || !inputScenes.length) throw new TypeError('timeline must contain scenes');
  const speed = durationScale ?? (Array.isArray(timeline) ? undefined : timeline.durationScale) ?? 1;
  if (!finite(speed) || speed < 0.5 || speed > 2) throw new RangeError('durationScale must be between 0.5 and 2');
  const transitionRequest = Array.isArray(timeline) ? 0 : timeline.transition ?? 0;
  if (!finite(transitionRequest) || transitionRequest < 0 || transitionRequest > 1) throw new RangeError('transition must be between0 and1 seconds');
  const scenes = inputScenes.map((scene, index) => normalizeScene(scene, index, speed));
  const transition = Math.min(Math.round(transitionRequest * FPS), ...scenes.map(scene => Math.floor(scene.frames / 2))) / FPS;
  if (transition) scenes.forEach((scene, index) => {
    // Keep different sentences from ghosting over each other during the dissolve.
    if (index) scene.captionStart = Math.max(scene.captionStart, transition);
    if (index < scenes.length - 1) scene.captionEnd = Math.min(scene.captionEnd, scene.duration - transition);
  });
  const videoPath = extname(output).toLowerCase() === '.mp4' ? resolve(output) : resolve(output, 'diffuse-showcase.mp4');
  await mkdir(dirname(videoPath), {recursive:true});
  const temporary = await mkdtemp(join(dirname(videoPath), '.showcase-render-v2-'));
  const rendered = [];
  let elapsed = 0;
  try {
    let fontDirectory = '';
    try { await access(FONT_DIR); fontDirectory = `:fontsdir='${filterPath(FONT_DIR)}'`; } catch {}
    for (const [index, scene] of scenes.entries()) {
      const stem = String(index + 1).padStart(3, '0');
      const cursorPath = join(temporary, `${stem}-cursor.ass`);
      const titlesPath = join(temporary, `${stem}-captions.ass`);
      const segmentPath = join(temporary, `${stem}.mp4`);
      const filterFile = join(temporary, `${stem}-filter.txt`);
      await writeFile(cursorPath, cursorAss(scene));
      await writeFile(titlesPath, captionAss(scene));
      const camera = cameraFilters(scene.zoom);
      const filters = [
        `setpts=(PTS-STARTPTS)*${n(speed)}`,
        `fps=${FPS}`,
        `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
        'setsar=1',
        // The pointer is attached to the source before the camera transformation.
        `ass=filename='${filterPath(cursorPath)}'${fontDirectory}`,
        // Oversampling prevents one-source-pixel crop jumps during slow pushes.
        `scale=${WIDTH * 2}:${HEIGHT * 2}:flags=lanczos`,
        `zoompan=z='${camera.z}':x='${camera.x}':y='${camera.y}':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
        `ass=filename='${filterPath(titlesPath)}'${fontDirectory}`,
        'format=yuv420p',
      ];
      await writeFile(filterFile, filters.join(','));
      console.log(`Rendering scene ${index + 1}/${scenes.length}: ${scene.duration.toFixed(2)}s — ${scene.caption || 'screen capture'}`);
      await run(encoder, [
        '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '4',
        '-ss', n(scene.sourceStart), '-t', n(scene.sourceDuration), '-i', scene.sourcePath,
        '-an', '-filter_threads', '2', '-filter_script:v', filterFile,
        '-frames:v', String(scene.frames), '-c:v', 'libx264', '-preset', 'fast',
        '-crf', '18', '-threads', '4', '-pix_fmt', 'yuv420p',
        '-r', String(FPS), '-video_track_timescale', '12800', segmentPath,
      ]);
      if (index) elapsed -= transition;
      rendered.push({path:segmentPath, start:elapsed, end:elapsed + scene.duration, duration:scene.duration, caption:scene.caption, simulated:scene.simulated});
      elapsed += scene.duration;
    }
    const finishedPath = join(temporary, 'finished.mp4');
    if (transition && rendered.length > 1) {
      const filterPathname = join(temporary, 'dissolve-filter.txt');
      const graph = rendered.map((scene, index) => `[${index}:v]setpts=PTS-STARTPTS,fps=${FPS},settb=AVTB[s${index}]`);
      let previous = 's0';
      for (let index = 1; index < rendered.length; index++) {
        const name = `fade${index}`;
        graph.push(`[${previous}][s${index}]xfade=transition=fade:duration=${n(transition)}:offset=${n(rendered[index].start)}[${name}]`);
        previous = name;
      }
      graph.push(`[${previous}]format=yuv420p[out]`);
      await writeFile(filterPathname, graph.join(';\n'));
      console.log(`Joining ${rendered.length} scenes with ${transition.toFixed(2)}s footage dissolves`);
      await run(encoder, [
        '-hide_banner', '-loglevel', 'warning', '-y',
        ...rendered.flatMap(scene => ['-threads', '1', '-i', scene.path]),
        '-filter_complex_threads', '2', '-filter_complex_script', filterPathname, '-map', '[out]',
        '-an', '-frames:v', String(Math.round(elapsed * FPS)), '-c:v', 'libx264', '-preset', 'fast',
        '-crf', '18', '-threads', '4', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', finishedPath,
      ]);
    } else {
      const listPath = join(temporary, 'concat.txt');
      await writeFile(listPath, rendered.map(scene => `file '${scene.path.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
      await run(encoder, ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-an', '-c:v', 'copy', '-movflags', '+faststart', finishedPath]);
    }
    // An interrupted or failed render leaves an existing deliverable untouched.
    await rename(finishedPath, videoPath);
    return {videoPath, duration:elapsed, transition, width:WIDTH, height:HEIGHT, fps:FPS, scenes:rendered.map(({path, ...scene}) => scene)};
  } finally {
    await rm(temporary, {recursive:true, force:true});
  }
}

function normalizeScene(scene, index, speed) {
  if (!scene || typeof scene.sourcePath !== 'string' || !finite(scene.duration) || scene.duration <= 0) {
    throw new TypeError(`Scene ${index + 1} requires sourcePath and a positive duration`);
  }
  const sourceStart = scene.sourceStart ?? 0;
  if (!finite(sourceStart) || sourceStart < 0) throw new RangeError(`Invalid sourceStart in scene ${index + 1}`);
  const frames = Math.max(1, Math.round(scene.duration * speed * FPS));
  let previous = {t:0, z:1, x:WIDTH / 2, y:HEIGHT / 2};
  const zoom = normalizeKeys(scene.zoom || []).map(key => {
    previous = {t:key.t * speed, z:key.z ?? previous.z, x:key.x ?? previous.x, y:key.y ?? previous.y};
    if (![previous.z, previous.x, previous.y].every(finite) || previous.z < 1 || previous.z > 4) {
      throw new RangeError(`Invalid camera key in scene ${index + 1}; z must be 1–4 and x/y source pixels`);
    }
    return {...previous};
  });
  if (!zoom.length) zoom.push(previous);
  if (zoom[0].t > 0) zoom.unshift({t:0, z:1, x:WIDTH / 2, y:HEIGHT / 2});
  const scaleX = WIDTH / (scene.sourceWidth || WIDTH);
  const scaleY = HEIGHT / (scene.sourceHeight || HEIGHT);
  const cursor = normalizeKeys(scene.cursor || []).map(key => {
    if (![key.x, key.y].every(finite)) throw new TypeError(`Invalid cursor coordinate in scene ${index + 1}`);
    return {...key, t:key.t * speed, x:key.x * scaleX, y:key.y * scaleY, down:Boolean(key.down)};
  });
  return {
    ...scene, sourcePath:resolve(scene.sourcePath), sourceStart, sourceDuration:scene.duration,
    duration:frames / FPS, frames, zoom, cursor, caption:String(scene.caption || '').trim(),
    captionStart:(scene.captionStart ?? 0) * speed,
    captionEnd:Math.min(frames / FPS, (scene.captionEnd ?? scene.duration) * speed),
  };
}

function normalizeKeys(keys) {
  if (!Array.isArray(keys)) throw new TypeError('Camera and cursor samples must be arrays');
  const sorted = keys.map(key => {
    if (!finite(key.t) || key.t < 0) throw new RangeError('Sample times must be nonnegative seconds');
    return {...key};
  }).sort((a, b) => a.t - b.t);
  // A last sample wins at an identical timestamp, including press/release events.
  return sorted.filter((key, index) => index === sorted.length - 1 || key.t !== sorted[index + 1].t);
}

function expression(keys, property, multiplier = 1) {
  let result = n(keys.at(-1)[property] * multiplier);
  for (let index = keys.length - 2; index >= 0; index--) {
    const left = keys[index], right = keys[index + 1];
    const a = left[property] * multiplier, b = right[property] * multiplier;
    const progress = `clip((on/${FPS}-${n(left.t)})/${n(right.t - left.t)},0,1)`;
    const easing = `(${progress})*(${progress})*(3-2*(${progress}))`;
    const interpolated = a === b ? n(a) : `${n(a)}+(${n(b - a)})*(${easing})`;
    result = `if(lt(on/${FPS},${n(right.t)}),${interpolated},${result})`;
  }
  return result;
}

function cameraFilters(keys) {
  const z = expression(keys, 'z');
  // Camera center is in original pixels. The source is oversampled2× here.
  const x = `max(0,min(iw-iw/zoom,(${expression(keys, 'x', 2)})-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,(${expression(keys, 'y', 2)})-ih/zoom/2))`;
  return {z, x, y};
}

function header() {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${WIDTH}\nPlayResY: ${HEIGHT}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,${FONT},28,&H00FFFFFF,&H00FFFFFF,&H38150F23,&H38150F23,0,0,0,0,100,100,0,0,3,12,0,2,80,80,36,1\nStyle: Badge,${FONT},19,&H00FFFFFF,&H00FFFFFF,&H60150F23,&H60150F23,0,0,0,0,100,100,0,0,3,9,0,7,30,30,28,1\nStyle: Cursor,${FONT},20,&H00FFFFFF,&H00FFFFFF,&H00180F28,&H80000000,0,0,0,0,100,100,0,0,1,1.4,1.2,7,0,0,0,1\nStyle: Click,${FONT},20,&H90859BFF,&H90859BFF,&H50859BFF,&HFF000000,0,0,0,0,100,100,0,0,1,1.4,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
}

function time(value) {
  const centiseconds = Math.max(0, Math.round(value * 100));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function event(start, end, style, text, layer = 0) {
  return `Dialogue: ${layer},${time(start)},${time(end)},${style},,0,0,0,,${text}\n`;
}

function cursorAss(scene) {
  let result = header();
  if (!scene.cursor.length) return result;
  let index = 0;
  const arrow = 'm 1 1 l 1 28 8 21 14 34 19 31 13 19 25 19 1 1';
  const ring = 'm 18 0 b 28 0 36 8 36 18 36 28 28 36 18 36 8 36 0 28 0 18 0 8 8 0 18 0';
  for (let frame = 0; frame < scene.frames; frame++) {
    const t = frame / FPS;
    if (t < scene.cursor[0].t) continue;
    while (index + 1 < scene.cursor.length && scene.cursor[index + 1].t <= t) index++;
    const left = scene.cursor[index], right = scene.cursor[index + 1] || left;
    const fraction = right.t === left.t ? 0 : clamp((t - left.t) / (right.t - left.t), 0, 1);
    const x = left.x + (right.x - left.x) * fraction;
    const y = left.y + (right.y - left.y) * fraction;
    // Linear movement follows the actual sampled pointer, without simulated easing.
    if (left.down) result += event(t, (frame + 1) / FPS, 'Click', `{\\an7\\pos(${n(x - 18)},${n(y - 18)})\\p1}${ring}{\\p0}`);
    result += event(t, (frame + 1) / FPS, 'Cursor', `{\\an7\\pos(${n(x)},${n(y)})\\p1}${arrow}{\\p0}`, 1);
  }
  return result;
}

function assText(text) {
  return text.replaceAll('\\', '／').replaceAll('{', '❴').replaceAll('}', '❵').replace(/\r?\n/g, '\\N');
}

function captionAss(scene) {
  let result = header();
  if (scene.caption && scene.captionEnd > scene.captionStart) {
    // Explicit line breaks are honored; otherwise keep this a short one-line pill.
    const position = clamp(scene.captionY ?? 1044, 80, 1050);
    const size = clamp(scene.captionFontSize ?? 28, 20, 42);
    result += event(scene.captionStart, scene.captionEnd, 'Caption', `{\\an2\\pos(960,${position})\\fs${size}\\fad(120,120)}${assText(scene.caption)}`);
  }
  if (scene.simulated) {
    result += event(0, scene.duration, 'Badge', '{\\an7\\pos(32,28)}Simulated AI suggestions · Fictional demo');
  }
  return result;
}

function filterPath(path) {
  return path.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "'\\''");
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {stdio:['ignore', 'ignore', 'pipe']});
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${diagnostics}`)));
  });
}
