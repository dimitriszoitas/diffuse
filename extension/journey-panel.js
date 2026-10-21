/* Journey state belongs to the worker, so navigation cannot discard the run. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('panel-journey-view')) return;
  const activeStatuses = new Set(['running', 'paused', 'starting', 'stopping']);
  const statusLabels = {running: 'Following the task', paused: 'Paused', starting: 'Preparing the journey', stopping: 'Stopping…', completed: 'Task completed', failed: 'Task failed', blocked: 'Journey blocked', inconclusive: 'Unable to verify', stopped: 'Stopped'};
  const dimensions = {discoverability: 'Finding the path', clarity: 'Clarity', effort: 'Effort', feedback: 'Feedback', recovery: 'Error recovery'};
  let session = null, pageState = null, panelBusy = false, windowId;
  let run = null, opened = false, showForm = true, pending = null, selectedRunId = null;
  let fetching = false, refreshAgain = false, refreshTimer = null, lastFetch = 0;
  let renderKey = '', historyKey = '', pollTimer = null, historyGeneration = 0;
  let mutationGeneration = 0;
  let videoSource = '';
  let aiConfig = null, aiConfigLoading = false;
  let acceptedBusy = new Set();
  let questionStep = null, conversationRun = null, conversationKey = '', asking = false;
  let questionGeneration = 0, forkContext = null;
  let chatOpen = false, pendingQuestion = null, chatReturnStep = null;
  const continuable = value => ['stopped', 'blocked', 'inconclusive'].includes(value?.status);
  const node = (tag, content, className) => {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = String(content);
    if (className) element.className = className;
    return element;
  };
  const text = (id, value) => { $(id).textContent = value ?? ''; };
  const button = (label, action, className) => {
    const element = node('button', label, className);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  const isActive = value => activeStatuses.has(value?.status);
  const asText = value => typeof value === 'string' ? value : '';
  const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  // Keep this form outside the timeline renderer so polling never replaces a
  // question being typed, its selection, or the focused control.
  const discussion = node('section', undefined, 'journey-discussion');
  discussion.id = 'journey-discussion';
  discussion.setAttribute('aria-labelledby', 'journey-discussion-title');
  discussion.hidden = true;
  const chatBack = button('← Journey', () => closeChat(), 'journey-chat-back');
  chatBack.id = 'journey-chat-back';
  const discussionHeading = node('div', undefined, 'journey-section-title');
  const discussionTitle = node('h3', 'Journey chat');
  discussionTitle.id = 'journey-discussion-title';
  discussionHeading.append(discussionTitle, node('span', 'AI'));
  const discussionHelp = node('p', 'Ask about a choice or explore a different route. Answers use the saved steps and evidence.', 'journey-help');
  const conversation = node('div', undefined, 'journey-conversation');
  conversation.id = 'journey-conversation';
  conversation.setAttribute('role', 'log');
  conversation.setAttribute('aria-label', 'Journey conversation');
  conversation.setAttribute('aria-live', 'polite');
  conversation.setAttribute('tabindex', '0');
  const questionForm = node('form', undefined, 'journey-question-form');
  questionForm.id = 'journey-question-form';
  const questionContext = node('div', undefined, 'journey-question-context');
  const contextLabel = node('span', 'Whole journey');
  const clearContext = button('Clear', () => selectQuestionStep(null, false), 'journey-text-button');
  clearContext.setAttribute('aria-label', 'Ask about the whole journey');
  questionContext.append(contextLabel, clearContext);
  const questionLabel = node('label', 'Message Diffuse');
  questionLabel.htmlFor = 'journey-question';
  const questionInput = node('textarea');
  questionInput.id = 'journey-question'; questionInput.rows = 2; questionInput.maxLength = 2000; questionInput.required = true;
  questionInput.placeholder = 'Why did you take this route? Could the wizard be simpler?';
  const questionStatus = node('p', '', 'journey-help');
  questionStatus.id = 'journey-question-status'; questionStatus.setAttribute('role', 'status');
  const questionError = node('p', '', 'journey-question-error');
  questionError.id = 'journey-question-error'; questionError.setAttribute('role', 'alert'); questionError.hidden = true;
  const askButton = node('button', 'Ask AI', 'journey-ask-submit');
  askButton.type = 'submit'; askButton.id = 'journey-ask';
  questionForm.append(questionLabel, questionInput, questionError, askButton, questionStatus);
  const chatHeader = node('div', undefined, 'journey-chat-header');
  chatHeader.append(chatBack, discussionHeading, discussionHelp, questionContext);
  discussion.append(chatHeader, conversation, questionForm);
  $('panel-journey-view').append(discussion);
  const chatEntry = button('Ask AI', () => selectQuestionStep(null), 'journey-chat-entry');
  chatEntry.id = 'journey-chat-open';
  $('journey-summary-section').after(chatEntry);
  questionInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!askButton.disabled) questionForm.requestSubmit();
    }
  });
  questionForm.addEventListener('submit', askQuestion);

  const forkFields = node('section', undefined, 'journey-fork-fields');
  forkFields.id = 'journey-fork-fields'; forkFields.hidden = true;
  const forkHeading = node('h3', 'Try another route');
  const forkDescription = node('p', '', 'journey-help');
  forkDescription.id = 'journey-fork-description';
  const routeLabel = node('label', 'Route to try', 'panel-field');
  routeLabel.htmlFor = 'journey-route';
  const routeInput = node('textarea');
  routeInput.id = 'journey-route'; routeInput.rows = 3; routeInput.maxLength = 2000;
  routeInput.placeholder = 'Use the first step of the wizard before opening Ingredients.';
  const routeCaption = node('span', 'Route to try');
  routeLabel.textContent = ''; routeLabel.append(routeCaption, routeInput);
  const forkCancel = button('Back to original journey', () => {
    forkContext = null; showForm = false; selectedRunId = run?.id || null; showError(''); paint();
  }, 'journey-text-button');
  forkCancel.id = 'journey-fork-cancel';
  forkFields.append(forkHeading, forkDescription, routeLabel, forkCancel);
  $('journey-form').prepend(forkFields);
  const forkButton = button('Try another route', () => prepareFork(), 'journey-fork-button');
  forkButton.id = 'journey-fork';
  $('journey-finished-actions').prepend(forkButton);
  const continueButton = button('Continue journey…', () => prepareContinue(), 'journey-fork-button');
  continueButton.id = 'journey-continue';
  $('journey-finished-actions').prepend(continueButton);
  const continueChat = button('Continue journey…', () => prepareContinue(), 'journey-text-button');
  continueChat.id = 'journey-chat-continue';
  discussionHelp.after(continueChat);
  const lineage = node('p', '', 'journey-lineage');
  lineage.id = 'journey-lineage'; lineage.hidden = true;
  $('journey-run-goal').after(lineage);
  const profileSummary = node('details', undefined, 'journey-persona-summary');
  profileSummary.id = 'journey-persona-summary';
  const profileHeading = node('summary', 'Simulated persona');
  const profileCopy = node('p');
  const profileTraits = node('p');
  profileSummary.append(profileHeading, profileCopy, profileTraits);
  lineage.after(profileSummary);
  const runtimeNote = node('p', '', 'journey-runtime-note');
  runtimeNote.id = 'journey-runtime-note';
  $('journey-metrics').after(runtimeNote);

  function closeChat() {
    chatOpen = false; paint();
    if (chatReturnStep) focusStep(chatReturnStep); else $('journey-chat-open').focus({preventScroll: true});
  }
  function selectQuestionStep(index, focus = true) {
    if (focus) {
      if (!run || isActive(run)) return;
      renderConversation();
      chatOpen = true; chatReturnStep = index;
      $('journey-video').pause();
    }
    questionStep = index;
    contextLabel.textContent = index ? `About step ${index}` : 'Whole journey';
    clearContext.hidden = !index;
    questionInput.placeholder = index ? 'Why did you choose this action? What about another route?' : 'Why did you take this route? Could the wizard be simpler?';
    if (focus) {
      paint();
      conversation.scrollTop = conversation.scrollHeight;
      questionInput.focus({preventScroll: true});
    }
  }
  async function askQuestion(event) {
    event.preventDefault();
    if (asking || pending || !run || isActive(run) || !questionForm.reportValidity()) return;
    const question = questionInput.value.trim();
    if (!question) return;
    const requestSession = session?.id, id = run.id, generation = ++questionGeneration;
    asking = true; pendingQuestion = {question, stepIndex: questionStep};
    questionInput.value = ''; questionError.hidden = true; renderConversation();
    try {
      const reply = await request('JOURNEY_ASK', {runId: id, question, ...(questionStep ? {stepIndex: questionStep} : {})});
      if (session?.id !== requestSession || run?.id !== id || generation !== questionGeneration) return;
      run = reply.run;
      pendingQuestion = null; renderKey = ''; paint();
    } catch (error) {
      if (session?.id === requestSession && run?.id === id && generation === questionGeneration) {
        questionInput.value = question; pendingQuestion = null;
        questionError.textContent = error.message; questionError.hidden = false;
      }
    } finally {
      if (generation === questionGeneration) { asking = false; pendingQuestion = null; paint(); if (chatOpen) questionInput.focus({preventScroll: true}); }
    }
  }
  function prepareFork(suggestion = null, stepIndex = questionStep) {
    if (!run || isActive(run) || pending || asking) return;
    const previous = run;
    showFormFor(previous);
    forkContext = {parentRunId: previous.id, ...(stepIndex ? {stepIndex} : {}), startUrl: previous.startUrl};
    routeInput.value = suggestion?.instructions || '';
    paint();
    routeInput.focus();
  }
  function prepareContinue() {
    if (!continuable(run) || pending || asking) return;
    const previous = run;
    showFormFor(previous);
    forkContext = {parentRunId: previous.id, continuation: true};
    routeInput.value = '';
    paint(); routeInput.focus();
  }
  function renderConversation() {
    discussion.hidden = !chatOpen || showForm || !run || isActive(run);
    continueChat.hidden = !continuable(run);
    continueChat.disabled = asking || Boolean(pending);
    if (!run) return;
    if (conversationRun !== run.id) {
      conversationRun = run.id; conversationKey = ''; questionGeneration++; asking = false; pendingQuestion = null;
      questionInput.value = ''; questionError.hidden = true; selectQuestionStep(null, false);
    }
    const entries = Array.isArray(run.followUps) ? run.followUps : [];
    const key = JSON.stringify([entries, pendingQuestion, asking]);
    if (key !== conversationKey) {
      conversationKey = key;
      const fragment = document.createDocumentFragment();
      if (!entries.length && !pendingQuestion) {
        const empty = node('div', undefined, 'journey-chat-empty');
        empty.append(node('strong', 'Explore this journey together'), node('p', 'Ask why an action was chosen, question an observation, or discuss a different route. Your follow-up messages stay in this conversation.'));
        fragment.append(empty);
      }
      entries.forEach(entry => {
        const exchange = node('article', undefined, 'journey-exchange');
        const question = node('div', undefined, 'journey-question-copy');
        question.append(node('small', entry.stepIndex ? `You · Step ${entry.stepIndex}` : 'You'), node('p', entry.question));
        const answer = node('div', undefined, 'journey-answer-copy');
        answer.append(node('small', 'Diffuse'), node('p', entry.answer));
        const links = node('div', undefined, 'journey-evidence-links');
        for (const index of entry.evidenceSteps || []) if (run.steps.some(step => step.index === index)) links.append(button(`Step ${index}`, () => focusStep(index)));
        answer.append(links);
        if (entry.routeSuggestion?.instructions) {
          const offer = node('div', undefined, 'journey-route-offer');
          offer.append(node('strong', entry.routeSuggestion.label || 'Try a different route'), node('p', entry.routeSuggestion.instructions));
          const action = button('Fork journey…', () => prepareFork(entry.routeSuggestion, entry.stepIndex), 'journey-fork-proposal');
          offer.append(action); answer.append(offer);
        }
        exchange.append(question, answer); fragment.append(exchange);
      });
      if (pendingQuestion) {
        const waiting = node('article', undefined, 'journey-exchange journey-pending-exchange');
        const question = node('div', undefined, 'journey-question-copy');
        question.append(node('small', pendingQuestion.stepIndex ? `You · Step ${pendingQuestion.stepIndex}` : 'You'), node('p', pendingQuestion.question));
        const typing = node('p', 'Diffuse is reading the journey…', 'journey-chat-typing');
        typing.setAttribute('role', 'status');
        waiting.append(question, typing); fragment.append(waiting);
      }
      conversation.replaceChildren(fragment);
      if (chatOpen) conversation.scrollTop = conversation.scrollHeight;
    }
    const full = entries.length >= 20;
    questionInput.disabled = asking || Boolean(pending) || full;
    askButton.disabled = asking || Boolean(pending) || full || aiConfig?.hasKey !== true;
    clearContext.disabled = asking;
    askButton.textContent = asking ? 'Replying…' : 'Send';
    questionStatus.textContent = full ? 'This journey has reached its 20-question limit.' : 'Enter to send · Shift + Enter for a new line. Uses your AI key; messages and evidence go to Anthropic.';
    questionForm.setAttribute('aria-busy', String(asking));
    for (const action of conversation.querySelectorAll('.journey-fork-proposal')) action.disabled = asking || Boolean(pending);
  }

  function showError(message, focus = false) {
    text('journey-error', message || '');
    $('journey-error').hidden = !message;
    if (message && focus) $('journey-error').focus({preventScroll: true});
  }
  function pageLabel(value) {
    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname}${url.hash}`;
    } catch { return asText(value); }
  }
  function confidence(value) {
    if (typeof value === 'number') return `${Math.round(value <= 1 ? value * 100 : value)}% confidence`;
    return ['high', 'medium', 'low'].includes(value) ? `${value[0].toUpperCase()}${value.slice(1)} confidence` : '';
  }
  async function request(type, payload = {}) {
    const reply = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, sessionId: session?.id, windowId, ...payload});
    if (!reply?.ok) throw new Error(reply?.error || 'The journey could not be updated. Please try again.');
    return reply;
  }
  function setOpen(value) {
    opened = value && Boolean(session);
    document.body.dataset.journeyView = opened ? 'open' : 'closed';
    $('panel-journey-view').hidden = !opened;
    $('panel-journey').setAttribute('aria-expanded', String(opened));
    if (opened) {
      paint();
      loadAIConfig();
      scheduleRefresh(true);
      loadHistory();
    } else { $('journey-video').pause(); document.body.dataset.journeyChat = 'closed'; }
    updatePolling();
  }
  function updatePolling() {
    clearTimeout(pollTimer);
    if (opened && !document.hidden && session) pollTimer = setTimeout(() => {
      scheduleRefresh();
      updatePolling();
    }, isActive(run) ? 1500 : 7000);
  }
  function updateAvailability() {
    const occupied = Boolean(panelBusy || pageState?.captureBusy || pageState?.commentSaving || pageState?.recordingBusy || pageState?.recording || pageState?.commentOpen || pageState?.comment || pageState?.aiBusy || session?.aiRunning || pageState?.picking || pageState?.areaArmed);
    // The page's AI configuration is lazy-loaded only when its screenshot audit
    // opens. Journey availability must use the worker's actual settings instead.
    const hasKey = aiConfig?.hasKey;
    $('panel-journey').disabled = !session || (occupied && !isActive(run));
    $('journey-start').disabled = Boolean(pending || !session || occupied || hasKey !== true);
    $('journey-key-help').hidden = hasKey !== false;
    $('journey-form').setAttribute('aria-busy', String(pending === 'JOURNEY_START'));
    for (const field of $('journey-form').querySelectorAll('textarea,select')) field.disabled = pending === 'JOURNEY_START';
    window.diffuseJourneyPersona?.setDisabled(pending === 'JOURNEY_START');
    window.diffuseJourneyOptions?.setDisabled(pending === 'JOURNEY_START');
    forkCancel.disabled = Boolean(pending);
    forkFields.hidden = !forkContext;
    routeInput.required = Boolean(forkContext);
    forkHeading.textContent = forkContext?.continuation ? 'Continue this journey' : 'Try another route';
    routeCaption.textContent = forkContext?.continuation ? 'Instructions for continuing' : 'Route to try';
    routeInput.placeholder = forkContext?.continuation ? 'Continue in the existing project. Scroll the recipe picker and find four recipes to import.' : 'Use the first step of the wizard before opening Ingredients.';
    text('journey-start', pending === 'JOURNEY_START' ? 'Preparing the journey…' : forkContext?.continuation ? 'Continue from current page →' : forkContext ? 'Run alternative route →' : 'Start journey →');
    if (forkContext) forkDescription.textContent = forkContext.continuation
      ? 'Continues from the page currently open on this website, with the previous steps as context. It does not restart the task. The next part gets its own recording and action count; your previous journey stays saved.'
      : `Starts again at ${pageLabel(forkContext.startUrl)}${forkContext.stepIndex ? `, exploring an alternative to step ${forkContext.stepIndex}` : ''}. Your original journey stays saved. Existing app data is not reset.`;
  }
  async function loadAIConfig() {
    if (aiConfigLoading) return;
    aiConfigLoading = true;
    try {
      const reply = await request('GET_AI_CONFIG');
      aiConfig = reply.config || {hasKey: false};
    } catch (error) {
      if (opened && showForm) showError(error.message);
    } finally {
      aiConfigLoading = false;
      updateAvailability();
      renderConversation();
    }
  }
  function scheduleRefresh(immediate = false) {
    if (!session?.id || !Number.isInteger(windowId) || (!opened && !session.journey)) return;
    if (fetching) { refreshAgain = true; return; }
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, immediate ? 0 : Math.max(0, 700 - (Date.now() - lastFetch)));
  }
  async function refresh() {
    if (!session?.id || fetching) return;
    const requestSession = session.id;
    const requestedRun = selectedRunId;
    const requestedMutation = mutationGeneration, requestedQuestion = questionGeneration;
    fetching = true;
    lastFetch = Date.now();
    try {
      const reply = await request('JOURNEY_STATE', {knownUpdatedAt: run?.updatedAt, ...(requestedRun ? {runId: requestedRun} : {})});
      if (session?.id !== requestSession || selectedRunId !== requestedRun || mutationGeneration !== requestedMutation || questionGeneration !== requestedQuestion) return;
      if (reply.run && run && reply.run.id === run.id && Date.parse(reply.run.updatedAt) < Date.parse(run.updatedAt)) return;
      if (!reply.unchanged) {
        const previous = run;
        run = reply.run || null;
        if (isActive(run) || (!previous && run && !showForm)) showForm = false;
        paint();
        if (previous?.status !== run?.status && !isActive(run)) loadHistory();
      }
    } catch (error) {
      if (opened && session?.id === requestSession) showError(error.message);
    } finally {
      fetching = false;
      if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
    }
  }
  async function mutate(type, payload = {}) {
    if (pending || !session) return;
    const requestSession = session.id;
    const generation = ++mutationGeneration;
    pending = type;
    showError('');
    paint();
    try {
      const reply = await request(type, {runId: run?.id, ...payload});
      if (session?.id !== requestSession || generation !== mutationGeneration) return;
      if (reply.run) run = reply.run;
      renderKey = '';
      paint();
      if (!isActive(run)) loadHistory();
      return reply;
    } catch (error) {
      if (session?.id === requestSession && generation === mutationGeneration) showError(error.message, true);
    } finally {
      if (generation === mutationGeneration) {
        pending = null;
        paint();
        scheduleRefresh(true);
      }
    }
  }
  function showFormFor(previous) {
    if (isActive(run)) return;
    $('journey-video').pause();
    showForm = true; chatOpen = false;
    forkContext = null;
    // Keep an older parent selected while editing its rerun. Polling the latest
    // run here could otherwise replace the form underneath the user.
    selectedRunId = previous?.id || run?.id || null;
    if (previous) {
      window.diffuseJourneyPersona?.set(previous.persona);
      window.diffuseJourneyOptions?.set(previous);
      $('journey-goal').value = previous.goal || '';
      $('journey-success').value = previous.successCriteria || previous.input?.successCriteria || '';
      $('journey-test-data').value = previous.testData || previous.input?.testData || '';
      $('journey-max-steps').value = String(previous.maxSteps || previous.input?.maxSteps || 20);
    } else {
      $('journey-form').reset();
      window.diffuseJourneyPersona?.reset();
      window.diffuseJourneyOptions?.reset();
    }
    showError('');
    paint();
    $('journey-goal').focus();
  }
  async function start(event) {
    event.preventDefault();
    if (pending || !session || !$('journey-form').reportValidity()) return;
    const input = {
      goal: $('journey-goal').value.trim(),
      successCriteria: $('journey-success').value.trim(),
      testData: $('journey-test-data').value.trim(),
      maxSteps: Number($('journey-max-steps').value),
      ...(window.diffuseJourneyPersona ? {persona: window.diffuseJourneyPersona.read()} : {}),
      ...(window.diffuseJourneyOptions ? window.diffuseJourneyOptions.read() : {}),
      ...(forkContext ? {[forkContext.continuation ? 'continuation' : 'fork']: {parentRunId: forkContext.parentRunId, ...(!forkContext.continuation && forkContext.stepIndex ? {stepIndex: forkContext.stepIndex} : {}), instructions: routeInput.value.trim()}} : {})
    };
    if (!input.goal) { $('journey-goal').focus(); return; }
    const requestSession = session.id;
    const generation = ++mutationGeneration;
    try {
      const url = new URL(session.target?.url || '');
      if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'file:' && url.hostname)) throw new Error('Open a website or local prototype to start a journey.');
      // Keep this permission request inside the user's submit gesture.
      const access = chrome.permissions.request({origins: [url.protocol === 'file:' ? 'file:///*' : `${url.protocol}//${url.hostname}/*`]});
      pending = 'JOURNEY_START';
      showError('');
      paint();
      if (!await access) throw new Error('Allow access to this site so Diffuse can follow the journey across its pages.');
      if (session?.id !== requestSession || generation !== mutationGeneration) return;
      const reply = await request('JOURNEY_START', {input});
      if (session?.id !== requestSession || generation !== mutationGeneration) return;
      run = reply.run || null;
      forkContext = null;
      selectedRunId = null;
      showForm = false;
      renderKey = '';
    } catch (error) {
      if (session?.id === requestSession && generation === mutationGeneration) showError(error.message, true);
    } finally {
      if (generation === mutationGeneration) {
        pending = null;
        paint();
        scheduleRefresh(true);
      }
    }
  }
  function renderMetrics() {
    const metrics = run.metrics || {};
    const pages = Array.isArray(metrics.pagesVisited) ? metrics.pagesVisited.length : numeric(metrics.pagesVisited ?? metrics.pages);
    const values = [['Pages', pages], ['Click attempts', numeric(metrics.clicks)], ['Backtracks', numeric(metrics.backtracks)]];
    const fragment = document.createDocumentFragment();
    for (const [label, value] of values) {
      const item = node('div', undefined, 'journey-metric');
      item.append(node('strong', value), node('span', label));
      fragment.append(item);
    }
    $('journey-metrics').replaceChildren(fragment);
    const seconds = Math.round(Math.max(0, numeric(metrics.elapsedMs)) / 1000);
    runtimeNote.textContent = `Automation duration: ${Math.floor(seconds / 60)}m ${seconds % 60}s · ${numeric(metrics.scrolls)} scroll attempts · ${numeric(metrics.waits)} wait actions. Includes AI, network and pauses; not human task time.`;
  }
  function actionLabel(step) {
    const action = step.action;
    if (typeof action === 'string') return action;
    const kind = action?.type || action?.action || 'observe';
    const labels = {click: 'Click', type: 'Enter text', fill: 'Enter text', select: 'Choose an option', scroll: 'Scroll', navigate: 'Open page', back: 'Go back', wait: 'Wait for the page', inspect: 'Read page', observe: 'Read page', finish: 'Check the outcome', complete: 'Check the outcome', press: 'Press a key', key: 'Press a key'};
    const controlId = action?.controlId ?? action?.targetId ?? action?.target;
    const controls = step.observation?.controls;
    const control = Array.isArray(controls) ? controls.find(item => item.id === controlId) : null;
    const target = action?.label || action?.targetLabel || action?.description || control?.label || control?.name;
    return `${labels[kind] || kind}${target ? ` · ${target}` : ''}`;
  }
  function screenshotUrl(step) {
    const value = step?.observation?.screenshot?.dataUrl || step?.observation?.screenshotDataUrl || '';
    return /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(value) ? value : '';
  }
  function renderRecording() {
    const recording = run.recording || {};
    const labels = {recording: 'Recording the journey · no audio', paused: 'Recording paused', processing: 'Preparing the journey recording…', saved: 'Journey recording saved', unavailable: 'Recording unavailable'};
    text('journey-recording-status', recording.status === 'unavailable' && run.recordingError ? `Recording unavailable. ${run.recordingError}` : labels[recording.status] || '');
    $('journey-recording-status').hidden = !labels[recording.status] || recording.status === 'saved';
    $('journey-recording-status').dataset.status = recording.status || '';
    const src = asText(run.video?.dataUrl);
    const valid = /^data:video\/(?:webm|mp4)(?:;codecs=[^;,]+)?;base64,[a-zA-Z0-9+/=\s]+$/.test(src);
    $('journey-recording-section').hidden = !valid;
    if (valid && src !== videoSource) {
      videoSource = src;
      $('journey-video').src = src;
      $('journey-video-download').href = src;
      $('journey-video-download').download = asText(run.video.filename) || `diffuse-journey.${run.video.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`;
    } else if (!valid && videoSource) {
      $('journey-video').pause();
      $('journey-video').removeAttribute('src');
      $('journey-video').load();
      $('journey-video-download').removeAttribute('href');
      videoSource = '';
    }
  }
  async function watchStep(step) {
    if (!videoSource || !Number.isFinite(step.videoOffsetMs)) return;
    const player = $('journey-video');
    const seek = () => {
      player.currentTime = Math.max(0, Math.min(step.videoOffsetMs / 1000, Number.isFinite(player.duration) ? player.duration : Infinity));
      player.play().catch(() => {});
    };
    player.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center'});
    player.focus({preventScroll: true});
    if (player.readyState >= 1) seek(); else player.addEventListener('loadedmetadata', seek, {once: true});
  }
  function showEvidence(step) {
    const src = screenshotUrl(step);
    if (!src) return;
    text('journey-evidence-title', `Step ${step.index} · Captured page`);
    text('journey-evidence-caption', step.observation?.title || pageLabel(step.observation?.url));
    $('journey-evidence-image').src = src;
    $('journey-evidence-image').alt = `Page at step ${step.index}: ${step.observation?.title || 'Journey evidence'}`;
    $('journey-evidence-dialog').showModal();
  }
  function focusStep(index) {
    if (chatOpen) { chatOpen = false; paint(); }
    const item = $('journey-timeline').querySelector(`[data-step="${Number(index)}"]`);
    if (!item) return;
    const details = item.querySelector('details');
    details.open = true;
    item.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center'});
    details.querySelector('summary').focus({preventScroll: true});
  }
  function renderTimeline() {
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const list = $('journey-timeline');
    if (list.dataset.runId !== run.id) { list.replaceChildren(); list.dataset.runId = run.id; }
    const existing = new Map([...list.children].map(item => [Number(item.dataset.step), item]));
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], index = Number(step.index || i + 1);
      const signature = JSON.stringify([step.action, step.reason, step.result, step.executionStatus, step.observation?.url, step.observation?.title, Boolean(screenshotUrl(step)), Boolean(videoSource), step.videoOffsetMs, isActive(run)]);
      let item = existing.get(index);
      if (item?.dataset.signature === signature) { existing.delete(index); continue; }
      const wasOpen = item?.querySelector('details')?.open || false;
      const next = node('li');
      next.dataset.step = String(index);
      next.dataset.signature = signature;
      const detail = node('details');
      detail.open = wasOpen;
      const summary = node('summary');
      const copy = node('span', undefined, 'journey-step-copy');
      copy.append(node('strong', actionLabel(step)), node('small', step.observation?.title || pageLabel(step.observation?.url) || 'Current page'));
      summary.append(node('span', index, 'journey-step-number'), copy);
      detail.append(summary);
      const body = node('div', undefined, 'journey-step-detail');
      if (step.reason) body.append(node('p', step.reason));
      if (step.executionStatus === 'error') body.append(node('p', 'Diffuse could not perform this action. This alone does not confirm an app defect.', 'journey-step-error'));
      if (step.executionStatus === 'interrupted') body.append(node('p', 'This action was interrupted. Its outcome is not confirmed.', 'journey-step-result'));
      if (step.executionStatus === 'running') body.append(node('p', 'Performing this action…', 'journey-step-result'));
      const result = typeof step.result === 'string' ? step.result : step.result?.message || step.result?.error || step.result?.description;
      if (result) body.append(node('p', result, step.result?.ok === false ? 'journey-step-error' : 'journey-step-result'));
      if (step.observation?.url) body.append(node('p', pageLabel(step.observation.url), 'journey-step-url'));
      if (!isActive(run)) body.append(button('Ask AI about this step', () => { if (!asking) selectQuestionStep(index); }, 'journey-ask-step'));
      if (videoSource && Number.isFinite(step.videoOffsetMs)) {
        const timestamp = `${Math.floor(step.videoOffsetMs / 60000)}:${String(Math.floor(step.videoOffsetMs / 1000) % 60).padStart(2, '0')}`;
        body.append(button(`Watch this step · ${timestamp}`, () => watchStep(step), 'journey-watch-step'));
      }
      if (screenshotUrl(step)) {
        const preview = button('', () => showEvidence({...step, index}), 'journey-screenshot');
        preview.setAttribute('aria-label', `Open screenshot for step ${index}`);
        const image = node('img');
        image.src = screenshotUrl(step);
        image.alt = '';
        image.loading = 'lazy';
        preview.append(image, node('span', 'View captured page ↗'));
        body.append(preview);
      }
      detail.append(body);
      next.append(detail);
      if (item) item.replaceWith(next); else list.append(next);
      existing.delete(index);
    }
    for (const old of existing.values()) old.remove();
    text('journey-step-count', `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`);
    $('journey-timeline-empty').hidden = steps.length > 0;
    text('journey-timeline-empty', isActive(run) ? 'Reading the starting page…' : 'No steps were captured.');
  }
  function renderScores() {
    const scores = Array.isArray(run.scores) ? run.scores : [];
    $('journey-assessment').hidden = !scores.length;
    const openedScores = new Set([...$('journey-scores').querySelectorAll('details[open]')].map(item => item.dataset.dimension));
    const fragment = document.createDocumentFragment();
    for (const score of scores) {
      const row = node('details', undefined, 'journey-score');
      row.dataset.dimension = score.dimension;
      row.open = openedScores.has(score.dimension);
      const heading = node('summary');
      const value = Number.isFinite(score.score) && score.score >= 1 && score.score <= 5 ? `${score.score}/5` : 'Not tested';
      heading.append(node('span', dimensions[score.dimension] || score.dimension), node('strong', value, 'journey-score-value'));
      row.append(heading);
      if (score.reason) row.append(node('p', score.reason));
      if (confidence(score.confidence)) row.append(node('p', confidence(score.confidence), 'journey-confidence'));
      if (Array.isArray(score.evidenceSteps) && score.evidenceSteps.length) {
        const links = node('div', undefined, 'journey-evidence-links');
        for (const index of score.evidenceSteps) if (Number.isInteger(index) && run.steps?.some(step => step.index === index)) links.append(button(`Step ${index}`, () => focusStep(index)));
        row.append(links);
      }
      fragment.append(row);
    }
    $('journey-scores').replaceChildren(fragment);
  }
  async function acceptFinding(index) {
    if (acceptedBusy.has(index) || !run) return;
    const id = run.id, requestSession = session?.id;
    acceptedBusy.add(index);
    showError('');
    renderFindings();
    try {
      const reply = await request('JOURNEY_ACCEPT', {runId: id, findingIndex: index});
      if (run?.id !== id || session?.id !== requestSession) return;
      if (reply.run) run = reply.run;
      else if (reply.commentId && run.findings[index]) run.findings[index].acceptedCommentId = reply.commentId;
      renderKey = '';
      paint();
    } catch (error) { if (run?.id === id) showError(error.message, true); }
    finally { acceptedBusy.delete(index); if (run?.id === id) renderFindings(); }
  }
  function renderFindings() {
    const findings = Array.isArray(run.findings) ? run.findings : [];
    $('journey-findings-section').hidden = !findings.length;
    text('journey-findings-count', findings.length);
    const fragment = document.createDocumentFragment();
    findings.forEach((finding, index) => {
      const card = node('article', undefined, 'journey-finding');
      const meta = node('div', undefined, 'journey-finding-meta');
      meta.append(node('span', {minor: 'Minor', major: 'Major', critical: 'Critical'}[finding.severity] || 'Minor', 'journey-severity'), node('span', confidence(finding.confidence)));
      card.dataset.severity = finding.severity || 'minor';
      card.append(meta, node('h4', finding.title || 'Journey finding'), node('p', finding.comment || ''));
      if (finding.expected) {
        const change = node('div', undefined, 'journey-finding-change');
        change.append(node('strong', 'Suggested change'), node('p', finding.expected));
        card.append(change);
      }
      const actions = node('div', undefined, 'journey-finding-actions');
      const accepted = Boolean(finding.acceptedCommentId || finding.commentId);
      const accept = button(accepted ? 'Added to review ✓' : acceptedBusy.has(index) ? 'Adding…' : 'Accept as comment', () => acceptFinding(index));
      accept.disabled = accepted || acceptedBusy.has(index) || isActive(run);
      actions.append(accept);
      if (Number.isInteger(finding.stepIndex) && run.steps?.some(step => step.index === finding.stepIndex)) actions.append(button(`View step ${finding.stepIndex}`, () => focusStep(finding.stepIndex), 'journey-text-button'));
      card.append(actions);
      fragment.append(card);
    });
    $('journey-findings').replaceChildren(fragment);
  }
  async function loadHistory() {
    if (!session?.id || !opened || isActive(run)) return;
    const generation = ++historyGeneration, requestSession = session.id;
    try {
      const reply = await request('JOURNEY_HISTORY');
      if (generation !== historyGeneration || requestSession !== session?.id) return;
      const runs = (reply.runs || []).filter(item => item?.id);
      const key = JSON.stringify(runs);
      $('journey-history').hidden = !runs.length;
      if (key === historyKey) return;
      historyKey = key;
      const fragment = document.createDocumentFragment();
      for (const item of runs) {
        const open = button('', async () => {
          if (pending || asking || isActive(run)) return;
          const loadGeneration = ++mutationGeneration;
          pending = 'JOURNEY_LOAD'; paint(); showError('');
          try {
            const result = await request('JOURNEY_LOAD', {runId: item.id});
            if (requestSession !== session?.id || loadGeneration !== mutationGeneration) return;
            run = result.run || null;
            selectedRunId = run?.id || null;
            showForm = !run;
            renderKey = '';
            $('journey-history').open = false;
          } catch (error) {
            if (requestSession === session?.id && loadGeneration === mutationGeneration) showError(error.message, true);
          } finally {
            if (requestSession === session?.id && loadGeneration === mutationGeneration) { pending = null; paint(); }
          }
        });
        const date = new Date(item.createdAt);
        const when = Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
        open.append(node('strong', item.goal || 'Journey review'), node('small', [item.continuation ? 'Continuation' : item.fork ? 'Alternative route' : 'Original run', statusLabels[item.status] || item.status, when].filter(Boolean).join(' · ')));
        if (item.fork?.instructions) open.append(node('small', item.fork.instructions));
        if (item.continuation?.instructions) open.append(node('small', item.continuation.instructions));
        fragment.append(open);
      }
      $('journey-history-list').replaceChildren(fragment);
    } catch { /* Older workers may not provide saved history until reload. */ }
  }
  function paint() {
    updateAvailability();
    if (!run || isActive(run) || showForm) chatOpen = false;
    document.body.dataset.journeyChat = opened && chatOpen ? 'open' : 'closed';
    discussion.hidden = !chatOpen;
    chatEntry.hidden = !run || isActive(run) || !run.steps?.length;
    chatEntry.disabled = Boolean(pending);
    $('journey-form').hidden = !showForm;
    $('journey-run').hidden = showForm || !run;
    $('journey-history').hidden = isActive(run) || !historyKey || historyKey === '[]';
    if (!run || showForm) return;
    renderRecording();
    const active = isActive(run);
    const paused = run.status === 'paused';
    $('journey-run').dataset.status = run.status;
    text('journey-status', statusLabels[run.status] || run.status);
    text('journey-progress', `${numeric(run.metrics?.actions ?? run.steps?.length)} / ${run.maxSteps || run.input?.maxSteps || 20} actions`);
    $('journey-run-controls').hidden = !active;
    $('journey-pause').hidden = paused;
    $('journey-resume').hidden = !paused;
    $('journey-pause').disabled = Boolean(pending || run.status === 'stopping');
    $('journey-resume').disabled = Boolean(pending);
    // Stop remains available during a pending pause/resume request.
    $('journey-stop').disabled = pending === 'JOURNEY_STOP' || run.status === 'stopping';
    text('journey-pause', pending === 'JOURNEY_PAUSE' ? 'Pausing…' : 'Pause');
    text('journey-resume', pending === 'JOURNEY_RESUME' ? 'Resuming…' : 'Resume');
    text('journey-stop', pending === 'JOURNEY_STOP' ? 'Stopping…' : 'Stop journey');
    text('journey-run-goal', run.goal);
    text('journey-current-page', pageLabel(run.steps?.at(-1)?.observation?.url || run.startUrl));
    const notice = paused ? 'The journey is paused. You can inspect the page, then resume when ready.' : active ? 'You are watching AI operate this site. Pause before making changes yourself.' : asText(run.error) || asText(run.stopReason);
    text('journey-run-notice', notice);
    $('journey-run-notice').hidden = !notice;
    $('journey-finished-actions').hidden = active;
    $('journey-new').disabled = Boolean(pending || asking);
    $('journey-use-goal').disabled = Boolean(pending || asking);
    forkButton.disabled = Boolean(pending || asking);
    continueButton.hidden = !continuable(run);
    continueButton.disabled = Boolean(pending || asking);
    profileHeading.textContent = run.persona ? 'Simulated persona' : 'Persona not recorded';
    profileCopy.textContent = run.persona?.description || 'This older journey was run without a saved persona.';
    profileTraits.textContent = run.persona ? [['Technical confidence', 'technicalConfidence'], ['Product familiarity', 'productFamiliarity'], ['Task familiarity', 'taskFamiliarity'], ['Persistence', 'persistence']].map(([label, key]) => `${label}: ${run.persona[key]}/5`).join(' · ') : '';
    discussionHelp.textContent = run.persona ? `Discuss this journey as simulated for: ${run.persona.description}` : 'Ask about a choice or explore a different route. Answers use the saved steps and evidence.';
    lineage.hidden = !run.fork && !run.continuation;
    if (run.fork) lineage.textContent = `Alternative route${run.fork.stepIndex ? ` · From step ${run.fork.stepIndex}` : ''}. ${run.fork.instructions}`;
    if (run.continuation) lineage.textContent = `Continuation from the current page. ${run.continuation.instructions} Recording, steps and action counts cover this part only. The previous journey remains in history.`;
    renderConversation();
    const summary = asText(run.summary) || asText(run.summary?.text);
    $('journey-summary-section').hidden = !summary;
    text('journey-summary', summary);
    const key = JSON.stringify([run.id, run.updatedAt, run.status, run.steps?.length, run.metrics, run.summary, run.scores, run.findings, Boolean(videoSource)]);
    if (key !== renderKey) {
      renderKey = key;
      renderMetrics();
      renderTimeline();
      renderScores();
      renderFindings();
    }
  }
  function receiveState(detail) {
    const next = detail.session || null;
    const sessionChanged = next?.id !== session?.id;
    if (sessionChanged) {
      run = null; selectedRunId = null; renderKey = ''; historyKey = '';
      showForm = true; acceptedBusy = new Set(); historyGeneration++; mutationGeneration++; pending = null;
      questionGeneration++; asking = false; forkContext = null; conversationRun = null; conversationKey = ''; chatOpen = false; pendingQuestion = null;
      conversation.replaceChildren(); questionInput.value = ''; questionError.hidden = true; selectQuestionStep(null, false);
      $('journey-video').pause(); $('journey-video').removeAttribute('src'); $('journey-video').load(); videoSource = '';
      $('journey-evidence-dialog').close(); $('journey-evidence-image').removeAttribute('src');
      $('journey-history-list').replaceChildren();
      $('journey-form').reset();
      window.diffuseJourneyPersona?.reset();
      window.diffuseJourneyOptions?.reset();
      showError('');
      if (!next) setOpen(false);
    }
    session = next;
    pageState = detail.state || null;
    panelBusy = Boolean(detail.busy);
    if (sessionChanged) paint();
    if (!session) { setOpen(false); return; }
    updateAvailability();
    if (session.journey && session.journey.id !== run?.id && !selectedRunId) showForm = false;
    scheduleRefresh();
  }
  window.addEventListener('diffuse-panel-state', event => receiveState(event.detail || {}));
  $('panel-journey').addEventListener('click', () => { showForm = !run; setOpen(true); });
  $('journey-back').addEventListener('click', () => { setOpen(false); $('panel-journey').focus({preventScroll: true}); });
  $('journey-form').addEventListener('submit', start);
  $('journey-pause').addEventListener('click', () => mutate('JOURNEY_PAUSE'));
  $('journey-resume').addEventListener('click', () => mutate('JOURNEY_RESUME'));
  $('journey-stop').addEventListener('click', () => {
    // Stop is allowed to interrupt an outstanding pause or resume.
    if (pending !== 'JOURNEY_STOP') { pending = null; mutate('JOURNEY_STOP'); }
  });
  $('journey-use-goal').addEventListener('click', () => showFormFor(run));
  $('journey-new').addEventListener('click', () => showFormFor(null));
  $('journey-evidence-close').addEventListener('click', () => $('journey-evidence-dialog').close());
  $('journey-evidence-dialog').addEventListener('click', event => {
    if (event.target === $('journey-evidence-dialog')) {
      const bounds = event.target.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
    }
  });
  document.addEventListener('visibilitychange', () => {
    updatePolling();
    if (!document.hidden) {
      scheduleRefresh(true);
      if (opened) loadAIConfig();
    }
  });
  window.addEventListener('focus', () => { if (opened) loadAIConfig(); });
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); clearTimeout(refreshTimer); });
  chrome.windows.getCurrent().then(async current => {
    windowId = current.id;
    if (!session) {
      const reply = await request('PANEL_STATE');
      if (!session) receiveState({session: reply.session, state: reply.state});
    }
    scheduleRefresh(true);
  }).catch(() => {});
})();
