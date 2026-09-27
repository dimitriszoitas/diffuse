// Exercise real pointer geometry in an isolated browser. No user profile or network.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({headless:true, args:['--use-mock-keychain', '--password-store=basic']});
let count = 0;
const pass = label => { count++; console.log(`PASS ${label}`); };
const near = (actual, expected, label = 'Coordinate') => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} should be within 2px of ${expected}`);

try {
  const page = await browser.newPage({viewport:{width:1280, height:900}});
  await page.setContent(`<!doctype html><title>Movable comment fixture</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:2000px;background:#eef3f8;font:16px system-ui}
    main{margin:120px 10%;width:80%}#target{display:block;width:100%;height:150px;padding:24px;border:1px solid #bac9da;background:white;text-align:left;font:inherit}
    #nested{height:290px;width:460px;overflow:auto;margin-top:50px;border:2px solid #bac9da}
    #rows{padding:20px}.row{height:100px;margin-bottom:20px;padding:20px;background:white;border:1px solid #bac9da}
    @media(max-width:1050px){main{margin-left:5%;width:90%}#target{height:180px}}
  </style><main><button id="target">The comment must keep referring to this button.</button>
  <div id="nested"><div id="rows"><div class="row" id="row1">First row</div><div class="row" id="row2">Second row</div><div class="row" id="row3">Third row</div><div class="row" id="row4">Fourth row</div><div class="row" id="row5">Fifth row</div></div></div></main>`);
  await page.evaluate(() => {
    window.hostClicks = 0;
    document.addEventListener('click', event => { if (!event.composedPath().some(node => node.tagName === 'DIFFUSE-LIVE-OVERLAY')) window.hostClicks++; });
    document.getElementById('target').addEventListener('click', () => window.targetActivations = (window.targetActivations || 0) + 1);
    window.pinWrites = [];
    window.chrome = {runtime:{id:'fixture', onMessage:{addListener(fn){window.receiver = fn;}}, async sendMessage(message){
      if (message.type !== 'UPDATE_COMMENT_PIN') return {ok:true};
      window.pinWrites.push(structuredClone(message));
      if (window.holdPinSave) await new Promise(resolve => { window.releasePinSave = resolve; });
      if (window.failNextPinSave) { window.failNextPinSave = false; return {ok:false, error:'Fixture could not save the pin position.'}; }
      const comment = window.storedSession.comments.find(comment => comment.id === message.commentId);
      comment.pinOffset = structuredClone(message.offset);
      return {ok:true, pinOffset:structuredClone(message.offset)};
    }}};
    window.deliver = message => new Promise(resolve => window.receiver({namespace:'diffuse', sessionId:'review', ...message}, {id:'fixture'}, resolve));
  });
  for (const file of ['inspector.js', 'content.js']) await page.addScriptTag({content:await readFile(resolve(project, 'extension', file), 'utf8')});
  const capture = id => page.evaluate(id => DiffuseInspector.inspect(document.getElementById(id)), id);
  const targetSelection = await capture('target');
  const nestedSelection = await capture('row2');
  const makeComment = (id, selection) => ({id, selection, context:{production:{...selection.context, viewportProfile:{key:'desktop'}}}, fields:{comment:'Preserve the selected element and its evidence.', category:'ux-issue', severity:'minor'}, evidence:{screenshot:'fixture-evidence'}});
  const session = {id:'review', viewportPreset:'desktop', mode:'audit', status:'live', settings:{opacity:.55, reveal:50, linked:false, offsetX:0, offsetY:0}, comments:[makeComment('target-comment', targetSelection), makeComment('nested-comment', nestedSelection)]};
  await page.evaluate(session => {window.storedSession = structuredClone(session);}, session);
  await page.evaluate(session => window.deliver({type:'INITIALIZE', role:'target', session}), session);
  const overlay = page.locator('diffuse-live-overlay');
  const pin = id => overlay.locator(`.comment-pin[data-comment-id="${id}"]`);
  const position = id => pin(id).evaluate(node => ({x:parseFloat(node.style.left), y:parseFloat(node.style.top), hidden:node.hidden}));
  const targetPin = pin('target-comment');
  const bubble = overlay.locator('#saved-comment-bubble');
  const tick = () => page.waitForTimeout(160);
  const lastWrite = () => page.evaluate(() => window.pinWrites.at(-1));
  const writeCount = () => page.evaluate(() => window.pinWrites.length);
  const sessionUpdate = () => page.evaluate(() => window.deliver({type:'SESSION_UPDATE', session:structuredClone(window.storedSession)}));
  const drag = async (id, dx, dy, release = true) => {
    const start = await position(id);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, {steps:8});
    await tick();
    if (release) { await page.mouse.up(); await tick(); }
    return start;
  };

  const origin = await position('target-comment');
  await drag('target-comment', 180, 78, false);
  let moved = await position('target-comment');
  near(moved.x, origin.x + 180); near(moved.y, origin.y + 78);
  assert.equal(await targetPin.evaluate(node => node.hasPointerCapture(1)), true);
  assert.equal(await bubble.isVisible(), false);
  await sessionUpdate(); await tick();
  moved = await position('target-comment');
  near(moved.x, origin.x + 180); near(moved.y, origin.y + 78);
  await page.mouse.up(); await tick();
  let write = await lastWrite();
  assert.equal(write.sessionId, 'review'); assert.equal(write.commentId, 'target-comment');
  near(write.offset.x, 180); near(write.offset.y, 78);
  assert.equal(await bubble.isVisible(), false);
  assert.equal(await page.evaluate(() => window.targetActivations || 0), 0);
  assert.equal(await page.evaluate(() => window.hostClicks), 0);
  pass('Dragging the numbered pin captures the pointer, survives refresh, saves its offset, and never activates the page or opens the comment');

  await sessionUpdate(); await tick();
  moved = await position('target-comment'); near(moved.x, origin.x + 180); near(moved.y, origin.y + 78);
  await targetPin.click();
  assert.equal(await bubble.isVisible(), true);
  const highlight = await overlay.locator('#saved-comment-highlight').boundingBox();
  const targetBox = await page.locator('#target').boundingBox();
  near(highlight.x, targetBox.x); near(highlight.y, targetBox.y); near(highlight.width, targetBox.width);
  assert.equal(await overlay.locator('#saved-comment-text').textContent(), session.comments[0].fields.comment);
  await overlay.locator('#close-saved-comment').click();
  pass('The next ordinary click opens the original comment and highlights the original element after the relocated position reloads');

  await page.setViewportSize({width:1000, height:900}); await tick();
  let liveTarget = await page.locator('#target').boundingBox();
  moved = await position('target-comment'); near(moved.x, liveTarget.x + 12 + 180); near(moved.y, liveTarget.y + 12 + 78);
  await page.evaluate(() => scrollTo(0, 60)); await tick();
  liveTarget = await page.locator('#target').boundingBox();
  moved = await position('target-comment'); near(moved.x, liveTarget.x + 12 + 180); near(moved.y, liveTarget.y + 12 + 78);
  assert.equal(moved.hidden, false);
  await page.evaluate(() => scrollTo(0, 0)); await page.setViewportSize({width:1280, height:900}); await tick();
  pass('The relocated pin retains its chosen offset while the original element reflows and the page scrolls');

  let writesBefore = await writeCount();
  let before = await position('target-comment');
  await drag('target-comment', 60, 30, false);
  await page.keyboard.press('Escape'); await page.mouse.up(); await tick();
  moved = await position('target-comment'); near(moved.x, before.x); near(moved.y, before.y);
  assert.equal(await writeCount(), writesBefore);
  assert.equal(await bubble.isVisible(), false);
  assert.equal(await page.evaluate(() => window.hostClicks), 0, 'Releasing the pointer after Escape must not send a click to the host page');
  await drag('target-comment', -40, 35, false);
  await targetPin.dispatchEvent('pointercancel', {pointerId:1, pointerType:'mouse', bubbles:true, composed:true});
  await page.mouse.up(); await tick();
  moved = await position('target-comment'); near(moved.x, before.x); near(moved.y, before.y);
  assert.equal(await writeCount(), writesBefore);
  assert.equal(await page.evaluate(() => window.hostClicks), 0, 'Releasing a cancelled pointer must not send a click to the host page');
  pass('Escape and pointer cancellation restore the saved position without saving or opening a comment');

  await page.evaluate(() => {window.holdPinSave = true;});
  before = await drag('target-comment', 42, 26);
  await sessionUpdate(); await tick();
  moved = await position('target-comment'); near(moved.x, before.x + 42); near(moved.y, before.y + 26);
  await page.evaluate(() => {window.holdPinSave = false; window.releasePinSave();}); await tick();
  await sessionUpdate(); await tick();
  moved = await position('target-comment'); near(moved.x, before.x + 42); near(moved.y, before.y + 26);
  pass('An old session refresh cannot snap the pin back while its new position is being saved');

  await page.evaluate(() => {window.failNextPinSave = true;});
  before = await drag('target-comment', -75, 20);
  moved = await position('target-comment'); near(moved.x, before.x); near(moved.y, before.y);
  assert.match(await overlay.evaluate(node => node.shadowRoot.textContent), /could not save|unable to save|couldn.t save/i);
  pass('A failed save restores the last saved offset and explains the failure');

  await targetPin.focus();
  before = await position('target-comment');
  await page.keyboard.press('Alt+ArrowRight'); await tick();
  moved = await position('target-comment'); near(moved.x, before.x + 10); near(moved.y, before.y);
  await page.keyboard.press('Alt+Shift+ArrowDown'); await tick();
  moved = await position('target-comment'); near(moved.x, before.x + 10); near(moved.y, before.y + 1);
  assert.equal(await bubble.isVisible(), false);
  pass('Focused pins can move with Alt + arrows and make precise one-pixel moves with Shift + Alt + arrows');

  await targetPin.click();
  await drag('target-comment', 24, 18, false);
  assert.equal(await bubble.isVisible(), false, 'Open comment details must not obstruct the marker while it is being dragged');
  await page.mouse.up(); await tick();
  assert.equal(await bubble.isVisible(), true, 'Previously open details should return at the new marker position');
  pass('Dragging an open comment temporarily hides its details and restores them after the move');
  await overlay.locator('#reset-pin-position').click(); await tick();
  moved = await position('target-comment'); near(moved.x, origin.x); near(moved.y, origin.y);
  write = await lastWrite(); near(write.offset.x, 0); near(write.offset.y, 0);
  await overlay.locator('#close-saved-comment').click();
  writesBefore = await writeCount();
  before = await position('target-comment');
  await page.mouse.move(before.x, before.y); await page.mouse.down(); await page.mouse.move(before.x + 2, before.y + 1); await page.mouse.up(); await tick();
  assert.equal(await writeCount(), writesBefore);
  assert.equal(await bubble.isVisible(), true);
  await overlay.locator('#close-saved-comment').click();
  pass('Reset restores the attached position, while a small click movement still opens the comment without changing it');

  const nestedOrigin = await position('nested-comment');
  await drag('nested-comment', 500, -24);
  const nestedBox = await page.locator('#nested').boundingBox();
  moved = await position('nested-comment'); assert.equal(moved.hidden, false);
  assert.ok(moved.x > nestedBox.x + nestedBox.width, 'The moved pin should be outside its original scrolling container');
  near(moved.x, nestedOrigin.x + 500); near(moved.y, nestedOrigin.y - 24);
  await page.locator('#nested').evaluate(node => node.scrollTop = 55); await tick();
  moved = await position('nested-comment'); assert.equal(moved.hidden, false); near(moved.y, nestedOrigin.y - 24 - 55);
  await page.locator('#nested').evaluate(node => node.scrollTop = 270); await tick();
  assert.equal((await position('nested-comment')).hidden, true);
  await page.locator('#nested').evaluate(node => node.scrollTop = 55); await tick();
  assert.equal((await position('nested-comment')).hidden, false);
  pass('A pin can sit outside its element or scrolling container, follows nested scrolling, and hides when its original anchor leaves view');

  const stored = await page.evaluate(() => window.storedSession.comments);
  for (let index = 0; index < stored.length; index++) {
    assert.deepEqual(stored[index].selection, session.comments[index].selection);
    assert.deepEqual(stored[index].context, session.comments[index].context);
    assert.deepEqual(stored[index].fields, session.comments[index].fields);
    assert.deepEqual(stored[index].evidence, session.comments[index].evidence);
  }
  const writes = await page.evaluate(() => window.pinWrites);
  assert.ok(writes.every(write => !('selection' in write) && !('context' in write) && !('fields' in write) && !('evidence' in write)));
  assert.equal(await page.evaluate(() => window.hostClicks), 0);
  assert.equal(await page.evaluate(() => window.targetActivations || 0), 0);
  pass('Moving pins never replaces captured selection, context, fields, or evidence and sends no host-page clicks');

  await page.evaluate(() => window.deliver({type:'STOP'}));
  await page.evaluate(() => window.deliver({type:'INITIALIZE', role:'target', session:structuredClone(window.storedSession)}));
  await tick();
  const restoredAnchor = await page.locator('#row2').boundingBox();
  moved = await position('nested-comment');
  near(moved.x, restoredAnchor.x + 12 + 500); near(moved.y, restoredAnchor.y + 12 - 24);
  assert.equal(moved.hidden, false);
  await pin('nested-comment').click(); assert.equal(await bubble.isVisible(), true);
  pass('Starting the saved review again restores the relocated marker with the original comment still available');

  const artifacts = resolve(project, 'artifacts/pin-drag'); await mkdir(artifacts, {recursive:true});
  await page.screenshot({path:resolve(artifacts, 'relocated-pins.png')});
  console.log(`${count} pin drag browser checks passed.`);
} finally { await browser.close(); }
