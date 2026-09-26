/* Diffuse-owned select presentation. No host-page prototype or select changes. */
(() => {
  if (globalThis.DiffuseSelect) return;
  const managers = new WeakMap();
  let serial = 0;
  const css = `
.df-select-native{position:absolute!important;width:1px!important;height:1px!important;min-width:0!important;min-height:0!important;padding:0!important;margin:-1px!important;border:0!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important}
.df-select,.df-severity{--ds-bg:#fff;--ds-ink:#211a35;--ds-muted:#625870;--ds-line:#8a7b9b;--ds-focus:#6941c6;--ds-option:#eee7fa;--ds-shadow:#211a352b;position:relative;display:block;min-width:0;width:100%;font:inherit;color:var(--ds-ink)}
[data-diffuse-select-theme=dark]{--ds-bg:#171122;--ds-ink:#fcfaff;--ds-muted:#d2c7df;--ds-line:#9381ae;--ds-focus:#c9adff;--ds-option:#403050;--ds-shadow:#120c2460}
.df-select-label{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important}
.df-select-trigger{appearance:none!important;display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 12px!important;border:1px solid var(--ds-line)!important;border-radius:9px!important;background:var(--ds-bg)!important;color:var(--ds-ink)!important;font:inherit!important;font-size:14px!important;line-height:1.45!important;text-align:left!important;cursor:pointer;box-shadow:none}
.df-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.df-select-chevron{width:18px!important;height:18px!important;flex:0 0 18px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transition:transform .12s}.df-select-trigger[aria-expanded=true] .df-select-chevron{transform:rotate(180deg)}
.df-select-trigger:hover:not(:disabled){border-color:var(--ds-focus)!important}.df-select-trigger:focus-visible,.df-severity input:focus-visible+span{outline:3px solid var(--ds-focus)!important;outline-offset:3px!important}.df-select-trigger:disabled{opacity:.55!important;cursor:default}.df-select-trigger[aria-invalid=true]{border-color:#b33628!important}
.df-select-menu{--ds-bg:#fff;--ds-ink:#211a35;--ds-muted:#625870;--ds-line:#8a7b9b;--ds-focus:#6941c6;--ds-option:#eee7fa;--ds-shadow:#211a352b;position:fixed!important;inset:auto!important;margin:0!important;padding:5px!important;min-width:0;max-width:calc(100vw - 16px);max-height:300px;overflow:auto!important;overscroll-behavior:contain;border:1px solid var(--ds-line)!important;border-radius:10px!important;background:var(--ds-bg)!important;color:var(--ds-ink)!important;box-shadow:0 8px 28px var(--ds-shadow)!important;z-index:2147483647!important;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important;box-sizing:border-box;pointer-events:auto!important}
.df-select-menu[data-diffuse-select-theme=dark]{--ds-bg:#241c35;--ds-ink:#fcfaff;--ds-muted:#d2c7df;--ds-line:#9381ae;--ds-focus:#c9adff;--ds-option:#403050;--ds-shadow:#120c2460}.df-select-menu[hidden]{display:none!important}.df-select-menu::backdrop{background:transparent;pointer-events:none}
.df-select-option{display:flex;align-items:center;gap:10px;min-height:40px;padding:8px 10px;border-radius:6px;cursor:pointer;box-sizing:border-box;overflow-wrap:anywhere}.df-select-option[data-active=true]{background:var(--ds-option);outline:1px solid var(--ds-focus);outline-offset:-1px}.df-select-option[aria-selected=true]{font-weight:650}.df-select-option[aria-disabled=true]{opacity:.5;cursor:default}.df-select-check{flex:0 0 16px;width:16px;font-weight:750;color:var(--ds-focus)}.df-select-group{padding:8px 10px 4px;font-size:12px;font-weight:700;color:var(--ds-muted)}.df-select-empty{padding:12px;color:var(--ds-muted)}.df-select-error{display:block;font-size:13px;line-height:1.45;color:#b33628;margin-top:6px}.df-select-error[hidden]{display:none}.df-select[data-diffuse-select-theme=dark] .df-select-error{color:#ffb6ac}
.df-severity-options{display:flex;flex-wrap:wrap;gap:6px;width:100%;min-width:0}.df-severity-choice{position:relative!important;display:flex!important;flex:1 1 78px!important;min-width:0!important;gap:0!important;margin:0!important;cursor:pointer!important}.df-severity-choice input{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;min-width:0!important;opacity:0!important;padding:0!important;margin:0!important}.df-severity-choice>span{display:flex;align-items:center;justify-content:center;gap:7px;min-height:44px;width:100%;padding:8px 9px;border:1px solid var(--ds-line);border-radius:8px;color:var(--ds-ink);background:var(--ds-bg);font:500 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box}.df-severity-choice>span:before{content:'';width:12px;height:12px;box-sizing:border-box;border:1.5px solid currentColor;border-radius:50%;flex-shrink:0}.df-severity-choice input:checked+span:before{border-width:4px}.df-severity-choice[data-value=minor] input:checked+span{background:#e6f1ff;border-color:#3174bd;color:#164c8c}.df-severity-choice[data-value=major] input:checked+span{background:#fff0cc;border-color:#ad7500;color:#774800}.df-severity-choice[data-value=critical] input:checked+span{background:#ffe4e4;border-color:#bd4646;color:#9c2626}.df-severity-choice input:disabled+span{opacity:.55;cursor:default}
@media(prefers-reduced-motion:reduce){.df-select-chevron{transition:none}}@media(forced-colors:active){.df-select-trigger,.df-select-menu,.df-severity-choice>span{border-color:ButtonText!important}.df-select-option[data-active=true]{outline-color:Highlight}.df-select-check{color:ButtonText}}
`;
  const make = (document,tag,className,text) => { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; };
  const contains = (root,node) => root===node || root.contains(node);
  const disabled = select => select.disabled || select.matches(':disabled');
  function enhance(root = document, {theme = root instanceof ShadowRoot ? 'dark' : 'light'} = {}) {
    if(managers.has(root)){managers.get(root).refresh();return()=>destroy(root);}
    const document=root.ownerDocument||root,view=document.defaultView,abort=new AbortController(),items=new Map();
    const style=make(document,'style');style.dataset.diffuseSelectStyle='';style.textContent=css;(root.head||root).append(style);
    const manager={root,items,style,abort,theme,open:null,refresh:()=>{discover(root);for(const item of items.values())item.sync();}};
    managers.set(root,manager);
    const listen=(node,type,handler,options={})=>node.addEventListener(type,handler,{...options,signal:abort.signal});
    function labelFor(select){
      if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
      return [...(select.labels||[])].map(label=>{const copy=label.cloneNode(true);copy.querySelectorAll('select,.df-select,.df-severity,small').forEach(node=>node.remove());return copy.textContent.trim();}).filter(Boolean).join(' ')||select.title||'Choose an option';
    }
    function instrument(node,key,onSet,owned){
      const own=Object.getOwnPropertyDescriptor(node,key);let descriptor=own,proto=node;
      while(!descriptor&&(proto=Object.getPrototypeOf(proto)))descriptor=Object.getOwnPropertyDescriptor(proto,key);
      if(!descriptor?.get||!descriptor?.set||own?.configurable===false)return;
      try{Object.defineProperty(node,key,{configurable:true,enumerable:descriptor.enumerable,get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);onSet();}});owned.push(()=>{if(own)Object.defineProperty(node,key,own);else delete node[key];});}catch{}
    }
    function build(select){
      if(items.has(select)||select.dataset.diffuseSelectIgnore!==undefined)return;
      const id=`diffuse-select-${++serial}`,severity=select.name==='severity'||/severity$/.test(select.id),wrapper=make(document,'div',severity?'df-severity':'df-select');
      wrapper.dataset.diffuseSelectTheme=theme;wrapper.dataset.diffuseSelectFor=select.id||id;
      const label=make(document,'span','df-select-label');label.id=`${id}-label`;wrapper.append(label);
      const error=make(document,'span','df-select-error');error.id=`${id}-error`;error.hidden=true;error.setAttribute('role','alert');
      const original={tabindex:select.getAttribute('tabindex'),ariaHidden:select.getAttribute('aria-hidden')};
      select.classList.add('df-select-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');select.after(wrapper);
      const restorers=[],optionRestorers=new Map();let trigger=null,menu=null,active=-1,typing='',typedAt=0,signature='',syncing=false,radios=[];
      const optionDisabled=option=>option.disabled||option.parentElement?.disabled===true;
      const item={select,wrapper,sync,position,close,dispose};items.set(select,item);
      function associate(node){node.removeAttribute('aria-labelledby');node.setAttribute('aria-label',labelFor(select));const described=[select.getAttribute('aria-describedby'),error.id].filter(Boolean).join(' ');node.setAttribute('aria-describedby',described);if(select.hasAttribute('aria-labelledby')){node.removeAttribute('aria-label');node.setAttribute('aria-labelledby',select.getAttribute('aria-labelledby'));}}
      function dispatch(){select.dispatchEvent(new Event('input',{bubbles:true,composed:true}));select.dispatchEvent(new Event('change',{bubbles:true,composed:true}));}
      function changed(){if(error.hidden===false&&select.validity.valid){error.hidden=true;trigger?.removeAttribute('aria-invalid');}sync();}
      function buildRadios(){
        wrapper.querySelector('.df-severity-options')?.remove();radios=[];const group=make(document,'div','df-severity-options');group.setAttribute('role','radiogroup');associate(group);
        for(const option of select.options){const choice=make(document,'label','df-severity-choice');choice.dataset.value=option.value;const radio=make(document,'input');radio.type='radio';radio.name=`${id}-severity`;radio.value=option.value;radio.setAttribute('form',`${id}-presentation-only`);radio.setAttribute('aria-label',option.label);const text=make(document,'span',null,option.label);choice.append(radio,text);group.append(choice);radios.push(radio);listen(radio,'change',()=>{if(!radio.checked||disabled(select)||optionDisabled(option))return;select.value=radio.value;dispatch();});}
        wrapper.insertBefore(group,error);
      }
      function sync(){
        if(syncing)return;syncing=true;
        try{
          for(const [option,restore]of optionRestorers)if(![...select.options].includes(option)){restore.forEach(fn=>fn());optionRestorers.delete(option);}
          for(const option of select.options)if(!optionRestorers.has(option)){const own=[];instrument(option,'selected',changed,own);optionRestorers.set(option,own);}
          label.textContent=labelFor(select);
          const next=JSON.stringify([...select.options].map(option=>[option.value,option.label,optionDisabled(option),option.hidden,option.parentElement?.localName==='optgroup'?option.parentElement.label:'']));
          if(severity){
            if(next!==signature){signature=next;buildRadios();}
            radios.forEach((radio,index)=>{radio.checked=select.options[index]?.selected||false;radio.disabled=disabled(select)||optionDisabled(select.options[index]);radio.required=select.required;});
          }else{
            associate(trigger);trigger.disabled=disabled(select);trigger.setAttribute('aria-required',String(select.required));
            const names=[...select.selectedOptions].map(option=>option.label);trigger.querySelector('.df-select-value').textContent=names.length?names.join(', '):'Choose an option';
            if(disabled(select))close();
            if(menu&&!menu.hidden){renderOptions();position();}
          }
          if(select.validity.valid){error.hidden=true;trigger?.removeAttribute('aria-invalid');}
        }finally{syncing=false;}
      }
      function available(){return [...select.options].map((option,index)=>({option,index})).filter(({option})=>!option.hidden&&!optionDisabled(option));}
      function renderOptions(){
        menu.replaceChildren();menu.setAttribute('aria-multiselectable',String(select.multiple));let previousGroup;
        [...select.options].forEach((option,index)=>{
          if(option.hidden)return;const group=option.parentElement?.localName==='optgroup'?option.parentElement.label:null;
          if(group&&group!==previousGroup){const heading=make(document,'div','df-select-group',group);heading.setAttribute('role','presentation');menu.append(heading);}previousGroup=group;
          const row=make(document,'div','df-select-option');row.id=`${id}-option-${index}`;row.dataset.index=String(index);row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.selected));row.setAttribute('aria-disabled',String(optionDisabled(option)));row.dataset.active=String(index===active);const check=make(document,'span','df-select-check',option.selected?'✓':'');check.setAttribute('aria-hidden','true');row.append(check,make(document,'span',null,option.label));menu.append(row);
        });
        if(!menu.childElementCount)menu.append(make(document,'div','df-select-empty','No options available'));
        trigger.setAttribute('aria-activedescendant',active>=0?`${id}-option-${active}`:'');
      }
      function position(){
        if(!menu||menu.hidden)return;const bounds=trigger.getBoundingClientRect(),width=view.innerWidth,height=view.innerHeight;
        const wanted=Math.max(bounds.width,180),left=Math.max(8,Math.min(width-Math.min(wanted,width-16)-8,bounds.left));
        menu.style.setProperty('width',`${Math.min(wanted,width-16)}px`,'important');menu.style.setProperty('left',`${left}px`,'important');
        const below=height-bounds.bottom-12,above=bounds.top-12,flip=below<Math.min(menu.scrollHeight,220)&&above>below,maxHeight=Math.max(80,Math.min(300,flip?above:below));
        menu.style.setProperty('max-height',`${maxHeight}px`,'important');const rendered=Math.min(menu.scrollHeight+2,maxHeight);
        const top=Math.max(8,Math.min(height-rendered-8,flip?bounds.top-rendered-5:bounds.bottom+5));menu.style.setProperty('top',`${top}px`,'important');
      }
      function open(direction=1){
        if(disabled(select))return;if(manager.open&&manager.open!==item)manager.open.close();manager.open=item;
        if(!menu){menu=make(document,'div','df-select-menu');menu.id=`${id}-menu`;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',labelFor(select));menu.dataset.diffuseSelectTheme=theme;menu.hidden=true;menu.popover='manual';const dialog=select.closest('dialog');(dialog||root.body||root).append(menu);
          listen(menu,'pointerdown',event=>event.preventDefault());listen(menu,'click',event=>{const row=event.target.closest('[data-index]');if(row)choose(Number(row.dataset.index));});listen(menu,'pointermove',event=>{const row=event.target.closest('[data-index]');if(row&&row.getAttribute('aria-disabled')!=='true')setActive(Number(row.dataset.index),false);});
        }
        const options=available();active=options.find(({option})=>option.selected)?.index??(direction<0?options.at(-1)?.index:options[0]?.index)??-1;
        menu.hidden=false;renderOptions();try{menu.showPopover();}catch{}trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls',menu.id);position();setActive(active);
      }
      function close(){if(!menu)return;try{if(menu.matches(':popover-open'))menu.hidePopover();}catch{}menu.hidden=true;trigger?.setAttribute('aria-expanded','false');trigger?.removeAttribute('aria-activedescendant');if(manager.open===item)manager.open=null;}
      function setActive(index,scroll=true){active=index;if(!menu||menu.hidden)return;for(const row of menu.querySelectorAll('[data-index]'))row.dataset.active=String(Number(row.dataset.index)===active);trigger.setAttribute('aria-activedescendant',`${id}-option-${active}`);if(scroll)menu.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'});}
      function choose(index){const option=select.options[index];if(!option||optionDisabled(option)||disabled(select))return;if(select.multiple)option.selected=!option.selected;else select.selectedIndex=index;dispatch();if(!select.multiple)close();else sync();trigger.focus({preventScroll:true});}
      function keydown(event){
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
          event.preventDefault();event.stopPropagation();if(!menu||menu.hidden){open(event.key==='ArrowUp'?-1:1);if(!['Home','End'].includes(event.key))return;}
          const options=available(),at=options.findIndex(item=>item.index===active),index=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,at+(event.key==='ArrowUp'?-1:1)));setActive(options[index]?.index??-1);return;
        }
        if(event.key==='Escape'&&menu&&!menu.hidden){event.preventDefault();event.stopPropagation();close();return;}
        if(event.key==='Tab'){close();return;}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(!menu||menu.hidden)open();else choose(active);return;}
        if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopPropagation();const now=Date.now();typing=now-typedAt>650?'':typing;typedAt=now;typing+=event.key.toLocaleLowerCase();const match=available().find(({option})=>option.label.trim().toLocaleLowerCase().startsWith(typing));if(match){if(!menu||menu.hidden)open();setActive(match.index);}}
      }
      if(!severity){trigger=make(document,'button','df-select-trigger');trigger.type='button';trigger.id=`${id}-trigger`;trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.append(make(document,'span','df-select-value'));const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','df-select-chevron');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m6 9 6 6 6-6');svg.append(path);trigger.append(svg);wrapper.append(trigger);listen(trigger,'click',()=>menu&&!menu.hidden?close():open());listen(trigger,'keydown',keydown);}
      wrapper.append(error);
      for(const key of ['value','selectedIndex'])instrument(select,key,changed,restorers);
      listen(select,'input',changed);listen(select,'change',changed);listen(select,'invalid',event=>{event.preventDefault();error.textContent=select.validationMessage||'Choose an option.';error.hidden=false;trigger?.setAttribute('aria-invalid','true');(trigger||radios.find(radio=>!radio.disabled))?.focus();});
      for(const label of select.labels||[])listen(label,'click',event=>{if(event.composedPath().includes(wrapper)||event.target.closest('button,input,textarea,select,a'))return;event.preventDefault();(trigger||radios.find(radio=>radio.checked)||radios[0])?.focus();});
      sync();
      function dispose(preserveUI=false){close();menu?.remove();for(const restore of restorers)restore();for(const list of optionRestorers.values())for(const restore of list)restore();if(preserveUI){wrapper.querySelectorAll('button,input').forEach(node=>node.disabled=true);return;}wrapper.remove();select.classList.remove('df-select-native');for(const [name,value]of [['tabindex',original.tabindex],['aria-hidden',original.ariaHidden]])value===null?select.removeAttribute(name):select.setAttribute(name,value);}
    }
    function discover(scope){if(scope.nodeType===1&&scope.matches('select'))build(scope);scope.querySelectorAll?.('select').forEach(build);}
    const observer=new MutationObserver(records=>{
      const changed=new Set();for(const record of records){const native=record.target instanceof HTMLSelectElement?record.target:record.target.parentElement?.closest('select');if(native&&items.has(native))changed.add(native);if(record.type==='childList')for(const node of record.addedNodes)if(node.nodeType===1)discover(node);if(record.type==='attributes'&&record.target.localName==='fieldset')for(const select of record.target.querySelectorAll('select'))changed.add(select);}
      for(const [select,item]of items)if(!contains(root,select)){item.dispose();items.delete(select);}
      for(const select of changed)items.get(select)?.sync();
    });
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value','hidden','multiple','required','aria-label','aria-labelledby','aria-describedby']});manager.observer=observer;
    listen(root,'reset',()=>{if(manager.resetFrame)view.cancelAnimationFrame(manager.resetFrame);manager.resetFrame=view.requestAnimationFrame(()=>{manager.resetFrame=0;manager.refresh();});},{capture:true});
    listen(document,'pointerdown',event=>{const item=manager.open;if(item&&!event.composedPath().includes(item.wrapper)&&!event.composedPath().some(node=>node?.classList?.contains('df-select-menu')))item.close();},{capture:true});
    listen(document,'scroll',()=>{if(manager.open)manager.open.position();},{capture:true,passive:true});
    listen(view,'resize',()=>{if(manager.open)manager.open.position();},{passive:true});
    discover(root);return()=>destroy(root);
  }
  function refresh(root=document){managers.get(root)?.refresh();}
  function destroy(root=document,{preserveUI=false}={}){const manager=managers.get(root);if(!manager)return;manager.abort.abort();manager.observer.disconnect();if(manager.resetFrame)(root.ownerDocument||root).defaultView.cancelAnimationFrame(manager.resetFrame);for(const item of manager.items.values())item.dispose(preserveUI);if(!preserveUI)manager.style.remove();manager.items.clear();managers.delete(root);}
  globalThis.DiffuseSelect=Object.freeze({enhance,refresh,destroy,css});
  if(location.protocol==='chrome-extension:'){
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>enhance(document),{once:true});else enhance(document);
  }
})();
