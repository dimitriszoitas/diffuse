'use strict';
const ui=Object.fromEntries([...document.querySelectorAll('[id]')].map(node=>[node.id,node]));
const sessionId=new URL(location.href).searchParams.get('session');
let tabs=[],session=null,busy=false,busyReason=null,requestId=null,finished=false;
async function send(type,data={}){const response=await chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type,sessionId,...data});if(!response?.ok)throw new Error(response?.error||'Your review is unavailable. Reopen Diff from the page toolbar.');return response;}
function feedback(message){ui['diff-feedback'].textContent=message||'';ui['diff-feedback'].hidden=!message;}
function controls(){ui['connect-reference'].disabled=busy||Boolean(busyReason)||!tabs.some(tab=>tab.id===Number(ui['reference-tab'].value));ui['reference-tab'].disabled=busy;ui['refresh-reference-tabs'].disabled=busy;ui['remove-reference'].disabled=busy||Boolean(busyReason);ui['close-diff'].disabled=busy;ui['connect-reference'].textContent=busy?'Waiting for Chrome…':session?.sourceTabId?'Change reference':'Connect reference';}
async function load(){
  try{
    const previous=ui['reference-tab'].value;const result=await send('GET_DIFF_CONTEXT');session=result.session;tabs=result.tabs||[];busyReason=result.busyReason||null;
    ui['reviewed-page'].textContent=`Reviewing: ${session?.target?.title||'Current page'}`;ui['reference-tab'].replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=tabs.length?'Choose an open tab':'Open a reference in another tab';ui['reference-tab'].append(placeholder);
    for(const tab of tabs){const option=document.createElement('option');option.value=String(tab.id);let host='';try{host=new URL(tab.url).host;}catch{}option.textContent=`${tab.title||'Untitled page'} · ${host}`;ui['reference-tab'].append(option);}
    const selected=tabs.find(tab=>String(tab.id)===previous)||tabs.find(tab=>tab.id===session?.sourceTabId)||(tabs.length===1?tabs[0]:null);if(selected)ui['reference-tab'].value=String(selected.id);
    ui['remove-reference'].hidden=!session?.sourceTabId;feedback(busyReason);controls();
  }catch(error){busyReason=error.message;feedback(error.message);controls();}
}
ui['reference-tab'].addEventListener('change',()=>{feedback(busyReason);controls();});
ui['refresh-reference-tabs'].addEventListener('click',load);
ui['close-diff'].addEventListener('click',()=>window.close());
ui['reference-form'].addEventListener('submit',async event=>{
  event.preventDefault();if(busy||busyReason)return;
  const source=tabs.find(tab=>tab.id===Number(ui['reference-tab'].value));if(!source)return;
  busy=true;feedback('');controls();
  try{
    const url=new URL(source.url);const granted=await chrome.permissions.request({origins:[`${url.protocol}//${url.hostname}/*`]});
    if(!granted)throw new Error('Allow access to the selected reference to compare it. Your current review has not changed.');
    const prepared=await send('PREPARE_REFERENCE',{sourceTabId:source.id});requestId=prepared.requestId;
    const result=await send('ATTACH_REFERENCE',{requestId});
    if(result.cancelled){feedback('Tab sharing cancelled. Your review has not changed.');return;}
    finished=true;window.close();
  }catch(error){feedback(error.message);}finally{busy=false;requestId=null;controls();}
});
ui['remove-reference'].addEventListener('click',async()=>{
  if(busy||busyReason)return;busy=true;controls();feedback('');try{await send('DETACH_REFERENCE');finished=true;window.close();}catch(error){feedback(error.message);}finally{busy=false;controls();}
});
window.addEventListener('pagehide',()=>{if(requestId&&!finished)chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type:'CANCEL_REFERENCE',sessionId,requestId}).catch(()=>{});});
load();
