import {journeyOutcomeContext} from './journey-outcome.mjs';
import {JOURNEY_PERSONA_TRAITS} from './journey-persona.mjs';
const text = value => typeof value === 'string' ? value : value?.message || value?.text || value?.description || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const md = value => String(value ?? '').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
const rows = pairs => `<dl class="journey-report-fields">${pairs.filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const image = v => typeof v==='string' && /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(v) ? v : '';
const video = v => typeof v==='string' && /^data:video\/(?:webm|mp4)(?:;codecs=[^;,]+)?;base64,[a-zA-Z0-9+/=\s]+$/.test(v) ? v : '';
const statusLabels = {completed:'Completed',stopped:'Stopped',blocked:'Needs help',inconclusive:'Inconclusive',failed:'Failed',running:'Running',paused:'Paused',idle:'Preparing'};
export function journeyStepLabel(step={}) {
  const action=step.action || {}, kind=typeof action==='string'?action:action.type||'observe';
  const label={click:'Click',type:'Enter text',select:'Choose an option',scroll:'Scroll',navigate:'Open page',back:'Go back',wait:'Wait',inspect:'Read page',observe:'Read page',finish:'Check outcome',press:'Press a key',hover:'Hover'}[kind]||kind;
  const control=step.observation?.controls?.find(item=>item.id===(action.controlId??action.targetId));
  const target=action.label||action.targetLabel||action.description||control?.label||control?.name;
  return `${label}${target?` · ${target}`:''}`;
}
export function journeyStepDetails(step={}) {
  const action=typeof step.action==='object'&&step.action?step.action:{};
  return [
    ['Why this action',text(step.reason)],['Execution',step.executionStatus||'Not recorded'],
    ['Result',text(step.result)||text(step.result?.error)],['Error',text(step.executionError)],
    ['Page',step.observation?.title],['Address',step.observation?.url],['Recorded',step.createdAt],
    ['Entered value',action.value],['Key',action.key],['Direction',action.direction],['Target',action.controlId??action.targetId],
    ['Recording position',Number.isFinite(step.videoOffsetMs)?`${(step.videoOffsetMs/1000).toFixed(1)} seconds`:null],
  ];
}
export function formatJourneyReports(runs=[],{clipboard=false}={}) {
  if(!Array.isArray(runs)||!runs.length)return '';
  return `<section id="review-journeys" class="journey-reports" aria-label="Journeys"><h2>Journeys <span class="journey-report-count">${runs.length}</span></h2><p>Every saved attempt is listed, including stopped and interrupted journeys. Expand a journey to inspect its recorded steps.</p>${runs.map((run,i)=>{
    const steps=Array.isArray(run.steps)?run.steps:[], outcome=journeyOutcomeContext(run), src=video(run.video?.dataUrl);
    const reason=text(outcome.stopReason)||text(outcome.error);
    const a=outcome.targetAssessment;
    const persona=run.persona;
    return `<details class="journey-report" data-journey-id="${esc(run.id)}"${clipboard?' open':''}><summary><span class="journey-report-title">${esc(run.goal||`Journey ${i+1}`)}</span><span class="journey-report-meta">${esc(statusLabels[run.status]||run.status||'Unknown outcome')} · ${steps.length} recorded ${steps.length===1?'step':'steps'} · ${esc(run.createdAt||'')}</span></summary><div class="journey-report-body">${text(outcome.summary)?`<p class="journey-report-summary">${esc(text(outcome.summary))}</p>`:''}${reason?`<div class="journey-report-end"><strong>Why it ended</strong><p>${esc(reason)}</p></div>`:!['running','paused','completed'].includes(run.status)?'<p>No explicit stop reason was saved for this attempt. Its outcome cannot be inferred from the last step.</p>':''}${rows([
      ['Starting page',run.startUrl],['Persona',persona?.description||'Not recorded'],
      ...JOURNEY_PERSONA_TRAITS.map(({key,label})=>[label,Number.isInteger(persona?.[key])?`${persona[key]}/5`:null]),
      ['Action target',a.actionTarget],['Action attempts',a.actionCount],['Efficiency',a.efficiencyScore===null?'Not scored: completion was not verified':`${a.efficiencyScore}/100`],
      ['Automation duration',Number.isFinite(run.metrics?.elapsedMs)?`${Math.round(run.metrics.elapsedMs/1000)} seconds (includes AI, network and pauses; not human task time)`:null],
      ['Continues journey',run.continuation?.parentRunId],['Alternative route from',run.fork?.parentRunId],
    ])}${run.evidenceArchived?'<p class="journey-report-note">Older screenshots and video were cleared to manage device storage. All recorded steps and notes remain available.</p>':''}${src&&!clipboard?`<details class="journey-report-recording"><summary>Journey recording</summary><video controls preload="none" src="${esc(src)}" aria-label="Journey recording"></video></details>`:''}<h3>Steps</h3>${steps.length?`<ol class="journey-report-steps">${steps.map((step,index)=>{
      const shot=image(step.observation?.screenshot?.dataUrl||step.observation?.screenshotDataUrl);
      return `<li><details${clipboard?' open':''}><summary><strong>Step ${Number.isSafeInteger(step.index)?step.index:index+1} · ${esc(journeyStepLabel(step))}</strong><span>${esc(step.observation?.title||step.executionStatus||'Recorded action')}</span></summary><div class="journey-report-step-body">${rows(journeyStepDetails(step))}${shot?`<details class="journey-report-evidence"><summary>Screenshot before this action</summary><img loading="lazy" src="${esc(shot)}" alt="Page before step ${index+1}"></details>`:''}</div></details></li>`;
    }).join('')}</ol>`:'<p>No steps were recorded before this attempt ended.</p>'}</div></details>`;
  }).join('')}</section>`;
}
export function formatJourneyMarkdown(runs=[]) {
  if(!Array.isArray(runs)||!runs.length)return '';
  const lines=['## Journeys',''];
  for(const run of runs){
    const outcome=journeyOutcomeContext(run);
    lines.push(`### ${md(run.goal||'Journey')}`,'',`Status: ${md(statusLabels[run.status]||run.status)}`,'',md(text(outcome.summary)),'');
    const reason=text(outcome.stopReason)||text(outcome.error);if(reason)lines.push(`Why it ended: ${md(reason)}`,'');
    for(const step of run.steps||[]) {lines.push(`#### Step ${step.index} · ${md(journeyStepLabel(step))}`,'');for(const [label,value] of journeyStepDetails(step))if(value!==null&&value!==undefined&&value!=='')lines.push(`- ${label}: ${md(value)}`);lines.push('');}
  }
  return lines.join('\n');
}
export const JOURNEY_REPORT_STYLES=`
.journey-reports{margin:30px 0}.journey-reports>h2{font-size:22px;margin-bottom:8px}.journey-reports>p,.journey-report-meta,.journey-report-note{color:var(--ui-muted,#62738a);font-size:13px}.journey-report-count{font-size:14px;font-weight:500;margin-left:6px}.journey-report{border:1px solid var(--ui-line,#d7e2ef);border-radius:12px;background:var(--ui-surface,#fff);margin:16px 0;overflow:hidden}.diffuse-report .journey-report>summary{padding:20px 20px 20px 36px;cursor:pointer}.diffuse-report .journey-report>summary::before{left:17px;top:27px}.diffuse-report .journey-report[open]>summary::before{top:25px}.journey-report-title{display:block;font-size:17px;font-weight:600}.journey-report-meta{display:block;margin-top:6px}.journey-report-body{padding:0 24px 24px}.journey-report-summary{white-space:pre-wrap}.journey-report-end{background:var(--ui-surface-muted,#f3f6fa);border-radius:8px;padding:14px 16px;margin:16px 0}.journey-report-end p{margin:6px 0 0}.journey-report-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 24px;margin:20px 0}.journey-report-fields dt{font-size:12px;color:var(--ui-muted,#62738a)}.journey-report-fields dd{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.journey-report-steps{list-style:none;padding:0;margin:0}.journey-report-steps>li{border-top:1px solid var(--ui-line,#d7e2ef);padding:8px 0}.journey-report-steps summary{cursor:pointer;min-height:44px;padding:10px 0 10px 18px}.journey-report-steps summary>span{display:block;font-size:13px;color:var(--ui-muted,#62738a);margin-top:4px}.journey-report-step-body{padding:0 0 12px 18px}.journey-report-recording summary,.journey-report-evidence summary{cursor:pointer;padding:10px 0 10px 18px}.journey-report video,.journey-report img{display:block;width:100%;height:auto;max-height:650px;object-fit:contain;margin-top:12px;border-radius:8px}.journey-report :is(summary,video):focus-visible{outline:0;box-shadow:inset 0 0 0 2px var(--ui-accent,#235ed7);border-radius:6px}@media(max-width:640px){.journey-report-fields{grid-template-columns:1fr}.journey-report-body{padding:0 16px 16px}}
`;
