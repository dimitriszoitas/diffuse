/* Browser actions and persistence belong to the worker. This view never calls
   Playwright or an AI provider directly, and collecting evidence spends no AI budget. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('panel-interactive-audit-view')) return;
  let session = null, pageState = null, windowId, config = null, ai = null;
  let audit = null, opened = false, showSetup = true, pending = null, panelBusy = false;
  let generation = 0, refreshing = false, poll = null, stopped = false, renderedRun = '', syncError = false;
  const statuses = {ready: 'Ready to collect', opening: 'Opening browser', starting: 'Opening browser', running: 'Collecting evidence', completed: 'Evidence collected', stopped: 'Stopped', stopping: 'Stopping…', error: 'Audit interrupted', failed: 'Audit interrupted'};
  const active = value => ['opening', 'starting', 'running', 'stopping'].includes(value?.status);
  const text = (id, value) => { $(id).textContent = value ?? ''; };
  const node = (tag, value, className) => { const el = document.createElement(tag); if (value !== undefined) el.textContent = String(value); if (className) el.className = className; return el; };
  const asText = value => typeof value === 'string' ? value : '';
  const provider = value => value?.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  const errorText = error => asText(error?.message || error).slice(0, 800) || 'The audit could not be updated. Check the browser connection and try again.';
  const notice = (id, value) => { text(id, value); $(id).hidden = !value; };
  const checks = () => ({styles: $('interactive-audit-styles').checked, accessibility: $('interactive-audit-accessibility').checked, interactions: $('interactive-audit-interactions').checked});
  const evidencePresent = value => Boolean(value?.evidence && Object.keys(value.evidence).length);
  const isAnalyzing = value => value?.analysisStatus === 'running' || value?.phase === 'analysis';

  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, sessionId: session?.id, windowId, ...payload});
    if (!result?.ok) throw new Error(result?.error || 'The local browser helper did not respond. Keep it running and check the connection.');
    return result;
  }
  function schedulePoll() {
    clearTimeout(poll);
    if (stopped || !opened || document.hidden || !session) return;
    poll = setTimeout(async () => { await refresh(); schedulePoll(); }, active(audit) || isAnalyzing(audit) ? 1500 : 7000);
  }
  function setOpen(value) {
    opened = Boolean(value && session);
    document.body.dataset.interactiveAuditView = opened ? 'open' : 'closed';
    $('panel-interactive-audit-view').hidden = !opened;
    $('panel-interactive-audit').setAttribute('aria-expanded', String(opened));
    if (opened) {
      paint();
      $('interactive-audit-title').focus({preventScroll: true});
      loadConfig(); refresh();
    }
    schedulePoll();
  }
  function applyConfig(result) {
    if (result?.config) config = result.config;
    if (result?.ai) ai = result.ai;
  }
  async function loadConfig() {
    const stamp = generation;
    const firstLoad = !config;
    try {
      const result = await request('BROWSER_AUDIT_CONFIG');
      if (stamp !== generation) return;
      applyConfig(result);
      if (!ai) {
        const fallback = await request('GET_AI_CONFIG');
        if (stamp !== generation) return;
        ai = fallback.config;
      }
      if (config?.paired && firstLoad) $('interactive-audit-connection').open = false;
    } catch (error) { if (stamp === generation) notice('interactive-audit-error', errorText(error)); }
    finally { if (stamp === generation) paint(); }
  }
  async function refresh() {
    if (!opened || !session || refreshing || pending) return;
    const stamp = generation;
    refreshing = true;
    try {
      const result = await request('BROWSER_AUDIT_STATE', audit?.id ? {id: audit.id} : {});
      if (stamp !== generation) return;
      applyConfig(result);
      const syncProblem = result.syncError || result.audit?.syncError;
      if (syncProblem) { notice('interactive-audit-error', asText(syncProblem) || 'The local browser helper is unavailable. Your saved evidence is still available.'); syncError = true; }
      else if (syncError) { notice('interactive-audit-error', ''); syncError = false; }
      if (result.audit) {
        const newlyRestored = !audit;
        audit = result.audit;
        if (newlyRestored) showSetup = false;
      }
      paint();
    } catch (error) { if (stamp === generation) notice('interactive-audit-error', errorText(error)); }
    finally { refreshing = false; }
  }
  async function mutate(type, payload = {}) {
    if (pending || !session) return;
    const stamp = generation;
    pending = type;
    notice('interactive-audit-error', '');
    paint();
    try {
      const result = await request(type, payload);
      if (stamp !== generation) return;
      applyConfig(result);
      if (result.audit) { audit = result.audit; showSetup = false; }
      if (type === 'BROWSER_AUDIT_PAIR') {
        if (!result.config) config = {...config, paired: true, connected: true};
        $('interactive-audit-connection').open = false;
        notice('interactive-audit-connection-note', 'Browser helper connected.');
      }
      if (type === 'BROWSER_AUDIT_DISCONNECT') {
        config = result.config || {...config, paired: false, connected: false};
        $('interactive-audit-connection').open = true;
        notice('interactive-audit-connection-note', 'Disconnected. Saved audit reports remain available.');
      }
      if (type === 'BROWSER_AUDIT_CHECK') {
        const healthy = result.health?.ok !== false && result.health?.connected !== false && result.connected !== false;
        config = {...config, connected: healthy};
        notice('interactive-audit-connection-note', healthy ? 'The local browser helper is available.' : 'The helper is unavailable. Start it and check again.');
      }
      if (type === 'BROWSER_AUDIT_RUN') $('interactive-audit-run-title').scrollIntoView({block: 'nearest'});
      return result;
    } catch (error) {
      if (stamp === generation) {
        if (type === 'BROWSER_AUDIT_CHECK' || type === 'BROWSER_AUDIT_PAIR') config = {...config, connected: false};
        notice('interactive-audit-error', errorText(error));
        $('interactive-audit-error').focus({preventScroll: true});
      }
    } finally {
      if (stamp === generation) { pending = null; paint(); schedulePoll(); }
    }
  }
  function metric(count, label) {
    const item = node('div', undefined, 'audit-metric');
    item.append(node('strong', count), node('span', label));
    return item;
  }
  function renderEvidence() {
    const evidence = audit?.evidence || {};
    // Do not serialize captured screenshot data on every poll just to update
    // counts. Only evidence that this compact panel actually displays belongs here.
    const countsKey = [evidence.styles?.typography?.length, evidence.styles?.colors?.length, evidence.styles?.spacing?.length, evidence.styles?.radii?.length, evidence.accessibility?.violations?.length, evidence.accessibility?.incomplete?.length, evidence.interactions?.hover?.length, evidence.interactions?.focus?.length];
    const key = JSON.stringify([audit?.id, audit?.updatedAt, audit?.steps, countsKey, audit?.analysis, audit?.analysisError]);
    if (key === renderedRun) return;
    renderedRun = key;
    const counts = $('interactive-audit-counts');
    counts.replaceChildren();
    if (evidence.styles) {
      const variants = ['typography', 'colors', 'spacing', 'radii'].reduce((sum, field) => sum + (Array.isArray(evidence.styles[field]) ? evidence.styles[field].length : 0), 0);
      counts.append(metric(variants, 'Style variants'));
    }
    if (evidence.accessibility) {
      counts.append(metric(evidence.accessibility.violations?.length || 0, 'Accessibility issues'));
      counts.append(metric(evidence.accessibility.incomplete?.length || 0, 'Checks to verify'));
    }
    if (evidence.interactions) counts.append(metric((evidence.interactions.hover?.length || 0) + (evidence.interactions.focus?.length || 0), 'Sampled states'));
    counts.hidden = !counts.childElementCount;
    const steps = Array.isArray(audit?.steps) ? audit.steps : [];
    text('interactive-audit-step-count', steps.length ? `(${steps.length})` : '');
    $('interactive-audit-steps-section').hidden = !steps.length;
    const list = $('interactive-audit-steps'); list.replaceChildren();
    for (const step of steps) {
      const item = node('li');
      item.append(node('span', asText(step.description) || asText(step.action) || asText(step.action?.type) || 'Audit step'));
      item.append(node('small', [asText(step.status), asText(step.details?.message) || asText(step.details)].filter(Boolean).join(' · ')));
      list.append(item);
    }
    const analysis = audit?.analysis;
    $('interactive-audit-analysis').hidden = !analysis;
    text('interactive-audit-assessment-heading', analysis ? `AI assessment · ${provider(analysis)}` : 'AI assessment');
    text('interactive-audit-analysis-summary', analysis?.summary || '');
    text('interactive-audit-limitations', Array.isArray(analysis?.limitations) ? analysis.limitations.join(' ') : asText(analysis?.limitations));
    notice('interactive-audit-ai-error', asText(audit?.analysisError));
    const findings = $('interactive-audit-findings'); findings.replaceChildren();
    for (const finding of Array.isArray(analysis?.findings) ? analysis.findings : []) {
      const article = node('article', undefined, 'audit-finding');
      article.append(node('h4', finding.title || 'Finding'));
      if (finding.description) article.append(node('p', finding.description));
      if (finding.recommendation) article.append(node('p', finding.recommendation));
      findings.append(article);
    }
  }
  function paint() {
    const busy = Boolean(pending), running = active(audit), analyzing = isAnalyzing(audit), browserActive = running || audit?.status === 'ready';
    const paired = Boolean(config?.paired), connected = config?.connected !== false;
    const occupied = Boolean(panelBusy || pageState?.captureBusy || pageState?.commentSaving || pageState?.recordingBusy || pageState?.recording || pageState?.commentOpen || pageState?.comment || pageState?.aiBusy || session?.aiRunning || pageState?.picking || pageState?.areaArmed);
    $('panel-interactive-audit').disabled = !session || (occupied && !running && !analyzing);
    text('interactive-audit-connection-label', !config ? 'Checking…' : !paired ? 'Not connected' : !connected ? 'Unavailable' : 'Paired');
    $('interactive-audit-connection-label').dataset.status = paired && !connected ? 'error' : '';
    $('interactive-audit-token').disabled = busy || browserActive || analyzing;
    $('interactive-audit-pair').disabled = busy || browserActive || analyzing;
    $('interactive-audit-disconnect').hidden = !paired;
    $('interactive-audit-disconnect').disabled = busy || browserActive || analyzing;
    $('interactive-audit-check').disabled = busy || !paired;
    $('interactive-audit-setup').hidden = !showSetup && Boolean(audit);
    $('interactive-audit-run').hidden = showSetup || !audit;
    for (const id of ['url', 'styles', 'accessibility', 'interactions']) $(`interactive-audit-${id}`).disabled = busy || browserActive || analyzing;
    $('interactive-audit-open').disabled = busy || !paired || !connected || !Object.values(checks()).some(Boolean) || browserActive || analyzing;
    text('interactive-audit-open', pending === 'BROWSER_AUDIT_OPEN' ? 'Opening browser…' : 'Open audit browser ↗');
    $('interactive-audit-ready').hidden = audit?.status !== 'ready';
    $('interactive-audit-collect').disabled = busy || !paired || !connected;
    $('interactive-audit-stop').hidden = !browserActive && !analyzing;
    $('interactive-audit-stop').disabled = busy || audit?.status === 'stopping';
    text('interactive-audit-stop', analyzing ? 'Stop analysis' : 'Stop audit');
    $('interactive-audit-report').disabled = !audit?.id || busy;
    $('interactive-audit-new').disabled = busy || browserActive || analyzing;
    text('interactive-audit-status', analyzing ? 'Analyzing evidence' : statuses[audit?.status] || asText(audit?.status));
    text('interactive-audit-page', audit?.page?.title || audit?.page?.url || audit?.url || audit?.input?.url || '');
    const progress = asText(audit?.error) || asText(audit?.stopReason?.message) || asText(audit?.stopReason) || asText(audit?.progress?.message) || asText(audit?.progress) || asText(audit?.message) || (audit?.status === 'completed' ? 'Evidence saved on this device. Review the report or ask AI to explain it.' : ['opening', 'starting'].includes(audit?.status) ? 'Opening a separate browser on this computer…' : running ? 'Collecting selected checks in the audit browser…' : audit?.status === 'stopped' ? 'The audit stopped. Evidence collected so far is available in the report.' : '');
    text('interactive-audit-progress', progress);
    const collected = evidencePresent(audit);
    $('interactive-audit-analysis-section').hidden = !collected || running;
    const providerLabel = provider(ai);
    text('interactive-audit-provider', providerLabel);
    text('interactive-audit-ai-disclosure', ai?.hasKey ? `Analysis sends the measured text evidence and your instructions to ${providerLabel}. Screenshots stay local. Uses ${ai.model || 'your selected model'} for one analysis request. API charges apply. Review the report before sending.` : `Connect ${providerLabel} in AI settings to analyze this evidence. You can still read the local report.`);
    $('interactive-audit-analyze').disabled = busy || running || analyzing || !collected || !ai?.hasKey;
    $('interactive-audit-instructions').disabled = busy || analyzing;
    text('interactive-audit-analyze', analyzing || pending === 'BROWSER_AUDIT_ANALYZE' ? 'Analyzing…' : audit?.analysis ? `Analyze again with ${providerLabel}` : `Analyze with ${providerLabel}`);
    renderEvidence();
  }
  function receiveState(detail) {
    const next = detail.session || null;
    if (next?.id !== session?.id) {
      generation += 1; pending = null; audit = null; renderedRun = ''; showSetup = true;
      $('interactive-audit-token').value = '';
      $('interactive-audit-instructions').value = '';
      $('interactive-audit-url').value = next?.target?.url || '';
      notice('interactive-audit-error', '');
      setOpen(false);
    }
    session = next; pageState = detail.state; panelBusy = Boolean(detail.busy);
    paint();
  }
  window.addEventListener('diffuse-panel-state', event => receiveState(event.detail || {}));
  $('panel-interactive-audit').addEventListener('click', () => setOpen(true));
  $('interactive-audit-back').addEventListener('click', () => { setOpen(false); $('panel-interactive-audit').focus({preventScroll: true}); });
  $('interactive-audit-pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = $('interactive-audit-token').value.trim();
    if (!token || pending) return;
    const stamp = generation;
    // Request in the user gesture before awaiting anything; the worker only
    // receives the secret after access to this fixed local origin is granted.
    const permission = chrome.permissions.request({origins: ['http://127.0.0.1/*']});
    pending = 'permission';
    $('interactive-audit-token').value = '';
    paint();
    try {
      const allowed = await permission;
      if (stamp !== generation) return;
      pending = null;
      if (!allowed) { notice('interactive-audit-error', 'Allow the local browser connection to pair this helper. No token was sent.'); paint(); return; }
      mutate('BROWSER_AUDIT_PAIR', {token});
    } catch {
      if (stamp === generation) { pending = null; notice('interactive-audit-error', 'Could not request access to the local browser helper. Try connecting again.'); paint(); }
    }
  });
  $('interactive-audit-check').addEventListener('click', () => mutate('BROWSER_AUDIT_CHECK'));
  $('interactive-audit-disconnect').addEventListener('click', () => mutate('BROWSER_AUDIT_DISCONNECT'));
  $('interactive-audit-setup').addEventListener('submit', event => {
    event.preventDefault();
    if ($('interactive-audit-open').disabled) return;
    let url;
    try { url = new URL($('interactive-audit-url').value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { notice('interactive-audit-error', 'Enter an HTTP or HTTPS page URL without a username or password.'); $('interactive-audit-url').focus(); return; }
    mutate('BROWSER_AUDIT_OPEN', {url: url.href, checks: checks()});
  });
  for (const id of ['styles', 'accessibility', 'interactions']) $(`interactive-audit-${id}`).addEventListener('change', paint);
  $('interactive-audit-collect').addEventListener('click', () => { if (audit?.id) mutate('BROWSER_AUDIT_RUN', {id: audit.id}); });
  $('interactive-audit-stop').addEventListener('click', () => { if (audit?.id) mutate('BROWSER_AUDIT_STOP', {id: audit.id}); });
  $('interactive-audit-report').addEventListener('click', () => { if (audit?.id) mutate('BROWSER_AUDIT_REPORT', {id: audit.id}); });
  $('interactive-audit-new').addEventListener('click', () => { showSetup = true; paint(); $('interactive-audit-url').focus({preventScroll: true}); });
  $('interactive-audit-analyze').addEventListener('click', () => {
    if (audit?.id && !$('interactive-audit-analyze').disabled) mutate('BROWSER_AUDIT_ANALYZE', {id: audit.id, instructions: $('interactive-audit-instructions').value.trim(), expectedProvider: ai?.provider === 'openai' ? 'openai' : 'anthropic'});
  });
  document.addEventListener('visibilitychange', () => { if (opened && !document.hidden) { loadConfig(); refresh(); } schedulePoll(); });
  window.addEventListener('focus', () => { if (opened) loadConfig(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(poll); });
  chrome.windows.getCurrent().then(value => { windowId = value.id; }).catch(() => {});
})();
