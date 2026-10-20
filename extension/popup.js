"use strict";

// Shared launch surface for Chrome's action popup and the native drawer.
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
let sourceTab=null, session=null, busy=false, reviewWindowId=null;
let pageHelpers=null, currentPageAccess=null, tabLoadVersion=0;
const pageHelpersReady=import('./core.mjs').then(helpers=>{pageHelpers=helpers;return helpers;});
const isSidePanel=document.body.dataset.surface==='sidepanel';
const isWebTab=tab=>Boolean(tab&&pageHelpers?.isReviewableUrl(tab.url));
function pageLocation(url){return pageHelpers?.pageLocation(url)||'Page unavailable';}
function setPageDetails(titleElement,urlElement,page,fallback){if(titleElement){titleElement.textContent=page?.title||fallback;titleElement.title=page?.title||fallback;}if(urlElement){urlElement.textContent=pageLocation(page?.url);urlElement.title=page?.url||'';}}
function showError(message){ui.feedback.textContent=message||'';ui.feedback.hidden=!message;if(message)ui.feedback.focus();}
function describeError(error){const message=error?.message||String(error||'Something went wrong.');return /receiving end does not exist|could not establish connection|message port closed|extension context invalidated/i.test(message)?'Diffuse couldn’t connect. Close and reopen it to retry.':message;}
async function sendMessage(type,payload={}){const response=await chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type,...payload});if(!response||response.ok!==true)throw Object.assign(new Error(response?.error||'Diffuse didn’t respond. Reopen it and try again.'),{code:response?.code,pageUrl:response?.pageUrl});return response;}
function openSidebar(windowId=(session?reviewWindowId:null)??sourceTab?.windowId){
  if(!Number.isInteger(windowId)||!chrome.sidePanel?.open)throw new Error('The review sidebar requires Chrome 116 or later. Open Diffuse from a Chrome page to continue.');
  // Keep this call in the original click/submit stack: Chrome requires a user gesture.
  return chrome.sidePanel.open({windowId});
}
function finishAction(){if(!isSidePanel)window.close();else{renderSession();window.dispatchEvent(new Event('diffuse-refresh'));}}
function setBusy(value,action){
  busy=value;ui.popup.setAttribute('aria-busy',String(value));
  ui['start-comparison'].disabled=value||!currentPageAccess?.allowed;
  ui['start-comparison'].querySelector('.button-label').textContent=value&&action==='start'?'Starting…':'Start Diffuse';
  ui['return-to-comparison'].disabled=value||!session;
  if(ui['enable-capture'])ui['enable-capture'].disabled=value||sourceTab?.id!==session?.targetTabId||!session||!currentPageAccess?.allowed;
  if(ui['stop-comparison'])ui['stop-comparison'].disabled=value||!session;
  for(const id of ['load-review','review-reports','settings','open-file-settings','refresh-file-access'])ui[id].disabled=value;
}
function renderPageAccess(){const needsAccess=Boolean(currentPageAccess?.needsFileAccess);ui['file-access-notice'].hidden=!needsAccess;ui['file-access-description'].textContent=needsAccess?currentPageAccess.message:'';ui['page-access-message'].hidden=!currentPageAccess||currentPageAccess.supported;ui['page-access-message'].textContent=currentPageAccess&&!currentPageAccess.supported?currentPageAccess.message:'';}
function renderSession(){
  ui.loading.hidden=true;ui.setup.hidden=Boolean(session);ui['session-panel'].hidden=!session||isSidePanel;ui.popup.classList.toggle('has-session',Boolean(session));
  if(ui['edition-label'])ui['edition-label'].textContent='DESIGN REVIEW';
  if(ui['report-count'])ui['report-count'].textContent=session?`${session.commentCount||0} comments in this review`:'Saved on this device';
  if(ui['launcher-state'])ui['launcher-state'].textContent=session?'Review in progress':'Page feedback';
  renderPageAccess();
  if(!session){setBusy(busy);return;}
  const hasReference=Boolean(session.sourceTabId);const error=Boolean(session.error)||session.status==='error';
  if(ui['session-title'])ui['session-title'].textContent=error?'Your review needs attention.':'Your review is ready.';
  ui['session-subtitle'].textContent=isSidePanel?(hasReference?'Live reference connected.':'Open the sidebar to continue.'):sourceTab?.id===session.targetTabId?'Continue on this page':`Return to your reviewed page`;
  if(ui['session-prototype'])ui['session-prototype'].hidden=!hasReference;
  if(ui['session-divider'])ui['session-divider'].hidden=!hasReference;
  if(ui['session-target-label'])ui['session-target-label'].textContent='REVIEWED PAGE';
  if(ui['session-status-label'])ui['session-status-label'].textContent=error?'Connection interrupted':hasReference?'Diff connected':'Review ready';
  if(ui['session-status'])ui['session-status'].dataset.status=error?'error':'live';
  setPageDetails(ui['session-source-title'],ui['session-source-url'],session.source,'Reference');setPageDetails(ui['session-target-title'],ui['session-target-url'],session.target,'Page');
  ui['session-error'].textContent=session.error||'';ui['session-error'].hidden=!session.error;
  const onPage=sourceTab?.id===session.targetTabId;
  if(ui['capture-notice'])ui['capture-notice'].hidden=!onPage;
  if(ui['capture-state'])ui['capture-state'].hidden=!session.captureReady;
  if(ui['enable-capture'])ui['enable-capture'].hidden=!onPage;
  ui['return-to-comparison'].hidden=false;
  ui['return-to-comparison'].querySelector('.button-label').textContent='Start Diffuse';
  if(ui['stop-comparison'])ui['stop-comparison'].textContent='Stop review';setBusy(busy);
}
async function loadTabs(){const version=++tabLoadVersion;currentPageAccess=null;setBusy(busy);await pageHelpersReady;const tabs=await chrome.tabs.query({active:true,currentWindow:true});const selected=tabs[0]||null;const access=await pageHelpers.pageAccess(selected?.url);if(version!==tabLoadVersion)return;sourceTab=selected;currentPageAccess=access;setPageDetails(ui['source-title'],ui['source-url'],sourceTab,'Open a page to review');renderPageAccess();setBusy(busy);}
ui['comparison-form'].addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!isWebTab(sourceTab)||!currentPageAccess?.allowed)return;showError('');setBusy(true,'start');
  try{
    // Both browser permission and drawer opening must begin before the first await.
    const drawer=isSidePanel?Promise.resolve():openSidebar(sourceTab.windowId);
    const access=pageHelpers.requestPageAccess(sourceTab.url);
    const [granted]=await Promise.all([access,drawer]);
    if(!granted){showError('Allow access to this page to start your review.');return;}
    session=(await sendMessage('START_AUDIT',{targetTabId:sourceTab.id})).session||null;finishAction();
  }catch(error){showError(describeError(error));await loadTabs();}finally{setBusy(false);}
});
ui['open-file-settings'].addEventListener('click',async()=>{try{await chrome.tabs.create({url:pageHelpers.extensionSettingsUrl(chrome.runtime.id)});if(!isSidePanel)window.close();}catch(error){showError(describeError(error));}});
ui['refresh-file-access'].addEventListener('click',()=>loadTabs().then(renderSession).catch(error=>showError(describeError(error))));
window.addEventListener('focus',()=>{if(pageHelpers&&!busy)loadTabs().then(renderSession).catch(()=>{});});
for(const [id,type]of [['review-reports','OPEN_REPORT'],['settings','OPEN_SETTINGS']])ui[id].addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{await sendMessage(type);finishAction();}catch(error){showError(describeError(error));}finally{setBusy(false);}});
ui['load-review'].addEventListener('click',async()=>{
  if(busy)return;showError('');
  if(isSidePanel){window.dispatchEvent(new CustomEvent('diffuse-load-review',{detail:{targetTabId:sourceTab?.id,windowId:sourceTab?.windowId}}));return;}
  setBusy(true);
  try{
    const windowId=sourceTab?.windowId;
    if(!Number.isInteger(windowId))throw new Error('Open Diffuse on the site you want to review.');
    // Save the launch context before opening the drawer, which can close the popup.
    const intent=chrome.storage.session.set({[`diffuseReviewLoader:${windowId}`]:{targetTabId:sourceTab.id,nonce:Date.now()}});
    const drawer=openSidebar(windowId);
    await Promise.all([intent,drawer]);finishAction();
  }catch(error){showError(describeError(error));}finally{setBusy(false);}
});
ui['stop-comparison']?.addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{await sendMessage('STOP_SESSION');session=null;await loadTabs();renderSession();window.dispatchEvent(new Event('diffuse-refresh'));}catch(error){showError(describeError(error));}finally{setBusy(false);}});
for(const [id,type]of [['return-to-comparison','FOCUS_TARGET'],['enable-capture','ENABLE_EVIDENCE']])ui[id]?.addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{const drawer=isSidePanel?Promise.resolve():openSidebar();const operation=!isSidePanel&&id==='return-to-comparison'&&sourceTab?.id===session?.targetTabId?'ENABLE_EVIDENCE':type;await Promise.all([drawer,sendMessage(operation)]);finishAction();}catch(error){showError(describeError(error));}finally{setBusy(false);}});
ui['open-side-panel']?.addEventListener('click',()=>{if(busy)return;try{openSidebar().then(()=>window.close(),error=>showError(describeError(error)));}catch(error){showError(describeError(error));}});
async function initialize(){setBusy(true);try{const [result,tabs]=await Promise.allSettled([sendMessage('GET_SESSION'),loadTabs()]);if(result.status==='fulfilled'){session=result.value.session||null;if(Number.isInteger(session?.targetTabId)){try{reviewWindowId=(await chrome.tabs.get(session.targetTabId)).windowId;}catch{reviewWindowId=null;}}}else showError(describeError(result.reason));if(tabs.status==='rejected')showError(describeError(tabs.reason));renderSession();}catch(error){ui.loading.hidden=true;ui.setup.hidden=false;showError(describeError(error));}finally{setBusy(false);}}
initialize();
