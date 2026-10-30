import test from 'node:test';
import assert from 'node:assert/strict';
import {formatJourneyReports, formatJourneyMarkdown} from '../extension/journey-report.mjs';
import {formatReviewHtml, formatStandaloneHtml, formatMarkdown} from '../extension/report-format.mjs';
const run={id:'stopped-journey',goal:'Create an ingredient',status:'stopped',createdAt:'2026-10-25T12:00:00Z',stopReason:{message:'Stopped by reviewer'},summary:'Task not completed',steps:[{index:1,action:{type:'click',controlId:'add'},reason:'The Add control opens the form',executionStatus:'complete',result:{message:'Form opened'},observation:{title:'Ingredients',url:'https://example.test/ingredients',controls:[{id:'add',label:'Add ingredient'}],screenshot:{dataUrl:'data:image/png;base64,AAAA'}}}]};
test('stopped journeys are separate from observations with full saved step detail and known stop reason',()=>{
 const html=formatReviewHtml({id:'review',comments:[],journeys:[run]});
 for(const text of ['aria-label="Journeys"','Stopped','Why it ended','Stopped by reviewer','Step 1 · Click · Add ingredient','The Add control opens the form','Form opened','Screenshot before this action'])assert(html.includes(text),text);
 assert(!html.includes('No steps were recorded'));
});
test('every terminal status, empty attempts and unknown stop reasons remain readable without inventing outcomes',()=>{
 for(const status of ['stopped','blocked','inconclusive','failed','completed']){
 const html=formatJourneyReports([{...run,status,steps:[],stopReason:null}]);
 assert(html.includes('No steps were recorded'));
 if(status!=='completed')assert(html.includes('No explicit stop reason'));
 }
});
test('journey report data is escaped and media cannot load external resources or scripts',()=>{
 const html=formatJourneyReports([{...run,id:'" onclick="evil()',goal:'<img src=x onerror=evil()>',video:{dataUrl:'https://evil.test/movie'},steps:[{...run.steps[0],reason:'<script>evil()</script>',observation:{title:'<iframe>',screenshot:{dataUrl:'javascript:evil()'}}}]}]);
 assert(!html.includes('<script>'));assert(!html.includes('<iframe>'));assert(!html.includes('src="javascript:'));assert(!html.includes('src="https://evil'));
 assert(html.includes('&lt;img'));assert(html.includes('&lt;script&gt;'));
});
test('offline HTML and copied report include stopped journeys; notes survive media archival',()=>{
 const archived={...run,evidenceArchived:true};
 assert(formatStandaloneHtml({journeys:[archived]}).includes('Older screenshots and video were cleared'));
 assert(formatMarkdown({journeys:[run]},{embedMedia:false}).includes('## Journeys'));
 assert(formatJourneyMarkdown([run]).includes('Why it ended: Stopped by reviewer'));
 assert(formatJourneyMarkdown([run]).includes('The Add control opens the form'));
});
