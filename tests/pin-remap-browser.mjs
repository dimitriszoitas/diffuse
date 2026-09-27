// Physical pointer/keyboard checks in an isolated fixture; no user profile or network.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({headless:true, args:['--use-mock-keychain', '--password-store=basic']});
let count = 0;
const pass = label => {count++; console.log(`PASS ${label}`);};
const near = (actual, expected, label = 'Coordinate') => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} should be within 2px of ${expected}`);

try {
  const page = await browser.newPage({viewport:{width:1280, height:900}});
  await page.setContent(`<!doctype html><title>Remap a saved comment</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:2200px;background:#eef3f8;color:#172b45;font:16px system-ui}
    main{margin:110px 10%;width:80%}#original,#replacement{display:block;width:100%;height:130px;padding:26px;border:1px solid #bac9da;background:#fff;text-align:left;font:inherit}
    #replacement{margin-top:50px;color:#235ed7;text-decoration:none}#nested{height:230px;width:460px;overflow:auto;margin-top:40px;border:2px solid #bac9da}
    #rows{padding:20px}.row{height:90px;margin-bottom:20px;padding:20px;background:#fff;border:1px solid #bac9da}
    @media(max-width:1050px){main{margin-left:5%;width:90%}#replacement{height:170px}}
  </style><main><button id="original">The originally captured component</button><a id="replacement" href="#must-not-follow">A different component to attach the comment to</a>
    <div id="nested"><div id="rows"><p class="row" id="row1">First nested component</p><p class="row" id="row2">Second nested component</p><p class="row" id="row3">Third nested component</p><p class="row" id="row4">Fourth nested component</p></div></div>
  </main>`);
  await page.evaluate(() => {
    window.messages = []; window.hostClicks = 0; window.componentClicks = 0;
    document.addEventListener('click', event => {if (!event.composedPath().some(node => node.tagName === 'DIFFUSE-LIVE-OVERLAY')) window.hostClicks++;});
    for (const id of ['original', 'replacement']) document.getElementById(id).addEventListener('click', () => {window.componentClicks++;});
    window.chrome = {runtime:{id:'fixture', onMessage:{addListener(fn){window.receiver = fn;}}, async sendMessage(message){
      window.messages.push(structuredClone(message));
      if (message.type === 'UPDATE_COMMENT_PIN') {
        const comment = window.storedSession.comments.find(comment => comment.id === message.commentId);
        comment.pinOffset = structuredClone(message.offset);
        return {ok:true, pinOffset:structuredClone(message.offset)};
      }
      if (message.type !== 'REMAP_COMMENT') return {ok:true};
      if (window.failNextRemap) {window.failNextRemap = false; return {ok:false, error:'Fixture could not save this new component.'};}
      const comment = window.storedSession.comments.find(comment => comment.id === message.commentId);
      if (message.region) {
        const {x,y,width,height} = message.region;
        comment.pinSelection = structuredClone(DiffuseInspector.region(x,y,width,height));
        delete comment.pinPoint;
      } else {
        const target = DiffuseInspector.resolveSelector(message.selector);
        if (!target) return {ok:false, error:'The replacement component no longer exists.'};
        comment.pinSelection = structuredClone(DiffuseInspector.inspect(target));
        const rect = target.getBoundingClientRect();
        comment.pinPoint = {x:(message.position.x-rect.x)/rect.width, y:(message.position.y-rect.y)/rect.height};
      }
      comment.pinOffset = {x:0, y:0};
      return {ok:true, pinSelection:structuredClone(comment.pinSelection), ...(comment.pinPoint ? {pinPoint:structuredClone(comment.pinPoint)} : {}), pinOffset:{x:0, y:0}};
    }}};
    window.deliver = message => new Promise(resolve => window.receiver({namespace:'diffuse', sessionId:'review', ...message}, {id:'fixture'}, resolve));
  });
  for (const file of ['inspector.js', 'content.js']) await page.addScriptTag({content:await readFile(resolve(project, 'extension', file), 'utf8')});
  const original = await page.evaluate(() => DiffuseInspector.inspect(document.getElementById('original')));
  const capturedComment = {id:'comment', selection:original, context:{production:{...original.context, viewportProfile:{key:'desktop'}}}, fields:{title:'A saved review finding', comment:'Preserve this text, captured context, and evidence.', category:'ux-issue', severity:'minor'}, evidence:{screenshot:'fixture-original-evidence'}, pinOffset:{x:105, y:65}};
  const session = {id:'review', viewportPreset:'desktop', mode:'audit', status:'live', settings:{opacity:.55, reveal:50, linked:false, offsetX:0, offsetY:0}, comments:[capturedComment]};
  await page.evaluate(session => {window.storedSession = structuredClone(session);}, session);
  await page.evaluate(session => window.deliver({type:'INITIALIZE', role:'target', session}), session);
  const overlay = page.locator('diffuse-live-overlay');
  const pin = overlay.locator('.comment-pin[data-comment-id="comment"]');
  const bubble = overlay.locator('#saved-comment-bubble');
  const areaAction = overlay.locator('#select-pin-area');
  const tip = overlay.locator('#picker-tip');
  const tick = () => page.waitForTimeout(160);
  const position = () => pin.evaluate(node => ({x:parseFloat(node.style.left), y:parseFloat(node.style.top), hidden:node.hidden}));
  const remaps = () => page.evaluate(() => window.messages.filter(message => message.type === 'REMAP_COMMENT'));
  const sessionUpdate = () => page.evaluate(() => window.deliver({type:'SESSION_UPDATE', session:structuredClone(window.storedSession)}));
  const currentComment = () => page.evaluate(() => structuredClone(window.storedSession.comments[0]));
  const assertAt = async (x,y) => {const point = await position(); near(point.x,x); near(point.y,y); assert.equal(point.hidden,false);};
  const dragTo = async (x,y) => {
    const start = await position();
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.mouse.move(x,y,{steps:10}); await page.mouse.up(); await tick();
  };
  const beginArea = async () => {
    if (!await bubble.isVisible()) await pin.click();
    await areaAction.click(); assert.equal(await tip.isVisible(),true);
  };
  const drawArea = async ({x,y,width,height}) => {
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+width,y+height,{steps:8}); await page.mouse.up(); await tick();
  };

  const replacement = await page.locator('#replacement').boundingBox();
  const drop = {x:replacement.x+replacement.width*.61,y:replacement.y+replacement.height*.48};
  await dragTo(drop.x,drop.y);
  let writes = await remaps();
  assert.equal(writes.length,1); assert.equal(writes[0].commentId,'comment'); assert.equal(writes[0].sessionId,'review'); assert.equal(writes[0].selector,'#replacement');
  near(writes[0].position.x,drop.x); near(writes[0].position.y,drop.y);
  await assertAt(drop.x,drop.y);
  assert.equal(await page.evaluate(() => location.hash),'');
  assert.equal(await page.evaluate(() => window.componentClicks),0);
  assert.equal(await page.evaluate(() => window.hostClicks),0);
  assert.deepEqual((await currentComment()).pinOffset,{x:0,y:0});
  assert.equal(await overlay.locator('#comment-pin-connections g').evaluate(node => getComputedStyle(node).display),'none');
  assert.equal(await bubble.isVisible(),false);
  pass('Dragging directly onto a different component attaches there at the exact drop point, clears its previous offset, and shows no old connector');

  await pin.click();
  const highlighted = await overlay.locator('#saved-comment-highlight').boundingBox();
  near(highlighted.x,replacement.x); near(highlighted.y,replacement.y); near(highlighted.width,replacement.width);
  assert.equal(await overlay.locator('#saved-comment-text').textContent(),capturedComment.fields.comment);
  const saved = await currentComment();
  for (const key of ['selection','context','fields','evidence']) assert.deepEqual(saved[key],capturedComment[key]);
  assert.equal(saved.pinSelection.selector,'#replacement'); assert.ok(Math.abs(saved.pinPoint.x-.61)<.01); assert.ok(Math.abs(saved.pinPoint.y-.48)<.01);
  await overlay.locator('#close-saved-comment').click();
  pass('The existing finding now highlights its new component while retaining its original capture, context, and text');

  await page.setViewportSize({width:1000,height:900}); await tick();
  let live = await page.locator('#replacement').boundingBox();
  await assertAt(live.x+live.width*saved.pinPoint.x,live.y+live.height*saved.pinPoint.y);
  await page.evaluate(() => scrollTo(0,80)); await tick();
  live = await page.locator('#replacement').boundingBox();
  await assertAt(live.x+live.width*saved.pinPoint.x,live.y+live.height*saved.pinPoint.y);
  await sessionUpdate(); await tick();
  await assertAt(live.x+live.width*saved.pinPoint.x,live.y+live.height*saved.pinPoint.y);
  await page.evaluate(() => window.deliver({type:'STOP'}));
  await page.evaluate(() => window.deliver({type:'INITIALIZE',role:'target',session:structuredClone(window.storedSession)}));
  await tick(); await assertAt(live.x+live.width*saved.pinPoint.x,live.y+live.height*saved.pinPoint.y);
  await page.evaluate(() => scrollTo(0,0)); await page.setViewportSize({width:1280,height:900}); await tick();
  pass('The drop point follows the new component proportionally through resize, scrolling, session updates, and restarting the review');

  await dragTo(1180,805);
  const empty = await currentComment();
  assert.ok(empty.pinSelection,'Empty page placement still has a persisted mapping');
  await assertAt(1180,805);
  await sessionUpdate(); await tick(); await assertAt(1180,805);
  pass('Dragging onto empty page space keeps the chosen position and persists it');

  await beginArea();
  const requestedArea = {x:350,y:330,width:280,height:96};
  const beforeAreaCount = (await remaps()).length;
  await drawArea(requestedArea);
  writes = await remaps();
  assert.equal(writes.length,beforeAreaCount+1); assert.equal(writes.at(-1).commentId,'comment');
  for (const key of ['x','y','width','height']) near(writes.at(-1).region[key],requestedArea[key],key);
  const area = await currentComment();
  assert.equal(area.pinSelection.kind,'region'); assert.equal(area.pinPoint,undefined);
  assert.deepEqual(area.pinOffset,{x:0,y:0});
  assert.equal(await tip.isVisible(),false);
  await assertAt(requestedArea.x+12,requestedArea.y+12);
  if (!await bubble.isVisible()) await pin.click();
  const highlight = await overlay.locator('#saved-comment-highlight').boundingBox();
  for (const key of ['x','y','width','height']) near(highlight[key],requestedArea[key],key);
  for (const key of ['selection','context','fields','evidence']) assert.deepEqual(area[key],capturedComment[key]);
  pass('Select area replaces the same comment attachment with the drawn rectangle, without recapturing its original evidence');

  const beforeCancel = await currentComment();
  const writesBeforeCancel = (await remaps()).length;
  await beginArea();
  await page.mouse.move(650,350); await page.mouse.down(); await page.mouse.move(900,450,{steps:6});
  await page.keyboard.press('Escape'); await page.mouse.up(); await tick();
  assert.equal(await tip.isVisible(),false); assert.equal((await remaps()).length,writesBeforeCancel);
  assert.deepEqual(await currentComment(),beforeCancel);
  await beginArea(); await overlay.locator('#cancel-picker').click(); await tick();
  assert.equal(await tip.isVisible(),false); assert.equal((await remaps()).length,writesBeforeCancel);
  assert.deepEqual(await currentComment(),beforeCancel);
  await beginArea(); await drawArea({x:600,y:400,width:2,height:2});
  assert.equal((await remaps()).length,writesBeforeCancel); assert.deepEqual(await currentComment(),beforeCancel);
  if (await tip.isVisible()) {await page.keyboard.press('Escape'); await tick();}
  pass('Escape, Cancel, and too-small rectangles never commit a new area or change the previous attachment');

  await page.evaluate(() => {window.failNextRemap=true;});
  await beginArea(); await drawArea({x:650,y:340,width:160,height:80});
  assert.deepEqual(await currentComment(),beforeCancel);
  assert.match(await overlay.evaluate(node => node.shadowRoot.textContent),/could not|unable|couldn.t/i);
  pass('A failed area save leaves the original mapping available and reports the failure');

  const messages = await page.evaluate(() => window.messages);
  assert.equal(messages.filter(message => /CAPTURE_COMMENT|SAVE_COMMENT|CREATE_COMMENT/.test(message.type)).length,0);
  assert.equal(await page.evaluate(() => window.storedSession.comments.length),1);
  const final = await currentComment();
  for (const key of ['selection','context','fields','evidence']) assert.deepEqual(final[key],capturedComment[key]);
  assert.equal(await page.evaluate(() => window.hostClicks),0);
  assert.equal(await page.evaluate(() => window.componentClicks),0);
  pass('Neither direct dragging nor area remapping creates extra comments or activates the underlying page');
  if (!await bubble.isVisible()) await pin.click();
  const artifacts = resolve(project,'artifacts/pin-remap'); await mkdir(artifacts,{recursive:true});
  await page.screenshot({path:resolve(artifacts,'remapped-comment.png')});
  console.log(`${count} pin remap browser checks passed.`);
} finally {await browser.close();}
