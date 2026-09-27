import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),artifacts=resolve(project,'artifacts/select-controls');
const content=await readFile(resolve(project,'extension/select-controls.js'),'utf8');
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const passed=[];
try{
  await mkdir(artifacts,{recursive:true});
  const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<!doctype html><title>Custom select fixture</title><style>body{font:15px system-ui;padding:24px}form{max-width:440px}label.field{display:block;margin:16px 0}small{display:block}fieldset{padding:15px}#host-select{margin:10px}button{margin-top:3px}dialog{width:300px}#shadow-host{display:block;width:330px;margin:20px}</style>
    <label for="host-select">Host control</label><select id="host-select"><option>Untouched host select</option></select>
    <div id="shadow-host"></div>`);
  await page.addScriptTag({content});
  assert.equal(await page.locator('.df-select').count(),0,'Ordinary webpages are never auto-enhanced');
  await page.evaluate(()=>{
    const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});root.innerHTML=`<style>:host{display:block;background:#20172f;padding:20px;color:white}label.field{display:block;margin:12px 0}form{display:grid;gap:10px}</style><form id="review-form">
      <label class="field" for="category">Category</label><select id="category" name="category" required><option value="">Choose a category</option><option value="design" selected>Design mismatch</option><option value="ux">UX issue</option><optgroup label="Unavailable" disabled><option value="other">Other</option></optgroup><option value="copy">Copy change</option></select>
      <label class="field">Severity<select id="comment-severity" name="severity"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select><small>How much does it matter?</small></label>
      <label class="field" for="labels">Jira labels</label><select id="labels" name="labels" multiple><option value="design" selected>Design</option><option value="bug">Bug</option><option value="copy">Copy</option></select>
      <fieldset id="disabled-group"><label class="field">Project<select id="project" name="project"><option value="one">Project one</option><option value="two">Project two</option></select></label></fieldset>
      <button type="reset">Reset form</button><button type="submit">Save</button></form><button id="after">After controls</button>`;
    root.querySelector('form').addEventListener('submit',event=>event.preventDefault());
    window.fixtureRoot=root;window.events=[];root.querySelector('#category').addEventListener('input',()=>events.push('input'));root.querySelector('#category').addEventListener('change',()=>events.push('change'));
    DiffuseSelect.enhance(root,{theme:'dark'});
  });
  const shadow=page.locator('#shadow-host'),category=shadow.getByRole('combobox',{name:'Category',exact:true}),multi=shadow.getByRole('combobox',{name:'Jira labels',exact:true});
  assert.equal(await page.locator('#host-select').getAttribute('class'),null);
  assert.equal(await category.count(),1);assert.equal(await category.locator('svg').count(),1);
  assert.equal(await shadow.locator('#category').getAttribute('tabindex'),'-1');assert.equal(await shadow.locator('#category').getAttribute('aria-hidden'),'true');
  await category.click();assert.equal(await category.getAttribute('aria-expanded'),'true');
  await shadow.getByRole('option',{name:'UX issue',exact:true}).click();assert.equal(await shadow.locator('#category').inputValue(),'ux');assert.equal(await category.getAttribute('aria-expanded'),'false');
  assert.deepEqual(await page.evaluate(()=>events),['input','change']);
  assert.deepEqual(await page.evaluate(()=>[...new FormData(fixtureRoot.querySelector('form'))]),[['category','ux'],['severity','minor'],['labels','design'],['project','one']]);
  passed.push('Custom menu selects once, preserves form data and labels, and never enhances host-page controls');

  await category.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await page.keyboard.press('Enter');assert.equal(await shadow.locator('#category').inputValue(),'copy');
  await category.press('Home');await category.press('ArrowDown');await category.press('Enter');assert.equal(await shadow.locator('#category').inputValue(),'design');
  await category.press('c');await category.press('Enter');assert.equal(await shadow.locator('#category').inputValue(),'');
  await category.press('ArrowDown');await category.press('Escape');assert.equal(await category.getAttribute('aria-expanded'),'false');assert.equal(await category.evaluate(node=>node===node.getRootNode().activeElement),true);
  await category.press('ArrowDown');await category.press('Tab');assert.equal(await category.getAttribute('aria-expanded'),'false');
  await category.click();await page.locator('#host-select').click();assert.equal(await category.getAttribute('aria-expanded'),'false');
  passed.push('Keyboard navigation, typeahead, Escape, Tab, focus retention, and outside-click dismissal work');

  await page.evaluate(()=>{fixtureRoot.querySelector('#category').value='ux';});assert.match(await category.textContent(),/UX issue/);
  await page.evaluate(()=>{fixtureRoot.querySelector('#category').selectedIndex=4;});assert.match(await category.textContent(),/Copy change/);
  await page.evaluate(()=>{fixtureRoot.querySelector('#category').options[1].selected=true;});assert.match(await category.textContent(),/Design mismatch/);
  await page.evaluate(()=>{const select=fixtureRoot.querySelector('#category');select.options[1].textContent='Visual detail';select.append(new Option('Accessibility','access'));});await page.waitForTimeout(30);assert.match(await category.textContent(),/Visual detail/);
  await category.click();assert.equal(await shadow.getByRole('option',{name:'Accessibility',exact:true}).count(),1);await category.press('Escape');
  await page.evaluate(()=>fixtureRoot.querySelector('#category').value='copy');await shadow.getByRole('button',{name:'Reset form',exact:true}).click();await page.waitForTimeout(40);assert.match(await category.textContent(),/Visual detail/);
  await page.evaluate(()=>fixtureRoot.querySelector('#disabled-group').disabled=true);await page.waitForTimeout(30);assert.equal(await shadow.getByRole('combobox',{name:'Project',exact:true}).isDisabled(),true);
  passed.push('Programmatic value/selectedIndex/option-selected changes, dynamic options, form reset, and disabled fieldsets stay synchronized');

  await multi.click();await shadow.getByRole('option',{name:'Bug',exact:true}).click();assert.equal(await multi.getAttribute('aria-expanded'),'true');assert.match(await multi.textContent(),/Design, Bug/);await multi.press('Escape');
  assert.deepEqual(await shadow.locator('#labels').evaluate(select=>[...select.selectedOptions].map(option=>option.value)),['design','bug']);
  const radios=shadow.getByRole('radiogroup',{name:'Severity',exact:true});assert.equal(await radios.getByRole('radio').count(),3);
  await radios.getByRole('radio',{name:'Major',exact:true}).check();assert.equal(await shadow.locator('#comment-severity').inputValue(),'major');
  assert.equal(await page.evaluate(()=>fixtureRoot.querySelector('form').elements.namedItem('severity').localName),'select');
  await radios.getByRole('radio',{name:'Major',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await shadow.locator('#comment-severity').inputValue(),'critical');
  await page.evaluate(()=>fixtureRoot.querySelector('#comment-severity').value='minor');assert.equal(await radios.getByRole('radio',{name:'Minor',exact:true}).isChecked(),true);
  assert.equal(await page.evaluate(()=>[...new FormData(fixtureRoot.querySelector('form'))].filter(([name])=>name.includes('severity')).length),1);
  passed.push('Multiple selections and true severity radios remain form-compatible, including radio keyboard navigation');

  await page.evaluate(()=>fixtureRoot.querySelector('#category').value='');
  await shadow.getByRole('button',{name:'Save',exact:true}).click();assert.equal(await category.getAttribute('aria-invalid'),'true');assert.equal(await category.evaluate(node=>node===node.getRootNode().activeElement),true);assert.equal(await shadow.locator('.df-select-error:not([hidden])').count(),1);
  await category.click();await shadow.getByRole('option',{name:'UX issue',exact:true}).click();assert.equal(await category.getAttribute('aria-invalid'),null);
  passed.push('Required-field validation focuses the visible custom control and clears after correction');

  await page.evaluate(()=>{const form=fixtureRoot.querySelector('form'),label=document.createElement('label');label.textContent='Dynamic field';const select=document.createElement('select');select.id='dynamic';select.innerHTML='<option>Added after loading</option>';label.append(select);form.append(label);});await page.waitForTimeout(30);
  assert.equal(await shadow.getByRole('combobox',{name:'Dynamic field',exact:true}).count(),1);
  await page.evaluate(()=>{fixtureRoot.querySelector('#dynamic').closest('label').remove();});await page.waitForTimeout(30);
  assert.equal(await shadow.locator('[data-diffuse-select-for=dynamic]').count(),0);
  await page.evaluate(()=>{fixtureRoot.querySelector('#category').value='copy';});await category.click();await page.screenshot({path:resolve(artifacts,'shadow-select.png')});
  await page.evaluate(()=>DiffuseSelect.destroy(fixtureRoot,{preserveUI:true}));assert.equal(await category.isDisabled(),true);assert.equal(await shadow.locator('.df-select-menu').count(),0);assert.equal(await shadow.locator('#category').getAttribute('aria-hidden'),'true');
  await page.evaluate(()=>{fixtureRoot.querySelector('#category').value='ux';fixtureRoot.querySelector('#category').dispatchEvent(new Event('change'));});assert.match(await category.textContent(),/Copy change/,'Destroyed managers cannot update frozen controls');
  passed.push('Dynamic fields are enhanced and removed safely; preserveUI teardown closes menus and freezes stale controls');
  assert.deepEqual(errors,[]);await page.close();

  const light=await browser.newPage({viewport:{width:360,height:500}}),lightErrors=[];light.on('pageerror',error=>lightErrors.push(error.message));
  await light.setContent('<!doctype html><title>Popup positioning fixture</title><style>body{margin:0;font:15px system-ui}#bottom{position:fixed;right:4px;bottom:8px;width:290px}dialog{width:280px}</style><div id="bottom"><label for="edge">Bottom field</label><select id="edge"><option>First</option><option>Second</option><option>Third</option><option>Fourth</option><option>Fifth</option><option>Sixth</option></select></div><dialog id="dialog"><form method="dialog"><label for="inside">Dialog field</label><select id="inside"><option>One</option><option>Two</option></select><button>Close dialog</button></form></dialog>');
  await light.addScriptTag({content});await light.evaluate(()=>DiffuseSelect.enhance(document));const edge=light.getByRole('combobox',{name:'Bottom field',exact:true});await edge.click();
  const box=await light.locator('.df-select-menu:not([hidden])').boundingBox(),buttonBox=await edge.boundingBox();assert.ok(box.x>=7&&box.x+box.width<=353);assert.ok(box.y>=7&&box.y+box.height<=493);assert.ok(box.y+box.height<buttonBox.y,'Menu flips above a bottom-edge trigger');
  await light.screenshot({path:resolve(artifacts,'light-menu-flipped.png')});await edge.press('Escape');
  await light.evaluate(()=>{const select=document.querySelector('#edge');for(let index=7;index<50;index++)select.add(new Option(`Project ${index}`,String(index)));});await light.waitForTimeout(30);await edge.click();
  await light.locator('.df-select-menu:not([hidden])').evaluate(menu=>menu.scrollTop=500);await light.waitForTimeout(50);assert.ok(await light.locator('.df-select-menu:not([hidden])').evaluate(menu=>menu.scrollTop)>=490,'Scrolling long menus must not rebuild options and snap the user to the top');await edge.press('Escape');
  await light.evaluate(()=>document.querySelector('#dialog').showModal());const inside=light.getByRole('combobox',{name:'Dialog field',exact:true});await inside.click();await light.getByRole('option',{name:'Two',exact:true}).click();assert.equal(await light.locator('#inside').inputValue(),'Two');
  await light.evaluate(()=>{document.querySelector('#dialog').close();DiffuseSelect.destroy(document);});assert.equal(await light.locator('.df-select,.df-severity,.df-select-menu').count(),0);assert.equal(await light.locator('#edge').getAttribute('aria-hidden'),null);assert.equal(await light.locator('#edge').getAttribute('tabindex'),null);
  await light.evaluate(()=>document.querySelector('#edge').value='Third');assert.equal(await light.locator('#edge').inputValue(),'Third');assert.deepEqual(lightErrors,[]);
  passed.push('Menus flip and clamp inside narrow windows, work within modal dialogs, and restore native fields on normal teardown');
  await light.evaluate(()=>{const label=document.createElement('label');label.textContent='Severity';label.style.cssText='display:block;margin:16px';label.innerHTML+='<select name="severity"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select>';document.body.append(label);DiffuseSelect.enhance(document);});
  for(const width of [420,360,320]){
    await light.setViewportSize({width,height:500});
    const cells=await light.locator('.df-severity-choice>span').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,overflow:node.scrollWidth>node.clientWidth};}));
    assert.equal(cells.length,3);assert.ok(cells.every(cell=>cell.y===cells[0].y&&cell.height>=44&&!cell.overflow),'Severity stays on one horizontal row with readable labels');
    assert.ok(cells[2].x+cells[2].width<=width,'Severity fits narrow drawers');
  }
  await light.screenshot({path:resolve(artifacts,'horizontal-severity.png')});
  passed.push('All three severity choices remain horizontal and fit at 320, 360 and 420px');
  await light.close();
  for(const check of passed)console.log(`PASS ${check}`);
  await writeFile(resolve(artifacts,'checks.json'),JSON.stringify({passed},null,2));
}finally{await browser.close();}
