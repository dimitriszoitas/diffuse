import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/shortcuts.js', import.meta.url), 'utf8');
const json = value => JSON.parse(JSON.stringify(value));
function harness(extra = {}) {
  const context = vm.createContext({...extra});
  vm.runInContext(source, context);
  return context.DiffuseShortcuts;
}
const keys = harness();
const config = () => keys.getState();
const event = (code, extra = {}) => ({code, ctrlKey:false, altKey:false, shiftKey:false, metaKey:false, ...extra});

test('default comment and area keys share C; cancel remains Escape and copies cannot mutate defaults', () => {
  const value = config(); value.comment.code = 'KeyX';
  assert.equal(keys.getState().comment.code, 'KeyC');
  assert.equal(keys.defaults.area.code, 'KeyC');
  assert.equal(keys.format(keys.defaults.cancel), 'Esc');
  assert.equal(keys.getState().enabled, true);
});

test('custom bindings are normalized with only supported fields', () => {
  const value = config();
  value.comment = {...event('KeyJ', {shiftKey:true}), injected:'discarded'};
  value.area = event('KeyA', {altKey:true});
  value.cancel = event('KeyX');
  const validated = keys.validate(value);
  assert.equal(keys.format(validated.comment), 'Shift + J');
  assert.equal(keys.format(validated.area), 'Alt + A');
  assert.equal(validated.comment.injected, undefined);
  assert.deepEqual(json(keys.normalize(value)), json(validated));
  assert.deepEqual(json(keys.normalize(null)), json(keys.defaults));
});

test('unsupported, browser-reserved, and conflicting keys cannot be saved', () => {
  for (const candidate of [event('Enter'), event('KeyC',{ctrlKey:true}), event('KeyV',{metaKey:true}), event('KeyR',{ctrlKey:true,shiftKey:true}), event('F5'), event('F4',{altKey:true}), event('KeyD',{altKey:true,shiftKey:true}), event('KeyP',{altKey:true,shiftKey:true}), event('Digit1',{metaKey:true})]) {
    assert.throws(() => keys.fromEvent(candidate), /Choose|reserved/);
  }
  const duplicate = config(); duplicate.cancel = {...duplicate.comment};
  assert.throws(() => keys.validate(duplicate), /different shortcut/);
  const escape = config(); escape.comment = event('Escape');
  assert.throws(() => keys.validate(escape), /Escape is reserved/);
  assert.throws(() => keys.validate({...config(), enabled:'yes'}), /enabled/);
});

test('matching requires exact modifiers and ignores IME, AltGraph, and unrelated keys', () => {
  const binding = keys.fromEvent(event('KeyJ', {shiftKey:true}));
  assert.equal(keys.matches(event('KeyJ', {shiftKey:true}), binding), true);
  for (const candidate of [event('KeyJ'), event('KeyJ',{shiftKey:true,ctrlKey:true}), event('KeyK',{shiftKey:true}), event('KeyJ',{shiftKey:true,isComposing:true}), event('KeyJ',{shiftKey:true,keyCode:229}), event('KeyJ',{shiftKey:true,getModifierState:name=>name==='AltGraph'})]) assert.equal(keys.matches(candidate,binding),false);
  assert.throws(() => keys.fromEvent(event('KeyJ',{isComposing:true})), /Finish typing/);
});

test('shortcut preferences load, save through the worker, notify subscribers, and survive a new view', async () => {
  let stored = config(); const requests = [], storageListeners = [], messageListeners = [];
  const chrome = {runtime:{id:'test-extension',sendMessage:async message=>{
    requests.push(message);
    if(message.type==='SAVE_SHORTCUTS') stored=json(message.config);
    return {ok:true,config:stored};
  },onMessage:{addListener:fn=>messageListeners.push(fn)}},storage:{onChanged:{addListener:fn=>storageListeners.push(fn)}}};
  const first = harness({document:{},chrome});
  await first.refresh(); const changes = [];
  const unsubscribe=first.subscribe(value=>changes.push(value));
  const next=config(); next.comment=event('KeyJ');next.area=event('KeyA');next.cancel=event('KeyX');
  await first.save(next);
  assert.equal(first.getState().comment.code,'KeyJ');
  assert.equal(requests.find(item=>item.type==='SAVE_SHORTCUTS').target,'worker');
  assert.equal(changes.at(-1).area.code,'KeyA');
  const second=harness({document:{},chrome});await second.refresh();
  assert.equal(second.getState().cancel.code,'KeyX');
  const update={...next,enabled:false};
  messageListeners[0]({namespace:'diffuse',type:'SHORTCUTS_CHANGED',config:update},{id:'other-extension'},()=>{});
  assert.equal(first.getState().enabled,true);
  messageListeners[0]({namespace:'diffuse',type:'SHORTCUTS_CHANGED',config:update},{id:'test-extension'},()=>{});
  assert.equal(first.getState().enabled,false);
  storageListeners[1]({diffuseShortcuts:{newValue:update}},'local');
  assert.equal(second.getState().enabled,false);
  unsubscribe();
});

test('failed saving keeps the previous preference and surfaces the worker error', async () => {
  const chrome={runtime:{sendMessage:async message=>message.type==='SAVE_SHORTCUTS'?{ok:false,error:'Open Diffuse settings to change keyboard shortcuts.'}:{ok:true,config:config()}}};
  const view=harness({document:{},chrome});await view.refresh();
  await assert.rejects(view.save({...config(),enabled:false}),/Open Diffuse settings/);
  assert.equal(view.getState().enabled,true);
});

test('a newer storage update wins over an older pending refresh', async () => {
  let pending, listener;
  const chrome={runtime:{sendMessage:()=>new Promise(resolve=>{pending=resolve;})},storage:{onChanged:{addListener:fn=>{listener=fn;}}}};
  const view=harness({document:{},chrome});
  listener({diffuseShortcuts:{newValue:{...config(),enabled:false}}},'local');
  pending({ok:true,config:config()});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(view.getState().enabled,false);
});
