export const VIEWPORT_PRESETS = Object.freeze({
  desktop: Object.freeze({width:1440,height:900}),
  laptop: Object.freeze({width:1280,height:800}),
  tablet: Object.freeze({width:1024,height:768}),
  phone: Object.freeze({width:390,height:844}),
});

// Responsive CSS viewports, deliberately without mobile UA or touch emulation.
export function createViewportController({chromeApi, assertPageAccess, onOwnershipChanged=async()=>{}, onDetached=async()=>{}}) {
  const owned=new Set();let selected=null,queue=Promise.resolve(),generation=0;
  const serial=operation=>{const result=queue.catch(()=>{}).then(operation);queue=result.catch(()=>{});return result;};
  const command=(tabId,method,params={})=>chromeApi.debugger.sendCommand({tabId},method,params);
  const save=()=>onOwnershipChanged([...owned]);
  const metrics=preset=>({...VIEWPORT_PRESETS[preset],deviceScaleFactor:0,mobile:false,scale:1});
  async function release(tabId){
    if(!owned.delete(tabId))return;
    // Remove ownership before detach: Chrome also emits onDetach for our cleanup.
    await command(tabId,'Emulation.clearDeviceMetricsOverride').catch(()=>{});
    await chromeApi.debugger.detach({tabId}).catch(()=>{});
    await save();
  }
  async function clear(){for(const tabId of [...owned])await release(tabId);selected=null;}
  async function applyNow(tabs,preset){
    if(preset!==null&&!Object.hasOwn(VIEWPORT_PRESETS,preset))throw new Error('Choose Desktop, Laptop, Tablet, Phone, or the native page size.');
    if(preset===null){await clear();return null;}
    if(!chromeApi.debugger)throw new Error('Reload the updated Diffuse extension to enable viewport presets.');
    const ids=[...new Set([tabs.targetTabId,tabs.sourceTabId].filter(Number.isInteger))];
    if(!ids.length)throw new Error('Start a review before choosing its viewport.');
    const previous=selected,before=new Set(owned),epoch=generation;
    // Validate every page before attaching to any of them.
    for(const tabId of ids)await assertPageAccess((await chromeApi.tabs.get(tabId)).url,chromeApi);
    const targets=await chromeApi.debugger.getTargets();
    for(const tabId of ids)if(!owned.has(tabId)&&targets.some(target=>target.tabId===tabId&&target.attached))throw new Error('Close DevTools or another debugger on both review pages before changing the viewport.');
    try{
      for(const tabId of ids){
        if(!owned.has(tabId)){
          try{await chromeApi.debugger.attach({tabId},'1.3');}catch{throw new Error('Chrome could not resize this page. Close DevTools or another debugger and try again.');}
          owned.add(tabId);await save();
        }
        if(generation!==epoch)throw new Error('Viewport control was disconnected. Choose the preset again.');
        await command(tabId,'Emulation.setDeviceMetricsOverride',metrics(preset));
        // Hidden captured pages can report the new innerWidth while retaining
        // the old painted layout. Flush layout before their next video frame.
        await command(tabId,'Runtime.evaluate',{
          expression:'new Promise(resolve => { const done = () => resolve(true); const timer = setTimeout(done, 500); document.documentElement.getBoundingClientRect(); document.body?.getBoundingClientRect(); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(); })); })',
          awaitPromise:true,returnByValue:true,timeout:1500,
        });
      }
      if(generation!==epoch)throw new Error('Viewport control was disconnected. Choose the preset again.');
      for(const tabId of [...owned])if(!ids.includes(tabId))await release(tabId);
      selected=preset;return preset;
    }catch(error){
      let restored=true;
      for(const tabId of [...owned]){
        if(!before.has(tabId)){await release(tabId);continue;}
        try{await command(tabId,previous?'Emulation.setDeviceMetricsOverride':'Emulation.clearDeviceMetricsOverride',previous?metrics(previous):{});}catch{restored=false;}
      }
      if(!restored)await clear();else selected=previous;
      throw error;
    }
  }
  return {
    get preset(){return selected;},
    ownedTabIds:()=>[...owned],
    apply:(tabs,preset)=>serial(()=>applyNow(tabs,preset)),
    restore:()=>serial(clear),
    releaseTab:tabId=>serial(()=>release(tabId)),
    resume:session=>serial(async()=>{
      if(!session?.viewportDebuggerTabs?.length)return null;
      if(!chromeApi.debugger)return null;
      const targets=await chromeApi.debugger.getTargets();
      for(const tabId of session.viewportDebuggerTabs){
        if(!Number.isInteger(tabId)||!targets.some(target=>target.tabId===tabId&&target.attached))continue;
        // sendCommand succeeds only for an attachment owned by this extension.
        try{await command(tabId,'Runtime.evaluate',{expression:'void 0',returnByValue:true});owned.add(tabId);}catch{}
      }
      const expected=[session.targetTabId,session.sourceTabId].filter(Number.isInteger);
      if(!Object.hasOwn(VIEWPORT_PRESETS,session.viewportPreset)||expected.some(id=>!owned.has(id))){await clear();return null;}
      selected=session.viewportPreset;
      try{return await applyNow(session,selected);}catch{await clear();return null;}
    }),
    externalDetach:(source,reason)=>{
      if(!owned.delete(source?.tabId))return Promise.resolve(false);
      generation++;
      return serial(async()=>{await clear();await save();await onDetached(reason);return true;});
    },
  };
}
