// Real settings -> worker -> storage -> Managed Agents HTTP, followed by the
// real journey driver and Chrome executor. Only Anthropic is a local fixture.
// No real key, provider account, inference, or externally hosted site is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-managed-browser-'));
const extension = join(temporary, 'extension');
const KEY = 'sk-ant-managed-browser-fixture-not-a-real-key';
const calls = [], agents = new Map(), sessions = new Map();
let environment, failEvaluatorOnce = true, eventSequence = 0, sessionSequence = 0;
const makeEvent = (type, extra = {}) => ({id: `sevt_smoke_${++eventSequence}`, type, processed_at: new Date(1792836000000 + eventSequence).toISOString(), ...extra});
const scores = ['discoverability', 'clarity', 'effort', 'feedback', 'recovery'].map(dimension => ({dimension, score: null, reason: 'Not assessed by this deterministic fixture.', evidenceSteps: [], confidence: 0}));
const assessment = {reason: 'The second observation shows the requested ingredient row.', action: {type: 'finish', outcome: 'completed', summary: 'Oat milk is visible in the ingredients table.', findings: [], scores}};
const errors = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = (body, status = 200) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(body)); };
  if (!url.pathname.startsWith('/v1/')) {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end('<!doctype html><html lang="en"><head><title>Ingredients fixture</title><style>body{margin:48px;font:20px system-ui;background:#f4f6f8;color:#152b42}button{padding:16px;font:inherit}table{margin-top:24px}td,th{padding:12px}</style></head><body><h1>Ingredients</h1><button id="add">Add Oat milk</button><table><thead><tr><th>Name</th><th>Unit</th></tr></thead><tbody id="items"></tbody></table><script>document.querySelector("#add").onclick=()=>{document.querySelector("#items").innerHTML="<tr><td>Oat milk</td><td>ml</td></tr>";document.querySelector("#add").disabled=true}</script></body></html>');
    return;
  }
  try {
    assert.equal(request.headers['x-api-key'], KEY, 'Only the synthetic key reaches the fixture');
    assert.equal(request.headers['anthropic-beta'], 'managed-agents-2026-04-01');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({method: request.method, path: url.pathname, query: url.searchParams, body});
    if (url.pathname === '/v1/agents' && request.method === 'POST') {
      assert.deepEqual(body.model, {id: 'claude-opus-5-5', effort: {type: 'max'}});
      assert.ok(body.tools.every(tool => tool.type === 'custom'));
      assert.deepEqual(body.mcp_servers, []);
      assert.equal(body.multiagent, null);
      const role = body.metadata.diffuse_role === 'evaluator' ? 'evaluator' : 'actor';
      if (role === 'evaluator' && failEvaluatorOnce) { failEvaluatorOnce = false; send({error: {message: 'Fixture permission failure; raw provider text must stay hidden.'}}, 403); return; }
      const agent = {...body, id: `agent_smoke_${role}`, version: 1, type: 'agent', archived_at: null};
      agents.set(agent.id, agent); send(agent); return;
    }
    if (url.pathname.startsWith('/v1/agents/') && request.method === 'GET') {
      assert.equal(url.searchParams.get('version'), '1');
      send(agents.get(url.pathname.split('/').at(-1))); return;
    }
    if (url.pathname === '/v1/environments' && request.method === 'POST') {
      assert.deepEqual(body.config.networking, {type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false});
      environment = {...body, id: 'env_smoke', type: 'environment', archived_at: null}; send(environment); return;
    }
    if (url.pathname === '/v1/environments/env_smoke') { send(environment); return; }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
      const role = body.agent.id.endsWith('_actor') ? 'actor' : 'evaluator';
      assert.equal(body.agent.version, 1); assert.equal(body.environment_id, 'env_smoke');
      assert.deepEqual(body.budget, {type: 'limit', max_list_cost: {amount: role === 'actor' ? '150' : '50', currency: 'USD'}});
      const session = {id: `sesn_smoke_${role}_${++sessionSequence}`, type: 'session', status: 'idle', role, events: []};
      sessions.set(session.id, session); send({id: session.id, type: session.type, status: session.status}); return;
    }
    const match = /^\/v1\/sessions\/(sesn_smoke_(?:actor|evaluator)_\d+)(\/events)?$/.exec(url.pathname);
    assert.ok(match, 'Only supported Managed Agents endpoints are called');
    const session = sessions.get(match[1]); assert.ok(session);
    if (!match[2]) { send({id: session.id, type: session.type, status: session.status}); return; }
    if (request.method === 'GET') {
      const types = url.searchParams.getAll('types[]');
      assert.ok(types.length && types.every(type => !type.startsWith('user.')));
      send({data: session.events.filter(event => types.includes(event.type)), next_page: null}); return;
    }
    const acknowledgements = body.events.map(event => makeEvent(event.type, event));
    session.events.push(...acknowledgements);
    const incoming = body.events.at(-1);
    assert.notEqual(incoming.type, 'user.interrupt', 'Completed handoffs remain idle without an interrupt');
    const payloads = incoming.content.filter(block => block.type === 'text').map(block => JSON.parse(block.text));
    const payload = payloads.at(-1);
    let name, input;
    if (session.role === 'actor') {
      assert.ok(incoming.content.some(block => block.type === 'image'), 'Actor receives a real browser screenshot');
      assert.match(payload.observationToken, /^[0-9a-f-]{36}$/);
      assert.notEqual(payload.observationToken, session.previousObservationToken, 'Each browser observation has a fresh proposal token');
      session.previousObservationToken = payload.observationToken;
      name = 'journey_step';
      if (payload.currentStep === 1) {
        const control = payload.observation.controls.find(control => control.label === 'Add Oat milk'); assert.ok(control);
        input = {observationStep: 1, observationToken: payload.observationToken, reason: 'The visible button names the requested ingredient.', action: {type: 'click', targetId: control.id}};
      } else {
        assert.equal(payload.currentStep, 2); assert.equal(incoming.type, 'user.custom_tool_result');
        assert.equal(payload.history[0].executionStatus, 'executed');
        assert.match(payload.observation.text, /Oat milk/);
        input = {observationStep: 2, observationToken: payload.observationToken, reason: 'The resulting row contains Oat milk and ml.', action: {type: 'finish', outcome: 'completed', summary: 'Oat milk is visible in the ingredients table.'}};
      }
    } else if (payload.request?.startsWith('Evaluate')) {
      assert.equal(payload.steps.length, 2);
      assert.ok(incoming.content.some(block => block.type === 'image'), 'Evaluator receives final screenshot');
      name = 'journey_evidence'; input = {stepIndex: 1};
    } else if (payload.request?.startsWith('Answer')) {
      if (!payload.evaluation.completed) {
        assert.equal(incoming.type, 'user.message');
        assert.equal(payload.status, 'blocked');
        assert.match(payload.stopReason.message, /Return to the journey’s tab/);
        assert.match(payload.steps[0].executionError.message, /Return to the journey’s tab/);
        name = 'journey_answer'; input = {answer: 'The next click was blocked because the reviewed tab was no longer active. Return to that tab before continuing.', evidenceSteps: [1], routeSuggestion: null};
      } else {
        assert.equal(incoming.type, 'user.custom_tool_result');
        name = 'journey_answer'; input = {answer: 'The first recorded screen exposed Add Oat milk. The second screen confirmed the saved row.', evidenceSteps: [1, 2], routeSuggestion: null};
      }
    } else {
      assert.equal(payload.index, 1);
      assert.ok(incoming.content.some(block => block.type === 'image'), 'Evidence lookup supplies the actual prior screenshot');
      name = 'journey_assessment'; input = assessment;
    }
    const tool = makeEvent('agent.custom_tool_use', {name, input});
    session.events.push(makeEvent('session.status_running'), tool, makeEvent('session.status_idle', {stop_reason: {type: 'requires_action', event_ids: [tool.id]}}));
    send({data: acknowledgements});
  } catch (error) { errors.push(error); console.error('Local fixture assertion:', error.message); send({error: {message: 'Local fixture assertion failed.'}}, 500); }
});

let context;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await cp(join(project, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.anthropic.com/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const workerPath = join(extension, 'background.js');
  // Test entry points expose the production modules without replacing any
  // settings handlers, storage, agent decisions, or browser action code.
  await writeFile(workerPath, (await readFile(workerPath, 'utf8')) + `
import * as managedSmoke from './journey-managed.mjs';
import {createJourneyRunner as smokeRunner} from './journey-runner.mjs';
globalThis.__managedSmoke = { ...managedSmoke, readAISettings, createJourneyExecutor, assertPageAccess, createJourneyRunner: smokeRunner };
`);
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: {width: 1100, height: 800},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-mock-keychain', '--password-store=basic'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(origin => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (url, init) => {
      const value = String(url);
      if (value.startsWith('https://api.anthropic.com/v1/')) return nativeFetch(origin + new URL(value).pathname + new URL(value).search, init);
      if (value.startsWith('chrome-extension:') || value.startsWith(origin + '/')) return nativeFetch(url, init);
      throw new Error('External network is disabled in the Managed Agents smoke test.');
    };
  }, origin);
  const settings = await context.newPage();
  settings.setDefaultTimeout(15000);
  await settings.goto(`chrome-extension://${extensionId}/ai-settings.html`);
  await settings.waitForFunction(() => document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  await settings.locator('#api-key').fill(KEY);
  await settings.locator('#journey-engine-managed').check();
  await settings.locator('#setup-journey-agents').click();
  await settings.waitForFunction(() => document.querySelector('#ai-feedback').dataset.error === 'true');
  assert.match(await settings.locator('#ai-feedback').innerText(), /workspace permissions|Managed Agents access/);
  assert.doesNotMatch(await settings.locator('#ai-feedback').innerText(), /Fixture permission failure/);
  assert.equal(await settings.locator('#api-key').inputValue(), '');
  let saved = await worker.evaluate(() => chrome.storage.local.get(['diffuseJourneyAgents', 'aiConfig', 'anthropicApiKey']));
  assert.equal(saved.aiConfig.journeyEngine, 'direct');
  assert.equal(saved.diffuseJourneyAgents.actor.id, 'agent_smoke_actor');
  assert.equal(saved.diffuseJourneyAgents.evaluator, undefined);
  assert.equal(saved.anthropicApiKey, undefined, 'Session-only fake key is not saved in local storage');
  assert.ok(!JSON.stringify(saved.diffuseJourneyAgents).includes(KEY));
  console.log('PASS actual settings and worker preserve partial setup and stay Direct after provider failure');

  assert.equal(await settings.locator('#journey-engine-direct').isChecked(), true, 'The visible form reflects the saved Direct engine after setup failed');
  await settings.locator('#journey-engine-managed').check();
  await settings.locator('#setup-journey-agents').click();
  await settings.waitForFunction(() => document.querySelector('#journey-agent-status').textContent === 'Agents ready' && document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  saved = await worker.evaluate(() => chrome.storage.local.get(['diffuseJourneyAgents', 'aiConfig']));
  assert.equal(saved.aiConfig.journeyEngine, 'managed');
  assert.equal(saved.diffuseJourneyAgents.evaluator.id, 'agent_smoke_evaluator');
  assert.equal(saved.diffuseJourneyAgents.environmentId, 'env_smoke');
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/agents' && call.body.metadata.diffuse_role === 'journey-user').length, 1, 'Retry reuses the already created actor');
  await settings.reload();
  await settings.waitForFunction(() => document.querySelector('#journey-agent-status').textContent === 'Agents ready' && document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  await settings.locator('#setup-journey-agents').click();
  await settings.waitForFunction(() => document.querySelector('#ai-feedback').textContent.startsWith('Journey agents are ready') && document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/environments').length, 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/agents').length, 3, 'Revalidation does not recreate agents');
  console.log('PASS retry provisions remaining resources, enables agents and revalidates pinned resources after reload');

  const page = await context.newPage();
  await page.goto(origin); await page.bringToFront();
  const result = await worker.evaluate(async origin => {
    const {readAISettings, createManagedJourneyDriver, requestManagedJourneyFollowUp, createJourneyExecutor, assertPageAccess} = __managedSmoke;
    const config = await readAISettings({includeKey: true});
    const tab = (await chrome.tabs.query({})).find(item => item.url === origin + '/');
    let metadata;
    const driver = await createManagedJourneyDriver({config, onMetadata: async value => { metadata = value; }});
    const executor = createJourneyExecutor({chromeApi: chrome, tabId: tab.id, startUrl: tab.url, assertPageAccess,
      captureScreenshot: async observation => ({dataUrl: 'data:image/png;base64,' + (await chrome.debugger.sendCommand({tabId: tab.id}, 'Page.captureScreenshot', {format: 'png'})).data, width: observation.context.viewport.width, height: observation.context.viewport.height})});
    try {
      const goal = 'Add Oat milk to the ingredients table and confirm its ml unit.';
      const first = await executor.observe();
      const proposal = await driver.decide({goal, observation: first, history: []});
      const execution = await executor.execute(proposal.action, first);
      const history = [{index: 1, observation: first, ...proposal, result: execution, executionStatus: 'executed'}];
      const second = await executor.observe();
      const evaluated = await driver.decide({goal, observation: second, history});
      await driver.close();
      const run = {id: 'managed-browser-fixture', goal, status: 'completed', summary: evaluated.action.summary, managed: metadata,
        steps: [...history, {index: 2, observation: second, ...evaluated, executionStatus: 'completed'}], followUps: []};
      const answer = await requestManagedJourneyFollowUp({apiKey: config.apiKey, run, question: 'Why did you click that button?', stepIndex: 1, onMetadata: async value => { metadata = value; }});
      return {action: proposal.action.type, execution: execution.performed, outcome: evaluated.action.outcome, summary: evaluated.action.summary, answer, metadata,
        screenshots: [first.screenshot.dataUrl.length, second.screenshot.dataUrl.length]};
    } finally { await driver.close(); await executor.cleanup(); }
  }, origin);
  assert.equal(result.action, 'click'); assert.equal(result.execution, true); assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.answer.evidenceSteps, [1, 2]);
  assert.equal(result.metadata.evaluatorStatus, 'complete');
  assert.ok(result.metadata.evaluatorPendingToolId);
  assert.ok(result.screenshots.every(size => size > 1000));
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(await page.locator('#items tr').count(), 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/sessions').length, 2, 'One budgeted session per role survives follow-up');
  assert.equal(errors.length, 0, errors[0]?.message);
  console.log('PASS real worker driver and Chrome executor click, capture, evaluate, read evidence and continue the same evaluator discussion');

  await page.reload(); await page.bringToFront();
  const blocked = await worker.evaluate(async origin => {
    const {readAISettings, createManagedJourneyDriver, requestManagedJourneyFollowUp, createJourneyExecutor, assertPageAccess, createJourneyRunner} = __managedSmoke;
    const config = await readAISettings({includeKey: true});
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(item => item.url === origin + '/');
    const settingsTab = tabs.find(item => item.url?.endsWith('/ai-settings.html'));
    let metadata;
    const driver = await createManagedJourneyDriver({config, onMetadata: async value => { metadata = value; }});
    const executor = createJourneyExecutor({chromeApi: chrome, tabId: tab.id, startUrl: tab.url, assertPageAccess,
      captureScreenshot: async observation => ({dataUrl: 'data:image/png;base64,' + (await chrome.debugger.sendCommand({tabId: tab.id}, 'Page.captureScreenshot', {format: 'png'})).data, width: observation.context.viewport.width, height: observation.context.viewport.height})});
    try {
      const runner = createJourneyRunner({observe: options => executor.observe(options), decide: args => driver.decide(args),
        execute: async (action, observation, options) => {
          await chrome.tabs.update(settingsTab.id, {active: true});
          return executor.execute(action, observation, options);
        }, onUpdate: async () => {}});
      await runner.start({id: 'blocked-managed-browser', goal: 'Add Oat milk to the ingredients table.', startUrl: tab.url});
      await driver.close();
      const run = {...runner.getState(), managed: metadata, followUps: []};
      const beforeSession = metadata.evaluatorSessionId;
      const reply = await requestManagedJourneyFollowUp({apiKey: config.apiKey, run, question: 'Why did you stop?', onMetadata: async value => { metadata = value; }});
      return {status: run.status, summary: run.summary, beforeSession, reply, metadata, scores: run.scores};
    } finally { await driver.close(); await executor.cleanup(); }
  }, origin);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.summary, /Return to the journey’s tab/);
  assert.equal(blocked.beforeSession, undefined);
  assert.match(blocked.reply.answer, /tab was no longer active/);
  assert.equal(blocked.metadata.evaluatorStatus, 'unavailable');
  assert.ok(blocked.metadata.evaluatorSessionId);
  assert.ok((blocked.scores || []).every(score => score.score == null));
  assert.equal(await page.locator('#items tr').count(), 0, 'Blocked click must never modify the app');
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/sessions').length, 4, 'One original and one lazy evaluator, each from its own attempt’s reserved budget');
  assert.equal(errors.length, 0, errors[0]?.message);
  console.log('PASS inactive-tab stop retains the exact reason and lazy evaluator answers from recorded evidence without scores or browser actions');
  console.log(`PASS Managed Agents browser smoke (${calls.length} local HTTP requests; no real inference)`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
