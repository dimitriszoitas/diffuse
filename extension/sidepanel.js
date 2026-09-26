/* The live page remains the owner of selection, drafts and capture. This view
   renders an explicit snapshot and sends only allowlisted review commands. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const fields = ['title','comment','expected','component','state','steps','severity','category'];
  let panelWindowId, port, attached = false, state = null, refreshRunning = false, refreshAgain = false;
  let draftId = null, evidenceKey = null, evidence = null, commentsKey = '', aiKey = '';
  let pendingAction = null, commandError = '', stopped = false, connectionLost = false;
  let referenceToggle = null;
  let fieldVersion = 0, acknowledgedVersion = 0;
  let lastSessionId = null;
  const editorId = crypto.randomUUID();
  const isImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
  const isVideo = value => typeof value === 'string' && /^data:video\/webm(?:;codecs=[a-z0-9,]+)?;base64,[A-Za-z0-9+/=]+$/i.test(value);
  const category = value => ({'design-mismatch':'Design mismatch','ux-issue':'UX issue','copy-change':'Copy change'}[value] || 'Design mismatch');
  const text = (id,value) => { $(id).textContent = value || ''; };
  function notice(id,value) { text(id,value); $(id).hidden = !value; }
  function node(tag,content,className) { const item = document.createElement(tag); if(content !== undefined) item.textContent = content; if(className)item.className=className; return item; }
  function button(label,action,disabled=false) { const item=node('button',label); item.type='button'; item.disabled=disabled; item.addEventListener('click',action); return item; }
  function values() { return Object.fromEntries(fields.map(key => [key,$(`panel-field-${key}`).value])); }
  function draftFields() { return {draftId,fields:values(),editorId,fieldRevision:fieldVersion}; }
  function clearDraft() { draftId=null;evidenceKey=null;evidence=null;fieldVersion=0;acknowledgedVersion=0; }

  async function panelRequest(type, payload) {
    const result = await chrome.runtime.sendMessage({namespace:'diffuse', target:'worker', type, ...payload});
    if (!result?.ok) throw Object.assign(new Error(result?.error || 'Diffuse did not respond. Reopen the drawer and try again.'), {code:result?.code});
    return result;
  }
  function describeConnectionError(error) {
    if (error.code === 'PANEL_PAGE_DISCONNECTED' || /receiving end does not exist|could not establish connection|message port closed|message channel closed/i.test(error.message || '')) {
      connectionLost = true;
      return 'The page connection was interrupted. Your text is still in this drawer. Reconnect the review, then save again.';
    }
    return error.message;
  }
  async function command(action,data={},quiet=false) {
    if (!session?.id || !Number.isInteger(panelWindowId)) return;
    const requestSession=session.id;
    if (!quiet) { pendingAction=action;commandError='';paint(); }
    try {
      const result=await panelRequest('PANEL_COMMAND',{windowId:panelWindowId,sessionId:requestSession,action,...data});
      if (requestSession===session?.id && result.session !== undefined) session=result.session;
      if (action==='recoverPage') {connectionLost=false;commandError='';}
      return result;
    } catch(error) {
      if(requestSession===session?.id){commandError=describeConnectionError(error);notice('feedback',commandError);if(draftId)notice('panel-comment-error',commandError);}
      throw error;
    } finally {
      if (!quiet && pendingAction===action) pendingAction=null;
      paint();refresh();
    }
  }
  const act=(action,data) => command(action,data).catch(()=>{});
  function syncFields() {
    if(!draftId)return;
    const version=++fieldVersion;
    if(connectionLost)return;
    command('setCommentFields',draftFields(),true).then(result=>{if(result)acknowledgedVersion=Math.max(acknowledgedVersion,version);}).catch(()=>{});
  }
  function connect() {
    if(stopped)return;
    attached=false;
    port=chrome.runtime.connect({name:'diffuse-sidepanel'});
    port.postMessage({type:'ATTACH',windowId:panelWindowId});
    port.postMessage({type:'VISIBILITY',visible:!document.hidden});
    port.onMessage.addListener(message=>{if(message.type==='ATTACHED')attached=true;if(['ATTACHED','STATE_CHANGED'].includes(message.type))refresh();if(message.type==='ERROR')notice('feedback',message.error);});
    port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;attached=false;port=null;if(!stopped)setTimeout(connect,1000);});
  }
  async function refresh() {
    if(!Number.isInteger(panelWindowId)||stopped||!attached)return;
    if(refreshRunning){refreshAgain=true;return;}
    refreshRunning=true;
    try {
      const result=await panelRequest('PANEL_STATE',{windowId:panelWindowId,knownDraftId:draftId,knownEvidenceKey:evidenceKey});
      const nextSession=result.session || null;
      if(nextSession?.id!==lastSessionId){clearDraft();commentsKey='';aiKey='';state=null;connectionLost=false;commandError='';lastSessionId=nextSession?.id||null;}
      session=nextSession;
      if(result.state?.code==='PANEL_PAGE_STARTING') {
        // Initial connection is expected to take a moment; retain any existing
        // draft/error rather than treating this as a reconnect or a Save retry.
        if(!draftId){state=result.state;connectionLost=false;commandError='';}
      } else if(result.state?.code==='PANEL_PAGE_DISCONNECTED') {
        connectionLost=true;commandError=result.state.message;
        // A failed connection must not replace the locally edited draft with an empty view.
        if(!draftId||!state?.comment)state=result.state;
      } else if(!connectionLost||!draftId){state=result.state || null;if(connectionLost){connectionLost=false;commandError='';}}
      if(referenceToggle&&(nextSession?.id!==referenceToggle.sessionId
        ||(referenceToggle.commandDone&&Boolean(nextSession.settings?.hidden)===referenceToggle.hidden)))referenceToggle=null;
      if(state?.comment?.evidenceIncluded){evidence=state.comment.evidence||null;evidenceKey=state.comment.evidenceKey;}
      renderSession();paint();
      if(!commandError)notice('feedback','');
    } catch(error) {
      commandError=describeConnectionError(error);notice('feedback',commandError);if(draftId)notice('panel-comment-error',commandError);paint();
    } finally {
      refreshRunning=false;
      if(refreshAgain){refreshAgain=false;setTimeout(refresh,50);}
    }
  }

  function paintEvidence(comment) {
    const container=$('panel-evidence');container.replaceChildren();
    for(const [side,label] of [['production',Number.isInteger(session?.sourceTabId)?'Production':'Page'],['prototype','Reference']]){
      const src=evidence?.[side]?.dataUrl;if(!isImage(src))continue;
      const figure=node('figure'),img=node('img');img.src=src;img.alt=`${label} at capture`;figure.append(img,node('figcaption',label));container.append(figure);
    }
    const recording=comment.evidenceChoice==='recording';
    $('panel-evidence-screenshot').setAttribute('aria-pressed',String(!recording));
    $('panel-evidence-recording').setAttribute('aria-pressed',String(recording));
    $('panel-recording-choice').hidden=!recording;
    const video=$('panel-recording-preview');const url=evidence?.video?.dataUrl;
    if(recording&&isVideo(url)){if(video.getAttribute('src')!==url)video.src=url;video.hidden=false;}
    else{video.pause();video.removeAttribute('src');video.hidden=true;}
    text('panel-record-comment',isVideo(url)?'Record again':'Start recording');
  }

  function paintComment(comment) {
    const fresh=draftId!==comment.id;
    const changedEvidence=$('panel-evidence').dataset.key!==String(comment.evidenceKey);
    draftId=comment.id;
    if(fresh){fieldVersion=0;acknowledgedVersion=0;}
    const isEditing=$('panel-comment-form').contains(document.activeElement);
    const currentRevision=fieldVersion===0||Number(comment.fieldRevisions?.[editorId])>=fieldVersion;
    if(fresh||(!isEditing&&fieldVersion===acknowledgedVersion&&currentRevision))for(const key of fields)$(`panel-field-${key}`).value=comment.fields?.[key]||'';
    text('panel-composer-title',comment.evidenceChoice==='recording'?'Add a recording comment':'Add a comment');
    text('panel-selection',comment.selectionSummary);text('panel-component-hint',comment.componentHint);
    notice('panel-comment-error',commandError||comment.error);
    $('panel-recover-comment').hidden=!connectionLost;
    $('panel-recover-comment').disabled=Boolean(pendingAction);
    if(fresh||changedEvidence||$('panel-evidence').dataset.choice!==comment.evidenceChoice){
      paintEvidence(comment);$('panel-evidence').dataset.key=String(comment.evidenceKey);$('panel-evidence').dataset.choice=comment.evidenceChoice;
    }
    const locked=state.commentSaving||state.recordingBusy||Boolean(state.recording)||['saveComment','recordComment','recoverPage'].includes(pendingAction);
    for(const control of $('panel-comment-form').elements)control.disabled=locked;
    for(const id of ['panel-cancel-comment','panel-evidence-screenshot','panel-evidence-recording','panel-record-comment'])$(id).disabled=locked;
    $('panel-save-comment').disabled=locked||connectionLost;
    text('panel-save-comment',locked?'Please wait…':'Save comment');
    if(fresh) $('panel-field-comment').focus({preventScroll:true});
  }

  function paintComments() {
    const group=width=>!Number.isFinite(width)||width<=0?'unknown':width>=1440?'desktop':width>=1280?'laptop':width>=768?'tablet':'phone';
    const viewport=session?.viewportPreset||group(session?.targetViewport?.width);
    const all=session?.comments||[];
    const comments=all.filter(item=>{const context=item.context?.production||item.selection?.context;const saved=context?.viewportProfile?.key;const key=['desktop','laptop','tablet','phone'].includes(saved)?saved:group(context?.viewport?.width);return key==='unknown'||key===viewport;});
    const key=JSON.stringify([viewport,comments.map(item=>[item.id,item.fields])]);if(key===commentsKey)return;commentsKey=key;
    const label={desktop:'Desktop',laptop:'Laptop',tablet:'Tablet',phone:'Phone'}[viewport]||'This view';
    const list=$('panel-comments');list.replaceChildren();list.append(node('h2',`${label} comments · ${comments.length}`));
    if(all.length>comments.length)list.append(node('p',`${all.length-comments.length} comments are in other viewport views. All remain in Review reports.`,'muted'));
    if(!comments.length){list.append(node('p','Comments for this view will appear here and as pins on the page.','muted'));return;}
    comments.forEach((item,index)=>{
      const label=item.fields?.title||item.fields?.comment||'Saved comment';
      const entry=button('',()=>act('showPin',{id:item.id}));entry.className='saved-item';entry.dataset.category=item.fields?.category||'design-mismatch';
      const dot=node('i',undefined,'category-dot');dot.setAttribute('aria-hidden','true');const copy=node('span',`${all.indexOf(item)+1}. ${label.length>140?`${label.slice(0,137)}…`:label}`);copy.append(node('small',`${category(item.fields?.category)} · ${item.fields?.state||'Current state'}`));entry.append(dot,copy);list.append(entry);
    });
  }

  function paintAi(ai) {
    if(!ai)return;
    const inactiveField=id=>document.activeElement!==$(id);
    if(inactiveField('panel-ai-instructions'))$('panel-ai-instructions').value=ai.instructions||'';
    if(inactiveField('panel-ai-threshold'))$('panel-ai-threshold').value=String(ai.threshold??35);
    text('panel-ai-threshold-value',`${$('panel-ai-threshold').value}/100`);
    text('panel-ai-mode',Number.isInteger(session.sourceTabId)?'Compare the current page and reference screenshots.':'Review this page for UX and copy issues.');
    text('panel-ai-config',ai.config?.hasKey?`Model: ${ai.config.model}. Your API key stays in extension settings.`:'Add your Anthropic API key in AI settings below.');
    notice('panel-ai-error',ai.error);
    const locked=state.aiBusy||state.aiOperationBusy||session.aiRunning||pendingAction==='runAi';
    $('panel-ai-run').disabled=locked||!ai.config?.hasKey;
    text('panel-ai-run',locked?'Reviewing…':ai.batch?'Run new AI review':'Run AI review');
    const threshold=Number($('panel-ai-threshold').value);
    const key=JSON.stringify([ai.batch,threshold,locked]);if(key===aiKey)return;aiKey=key;
    const list=$('panel-ai-results');list.replaceChildren();
    if(!ai.batch){list.append(node('p',locked?'Reviewing your screenshots…':'Run a review to see suggestions.','muted'));return;}
    const pending=(ai.batch.suggestions||[]).filter(item=>!item.status||item.status==='pending');
    const shown=pending.filter(item=>Number(item.score??item.mismatchScore??0)>=threshold);
    const status=node('div',undefined,'ai-count');status.append(node('p',`Showing ${shown.length} of ${pending.length} pending suggestions. ${pending.length-shown.length} below your filter.`));
    if(shown.length<pending.length)status.append(button(`Show all ${pending.length}`,()=>act('showAllAi'),locked));
    if(shown.length)status.append(button(`Accept all shown (${shown.length})`,()=>act('acceptAllAi'),locked));list.append(status);
    shown.forEach(item=>{
      const card=node('article',undefined,'suggestion-card');
      card.append(node('div',`${category(item.category)} · Size ${item.score??item.mismatchScore??0}/100 · ${Math.round((item.confidence||0)*100)}% confidence`,'suggestion-meta'),node('h3',item.title||'Suggested change'));
      const current=node('section');current.append(node('h4','Current'),node('p',item.comment||''));const change=node('section',undefined,'suggestion-change');change.append(node('h4','Change to'),node('p',item.expected||'No proposed change recorded.'));
      const actions=node('div',undefined,'button-row');for(const [action,label]of[['preview','Show area'],['accept','Accept comment'],['dismiss','Dismiss']])actions.append(button(label,()=>act('aiSuggestion',{suggestionAction:action,id:item.id}),locked||(action==='preview'&&!item.region)));
      card.append(current,change,actions);list.append(card);
    });
    if(ai.batch.summary||ai.batch.limitations?.length){const details=node('details',undefined,'panel-details');details.append(node('summary','Summary and limitations'));if(ai.batch.summary)details.append(node('p',ai.batch.summary));if(ai.batch.limitations?.length)details.append(node('p',ai.batch.limitations.join(' · ')));list.append(details);}
  }

  function paint() {
    document.body.dataset.composerOpen='false';
    $('dock-workspace').hidden=!session;
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session,state,busy:Boolean(pendingAction)}}));
    if(!session){clearDraft();return;}
    const starting=state?.code==='PANEL_PAGE_STARTING';
    const hasReference=Number.isInteger(session.sourceTabId);text('panel-mode','REVIEW');text('panel-title',starting?'Starting review…':state?.recording?'Recording…':'Your review');text('panel-page',session.target?.title||'Reviewed page');
    const away=!state||state.active===false||state.available===false;
    $('panel-away').hidden=!away;$('panel-live').hidden=away;
    $('panel-focus').hidden=starting;
    $('panel-recover-page').hidden=starting||!connectionLost;
    $('panel-recover-page').disabled=Boolean(pendingAction);
    text('panel-away-message',state?.message||'Return to the reviewed page to continue. Your review stays open while you switch tabs.');
    notice('panel-warning',[session.warning,state?.warning].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · '));
    $('panel-stop').disabled=starting||(Boolean(pendingAction)&&pendingAction!=='runAi')||Boolean(state?.recordingBusy);
    if(away)return;
    const view=state.view==='comment'&&!state.comment?'controls':state.view||'controls';
    $('panel-controls').hidden=view!=='controls';$('panel-composer').hidden=view!=='comment';$('panel-ai-view').hidden=view!=='ai';
    if(!state.comment)clearDraft();
    if(view==='comment'&&state.comment){document.body.dataset.composerOpen='true';paintComment(state.comment);}
    if(view==='ai')paintAi(state.ai);
    $('panel-comparison-controls').hidden=!hasReference;
    $('panel-diff').disabled=Boolean(state.diffDisabledReason)||Boolean(pendingAction);
    $('panel-diff').title=state.diffDisabledReason||(hasReference?'Choose a different reference tab':'Choose a reference tab');
    text('panel-diff-hint',state.diffDisabledReason||(hasReference?'Choose another reference with Diff. Show or hide it below.':'Choose a reference tab to compare with this page.'));
    const settings=session.settings||{};
    for(const [id,key,fallback]of[['panel-opacity','opacity',.55],['panel-reveal','reveal',50],['panel-offset-x','offsetX',0],['panel-offset-y','offsetY',0]])if(document.activeElement!==$(id))$(id).value=String(id==='panel-opacity'?Math.round((settings[key]??fallback)*100):settings[key]??fallback);
    text('panel-opacity-value',`${$('panel-opacity').value}%`);text('panel-reveal-value',`${$('panel-reveal').value}%`);$('panel-linked').checked=settings.linked!==false;$('panel-hide').setAttribute('aria-pressed',String(Boolean(settings.hidden)));text('panel-hide',settings.hidden?'Show reference':'Hide reference');
    $('panel-hide').disabled=Boolean(referenceToggle);
    const selecting=state.picking||state.areaArmed;
    const locked=state.captureBusy||state.commentSaving||state.recordingBusy||Boolean(state.recording)||Boolean(state.comment)||state.aiBusy||state.aiOperationBusy||session.aiRunning||Boolean(pendingAction);
    for(const id of ['panel-comment','panel-area'])$(id).disabled=locked;
    $('panel-comment').setAttribute('aria-pressed',String(Boolean(state.picking)));$('panel-area').setAttribute('aria-pressed',String(Boolean(state.areaArmed)));
    $('panel-ai').disabled=locked||selecting;
    $('panel-record').disabled=state.recordingBusy||state.captureBusy||state.commentSaving||Boolean(pendingAction)||(!state.recording&&(Boolean(state.comment)||selecting||state.aiBusy||session.aiRunning));
    text('panel-record',state.recording?'Stop recording':'Record page');
    $('panel-cancel-selection').hidden=!selecting;$('panel-retry').hidden=!state.pendingCaptureAction;
    notice('panel-capture-error',[state.captureDescription,state.captureError].filter(Boolean).join(' '));
    $('panel-retry').disabled=Boolean(state.captureNeedsAccess)||Boolean(pendingAction)||state.captureBusy;
    text('panel-instruction',state.captureBusy?'Capturing your selection…':state.recording?'Interact with the page, then stop recording. The clip stops automatically after 30 seconds.':state.areaArmed?'Drag across the page to select an area. Press Escape to cancel.':state.picking?'Click an element on the page. Press Escape to cancel.':'Choose an element, or hold C and drag on the page.');
    if(state.captureNeedsAccess)text('panel-instruction','Click the Diffuse icon in Chrome’s toolbar on this page, then Enable capture & return. Your drawer stays open.');
    paintComments();
  }

  const actions={'panel-diff':'openDiff','panel-comment':'selectElement','panel-area':'selectArea','panel-cancel-selection':'cancelSelection','panel-ai':'openAi','panel-close-ai':'closeAi','panel-cancel-comment':'cancelComment','panel-retry':'retryCapture','panel-focus':'focusTarget','panel-source':'focusSource','panel-reconnect':'reconnect','panel-stop':'stop'};
  for(const [id,action]of Object.entries(actions))$(id).addEventListener('click',()=>act(action,action==='cancelComment'?{draftId}:undefined));
  $('panel-record').addEventListener('click',()=>act(state?.recording?'stopRecording':'record'));
  $('panel-record-comment').addEventListener('click',()=>act('recordComment',draftFields()));
  $('panel-recover-page').addEventListener('click',()=>act('recoverPage'));
  $('panel-recover-comment').addEventListener('click',()=>act('recoverPage',{...draftFields(),evidenceChoice:state?.comment?.evidenceChoice==='recording'?'video':'screenshot'}));
  $('panel-comment-form').addEventListener('input',syncFields);
  $('panel-comment-form').addEventListener('change',syncFields);
  $('panel-comment-form').addEventListener('submit',event=>{event.preventDefault();if(event.currentTarget.reportValidity())act('saveComment',draftFields());});
  for(const choice of ['screenshot','recording'])$(`panel-evidence-${choice}`).addEventListener('click',()=>act('evidence',{choice,...draftFields()}));
  const aiFields=()=>({instructions:$('panel-ai-instructions').value,threshold:Number($('panel-ai-threshold').value)});
  $('panel-ai-instructions').addEventListener('input',()=>command('setAiFields',aiFields(),true).catch(()=>{}));
  $('panel-ai-threshold').addEventListener('input',()=>{text('panel-ai-threshold-value',`${$('panel-ai-threshold').value}/100`);command('setAiFields',aiFields(),true).catch(()=>{});});
  $('panel-ai-run').addEventListener('click',()=>act('runAi',aiFields()));
  for(const [id,key,scale]of [['panel-opacity','opacity',.01],['panel-reveal','reveal',1],['panel-offset-x','offsetX',1],['panel-offset-y','offsetY',1]])$(id).addEventListener('input',()=>{const value=Number($(id).value)*scale;if(Number.isFinite(value))command('settings',{settings:{[key]:value}},true).catch(()=>{});if(id==='panel-opacity')text('panel-opacity-value',`${$(id).value}%`);if(id==='panel-reveal')text('panel-reveal-value',`${$(id).value}%`);});
  $('panel-linked').addEventListener('change',()=>act('settings',{settings:{linked:$('panel-linked').checked}}));
  $('panel-hide').addEventListener('click',()=>{
    if(referenceToggle||!session)return;
    const toggle={sessionId:session.id,hidden:!session.settings?.hidden,commandDone:false};
    referenceToggle=toggle;paint();
    command('settings',{settings:{hidden:toggle.hidden}}).then(()=>{
      if(referenceToggle===toggle){toggle.commandDone=true;refresh();}
    }).catch(()=>{if(referenceToggle===toggle){referenceToggle=null;paint();}});
  });
  $('panel-reset').addEventListener('click',()=>act('settings',{settings:{offsetX:0,offsetY:0,reveal:50,opacity:.55}}));
  document.addEventListener('visibilitychange',()=>{port?.postMessage({type:'VISIBILITY',visible:!document.hidden});if(!document.hidden){loadTabs().then(renderSession).catch(()=>{});refresh();}});
  window.addEventListener('diffuse-refresh',refresh);
  window.addEventListener('pagehide',()=>{stopped=true;port?.disconnect();});
  chrome.tabs.onActivated.addListener(info=>{if(info.windowId===panelWindowId){loadTabs().then(()=>{renderSession();refresh();}).catch(()=>{});}});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(id===sourceTab?.id&&(change.url||change.status==='complete'))loadTabs().then(refresh).catch(()=>{});});
  chrome.windows.getCurrent().then(window=>{panelWindowId=window.id;connect();refresh();}).catch(error=>notice('feedback',error.message));
  setInterval(()=>{if(!document.hidden)refresh();},1000);
})();
