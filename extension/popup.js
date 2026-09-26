"use strict";

// Shared launch surface for Chrome's action popup and the native drawer.
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
let sourceTab=null, session=null, busy=false, reviewWindowId=null;
let pageHelpers=null, currentPageAccess=null, tabLoadVersion=0;
const pageHelpersReady=import('./core.mjs').then(helpers=>{pageHelpers=helpers;return helpers;});
const isSidePanel=document.body.dataset.surface==='sidepanel';
const isWebTab=tab=>Boolean(tab&&pageHelpers?.isReviewableUrl(tab.url));
function pageLocation(url){return pageHelpers?.pageLocation(url)||'Page unavailable';}
function setPageDetails(titleElement,urlElement,page,fallback){titleElement.textContent=page?.title||fallback;titleElement.title=page?.title||fallback;urlElement.textContent=pageLocation(page?.url);urlElement.title=page?.url||'';}
function showError(message){ui.feedback.textContent=message||'';ui.feedback.hidden=!message;if(message)ui.feedback.focus();}
function describeError(error){const message=error?.message||String(error||'Something went wrong.');return /receiving end does not exist|could not establish connection|message port closed|extension context invalidated/i.test(message)?'Diffuse couldn’t connect. Close and reopen it to retry.':message;}
async function sendMessage(type,payload={}){const response=await chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type,...payload});if(!response||response.ok!==true)throw new Error(response?.error||'Diffuse didn’t respond. Reopen it and try again.');return response;}
function openSidebar(windowId=(session?reviewWindowId:null)??sourceTab?.windowId){
  if(!Number.isInteger(windowId)||!chrome.sidePanel?.open)throw new Error('The review sidebar requires Chrome 116 or later. Open Diffuse from a Chrome page to continue.');
  // Keep this call in the original click/submit stack: Chrome requires a user gesture.
  return chrome.sidePanel.open({windowId});
}
function finishAction(){if(!isSidePanel)window.close();else{renderSession();window.dispatchEvent(new Event('diffuse-refresh'));}}
function setBusy(value,action){busy=value;ui.popup.setAttribute('aria-busy',String(value));ui['start-comparison'].disabled=value||!currentPageAccess?.allowed;ui['start-comparison'].querySelector('.button-label').textContent=value&&action==='start'?'Starting review…':'Start review';ui['return-to-comparison'].disabled=value||!session;ui['enable-capture'].disabled=value||sourceTab?.id!==session?.targetTabId||!session||!currentPageAccess?.allowed;ui['stop-comparison'].disabled=value||!session;ui['review-reports'].disabled=value;ui['ai-settings'].disabled=value;ui['jira-settings'].disabled=value;ui['open-file-settings'].disabled=value;ui['refresh-file-access'].disabled=value;}
function renderPageAccess(){const needsAccess=Boolean(currentPageAccess?.needsFileAccess);ui['file-access-notice'].hidden=!needsAccess;ui['file-access-description'].textContent=needsAccess?currentPageAccess.message:'';ui['page-access-message'].hidden=!currentPageAccess||currentPageAccess.supported;ui['page-access-message'].textContent=currentPageAccess&&!currentPageAccess.supported?currentPageAccess.message:'';}
function renderSession(){
  ui.loading.hidden=true;ui.setup.hidden=Boolean(session);ui['session-panel'].hidden=!session||isSidePanel;ui.popup.classList.toggle('has-session',Boolean(session));
  ui['edition-label'].textContent='DESIGN REVIEW';
  ui['report-count'].textContent=session?`${session.commentCount||0} comments in this review`:'Saved on this device';
  renderPageAccess();
  if(!session){setBusy(busy);return;}
  const hasReference=Boolean(session.sourceTabId);const error=Boolean(session.error)||session.status==='error';
  ui['session-title'].textContent=error?'Your review needs attention.':'Your review is ready.';
  ui['session-subtitle'].textContent=hasReference?'Live reference connected.':'Open the sidebar to add comments or compare with a reference.';
  ui['session-prototype'].hidden=!hasReference;ui['session-divider'].hidden=!hasReference;ui['session-target-label'].textContent='REVIEWED PAGE';
  ui['session-status-label'].textContent=error?'Connection interrupted':hasReference?'Diff connected':'Review ready';ui['session-status'].dataset.status=error?'error':'live';
  setPageDetails(ui['session-source-title'],ui['session-source-url'],session.source,'Reference');setPageDetails(ui['session-target-title'],ui['session-target-url'],session.target,'Page');
  ui['session-error'].textContent=session.error||'';ui['session-error'].hidden=!session.error;
  const onPage=sourceTab?.id===session.targetTabId;
  ui['capture-notice'].hidden=!onPage;ui['capture-state'].hidden=!session.captureReady;ui['enable-capture'].hidden=!onPage;ui['return-to-comparison'].hidden=false;
  ui['return-to-comparison'].querySelector('.button-label').textContent='Open review sidebar';ui['stop-comparison'].textContent='Stop review';setBusy(busy);
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
ui['jira-settings'].addEventListener('click',async()=>{if(busy)return;try{await chrome.tabs.create({url:chrome.runtime.getURL('jira-settings.html')});finishAction();}catch(error){showError(describeError(error));}});
window.addEventListener('focus',()=>{if(pageHelpers&&!busy)loadTabs().then(renderSession).catch(()=>{});});
for(const [id,type]of [['review-reports','OPEN_REPORT'],['ai-settings','OPEN_AI_SETTINGS']])ui[id].addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{await sendMessage(type);finishAction();}catch(error){showError(describeError(error));}finally{setBusy(false);}});
ui['stop-comparison'].addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{await sendMessage('STOP_SESSION');session=null;await loadTabs();renderSession();window.dispatchEvent(new Event('diffuse-refresh'));}catch(error){showError(describeError(error));}finally{setBusy(false);}});
for(const [id,type]of [['return-to-comparison','FOCUS_TARGET'],['enable-capture','ENABLE_EVIDENCE']])ui[id].addEventListener('click',async()=>{if(busy)return;showError('');setBusy(true);try{const drawer=isSidePanel?Promise.resolve():openSidebar();await Promise.all([drawer,sendMessage(type)]);finishAction();}catch(error){showError(describeError(error));}finally{setBusy(false);}});
ui['open-side-panel']?.addEventListener('click',()=>{if(busy)return;try{openSidebar().then(()=>window.close(),error=>showError(describeError(error)));}catch(error){showError(describeError(error));}});
async function initialize(){setBusy(true);try{const [result,tabs]=await Promise.allSettled([sendMessage('GET_SESSION'),loadTabs()]);if(result.status==='fulfilled'){session=result.value.session||null;if(Number.isInteger(session?.targetTabId)){try{reviewWindowId=(await chrome.tabs.get(session.targetTabId)).windowId;}catch{reviewWindowId=null;}}}else showError(describeError(result.reason));if(tabs.status==='rejected')showError(describeError(tabs.reason));renderSession();}catch(error){ui.loading.hidden=true;ui.setup.hidden=false;showError(describeError(error));}finally{setBusy(false);}}
initialize();
