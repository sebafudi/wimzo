import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {lexer} from 'marked';
import {markdownRenderer} from '../src/markdown.js';

const source=readFileSync(new URL('../src/dashboard.html',import.meta.url),'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm,'');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(options: {hash?:string;storage?:Map<string,string>;unauthorized?:boolean;networkFailure?:boolean;storageUnavailable?:boolean;unknownPredecessor?:boolean;reviewStore?:Map<string,any>;loseSubmitResponse?:boolean;taskReview?:'match'|'mismatch'} = {}) {
  const storage=options.storage ?? new Map<string,string>();
  const reviewStore=options.reviewStore??new Map<string,any>();let lostResponse=false;
  const sessionStorage={getItem:(key:string)=>{if(options.storageUnavailable)throw new Error('Storage blocked');return storage.get(key)??null;},setItem:(key:string,value:string)=>{if(options.storageUnavailable)throw new Error('Storage blocked');storage.set(key,value);},removeItem:(key:string)=>{if(options.storageUnavailable)throw new Error('Storage blocked');storage.delete(key);}};
  const location={hash:options.hash??'#key=fixture',pathname:'/',search:''};
  const credentials:string[]=[];
  const {document}=parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  let holdNext=false, holdSubmit=false, release: (()=>void)|undefined;
  const calls:Array<{action:string,input:any}>=[];
  const versions=[{id:'spec:new',label:'Current intent',at:'2026-09-21T12:00:00Z',source:'snapshot',status:'Draft',previousVersionId:'git:old'},{id:'git:old',label:'Earlier intent',at:'2026-09-20T12:00:00Z',source:'git',previousVersionId:options.unknownPredecessor?null:'git:initial',previousVersionKnown:!options.unknownPredecessor}];
  const projects=[{id:'one',name:'First project'},{id:'two',name:'Second project'}];
  const data=(action:string,input:any):any=>{
    if(action==='project.list')return projects;
    if(action==='project.get')return projects.find(p=>p.id===input.projectId);
    if(action==='task.list'&&options.taskReview)return [{id:'result',projectId:input.projectId,objective:'Review fixture result',state:'Needs result review',candidate:{id:'candidate-one'},rev:1}];
    if(action==='board.list')return {columns:[{id:'review',title:'Review',cards:options.taskReview?[{id:'task:result',kind:'task',title:'Review fixture result',column:'review',status:'Needs result review',summary:'Checks completed',taskId:'result'}]:[]}],watermark:1};
    if(action==='review.diff')return {kind:'task',title:'Review fixture result',status:'Needs result review',files:[{path:'file.md',status:'modified',patch:'',markdown:{before:'Before',after:'After'}}],warnings:[],identity:{candidate:{id:'candidate-one'},sourceCandidate:null}};
    if(action==='review.prepare'){const feedback=[...reviewStore.values()].filter(item=>JSON.stringify(item.target)===JSON.stringify(input.target));const accepted=feedback.some(item=>item.decision==='accept');return {target:input.target.kind==='task'?{...input.target,candidate:{id:options.taskReview==='mismatch'?'candidate-two':'candidate-one'},sourceCandidate:null}:input.target,fingerprint:'review-v1',canAccept:!accepted,canRequest:true,accepted,reason:accepted?'This version is accepted.':null,subject:'Requirements',feedback};}
    if(action==='review.submit'){let feedback=reviewStore.get(input.submissionId);if(!feedback){feedback={id:input.submissionId,...input,at:'2026-09-21T12:00:00Z'};reviewStore.set(input.submissionId,feedback);}return {message:input.decision==='accept'?'Changes accepted.':'Changes requested. Your note is saved in the project inbox.',feedback};}
    if(action==='review.tree')return {files:[{path:'spec/PRD.md',title:input.projectId==='one'?'First requirements':'Second requirements',status:'Draft',workingChange:'M',workingDiff:{additions:12,deletions:3}},{path:'spec/features/search.md',title:'Search requirements',workingChange:'A',workingDiff:{additions:5,deletions:0}},{path:'spec/decisions/review.md',title:'Review decision',workingChange:'D',workingDiff:null,workingDiffUnavailable:'Binary file: line counts unavailable'}],warnings:[]};
    if(action==='review.history')return input.offset?{versions:[{id:'git:initial',label:'Initial requirements',at:'2026-09-19T12:00:00Z',source:'git',previousVersionId:null}],nextOffset:null,warnings:[]}:{versions,nextOffset:2,warnings:[]};
    if(action==='review.compare')return {kind:'document',title:'Requirements',baseLabel:'Before',afterLabel:'After',files:[{path:input.path,status:'modified',patch:input.beforeVersion===null?'':'@@ -1 +1,2 @@\n-# Earlier\n+# Requirements\n+Added line.\n',markdown:{before:input.beforeVersion===null?null:'# Earlier\n',after:input.projectId==='one'?'# First requirements\n':'# Second requirements\n'}}],warnings:[],identity:{}};
    return [];
  };
  vm.runInNewContext(source,{document,crypto:{randomUUID},lexer,markdownRenderer,URL,URLSearchParams,sessionStorage,location,history:{replaceState(){location.hash='';}},matchMedia:()=>({matches:false}),fetch:async(_:string,request:any)=>{credentials.push(request.headers.Authorization);if(options.networkFailure)throw new Error('Failed to fetch');const call=JSON.parse(request.body);calls.push(call);if(options.unauthorized)return{ok:false,status:401,json:async()=>({error:'Local client token required'})};if((call.action==='review.compare'&&holdNext)||(call.action==='review.submit'&&holdSubmit)){holdNext=false;holdSubmit=false;await new Promise<void>(resolve=>{release=resolve;});}const result=data(call.action,call.input);if(call.action==='review.submit'&&options.loseSubmitResponse&&!lostResponse){lostResponse=true;throw new Error('Lost response');}return{ok:true,json:async()=>({result})};},console});
  for(let i=0;i<5;i++)await turn();
  return {document,calls,storage,location,credentials,reviewStore,holdNextComparison:()=>{holdNext=true;},holdNextSubmission:()=>{holdSubmit=true;},releaseComparison:()=>release?.()};
}

test('tree badges and right history compare each change to its exact predecessor across pages',async()=>{
  const {document,calls}=await setup();
  assert.equal(document.querySelectorAll('.tree-folder').length,3);
  assert.deepEqual([...document.querySelectorAll('.change-badge')].map(x=>x.textContent).sort(),['A','D','M']);
  assert.equal(document.querySelectorAll('.history-sidebar .history-version').length,2);
  const selectedFile=document.querySelector('.working-M') as any;
  assert.equal(selectedFile?.getAttribute('aria-label'),'spec/PRD.md');
  assert.equal(selectedFile.querySelector('.tree-diff-size')?.textContent,'+2-1');
  assert.equal(selectedFile.querySelector('.tree-change-summary')?.getAttribute('data-basis'),'Before');
  assert.match(selectedFile.querySelector('.tree-diff-size')?.getAttribute('title')||'',/compared with Before/);
  assert.match(document.querySelector('.tree-legend')?.textContent||'',/Selected file compares with Before; other files compare with Git HEAD/);
  assert.match(document.querySelector('.working-A .tree-diff-size')?.getAttribute('title')||'',/Git HEAD/);
  assert.equal(document.querySelector('.working-A .tree-diff-size')?.textContent,'+5-0');
  assert.match(document.querySelector('.working-D .tree-diff-unknown')?.getAttribute('aria-label')||'',/Binary/);
  assert.equal(document.querySelector('.markdown-document h1')?.textContent,'First requirements');
  (document.querySelectorAll('.history-pick')[1] as any).click();
  for(let i=0;i<3;i++)await turn();
  assert.deepEqual(calls.filter(c=>c.action==='review.compare').at(-1)!.input,{projectId:'one',path:'spec/PRD.md',beforeVersion:'git:initial',afterVersion:'git:old'});
  assert.ok(document.querySelector('[aria-label="Rendered changes"]'));
  const baseline=document.querySelector('[aria-label="Compare to"]') as any;
  for(const option of baseline.children)option.selected=false;[...baseline.children].find(option=>option.value==='spec:new').selected=true;baseline.onchange();
  for(let i=0;i<3;i++)await turn();
  assert.equal(calls.filter(c=>c.action==='review.compare').at(-1)!.input.beforeVersion,'spec:new');
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Load older versions')!.click();
  for(let i=0;i<3;i++)await turn();
  assert.equal(document.querySelectorAll('.history-version').length,3);
  (document.querySelectorAll('.history-pick')[2] as any).click();
  for(let i=0;i<3;i++)await turn();
  assert.deepEqual(calls.filter(c=>c.action==='review.compare').at(-1)!.input,{projectId:'one',path:'spec/PRD.md',beforeVersion:null,afterVersion:'git:initial'});
  assert.equal((document.querySelector('[aria-label="Compare to"]') as any).value,'previous');
  assert.ok(document.querySelector('.markdown-block.added'));assert.equal(document.querySelectorAll('.markdown-block.removed').length,0);
  assert.match(document.querySelector('.history-sidebar')!.textContent!,/All available versions/);
});

test('switching projects discards an older in-flight comparison',async()=>{
  const ui=await setup();ui.holdNextComparison();
  (ui.document.querySelectorAll('.history-pick')[1] as any).click();
  await turn();
  const project=ui.document.querySelector('[aria-label="Project"]') as any;
  project.children[0].selected=false;project.children[1].selected=true;project.onchange();
  for(let i=0;i<5;i++)await turn();
  assert.equal(ui.document.querySelector('.markdown-document h1')?.textContent,'Second requirements');
  ui.releaseComparison();for(let i=0;i<3;i++)await turn();
  assert.equal(ui.document.querySelector('.markdown-document h1')?.textContent,'Second requirements');
  assert.equal(ui.document.querySelector('.tree-file[aria-current="true"] .tree-title')?.textContent,'Second requirements');
});


test('refresh restores the same tab key and preview identity after the fragment is removed',async()=>{
  const first=await setup({hash:'#preview=1&key=refresh-test'});
  assert.equal(first.location.hash,'');
  const reloaded=await setup({hash:'',storage:first.storage});
  assert.equal(reloaded.document.querySelector('.markdown-document h1')?.textContent,'First requirements');
  assert.equal(reloaded.credentials[0],'Bearer refresh-test');
  assert.match(reloaded.document.body.textContent!,/Dashboard preview/);
  const forget=[...reloaded.document.querySelectorAll('button')].find(b=>b.textContent==='Forget key');
  assert.ok(forget);forget.click();
  const signedOut=await setup({hash:'',storage:first.storage});
  assert.equal(signedOut.calls.length,0);
  assert.match(signedOut.document.body.textContent!,/private dashboard link/);
});

test('new links replace cached keys, unauthorized keys are cleared, network errors retain the session',async()=>{
  const first=await setup({hash:'#key=old-key'});
  const replacement=await setup({hash:'#key=new-key',storage:first.storage});
  assert.equal(replacement.credentials[0],'Bearer new-key');
  const offline=await setup({hash:'',storage:first.storage,networkFailure:true});
  assert.match(offline.document.body.textContent!,/unavailable/);
  const online=await setup({hash:'',storage:first.storage});
  assert.equal(online.credentials[0],'Bearer new-key');
  const rejected=await setup({hash:'',storage:first.storage,unauthorized:true});
  assert.match(rejected.document.body.textContent!,/no longer valid/);
  assert.equal(rejected.document.querySelectorAll('.tree-file').length,0);
  assert.equal((await setup({hash:'',storage:first.storage})).calls.length,0);
});

test('blocked or malformed storage does not prevent opening a valid key link',async()=>{
  const blocked=await setup({storageUnavailable:true});
  assert.equal(blocked.document.querySelector('.markdown-document h1')?.textContent,'First requirements');
  const valid=await setup();
  for(const key of valid.storage.keys())valid.storage.set(key,'not json');
  const malformed=await setup({hash:'',storage:valid.storage});
  assert.equal(malformed.calls.length,0);
  assert.match(malformed.document.body.textContent!,/private dashboard link/);
});


test('unknown predecessor is disclosed and reading stays available until a baseline is chosen',async()=>{
  const {document,calls}=await setup({unknownPredecessor:true});
  (document.querySelectorAll('.history-pick')[1] as any).click();
  for(let i=0;i<3;i++)await turn();
  assert.ok(document.querySelector('[aria-label="Rendered document"]'));
  assert.match(document.querySelector('.history-sidebar')!.textContent!,/earlier version is unavailable/);
  const baseline=document.querySelector('[aria-label="Compare to"]') as any;
  for(const option of baseline.children)option.selected=false;[...baseline.children].find(option=>option.value==='spec:new').selected=true;baseline.onchange();
  for(let i=0;i<3;i++)await turn();
  assert.ok(document.querySelector('[aria-label="Rendered changes"]'));
  assert.equal(calls.filter(c=>c.action==='review.compare').at(-1)!.input.beforeVersion,'spec:new');
});


const clickText=(document:any,text:string)=>[...document.querySelectorAll('button')].find((b:any)=>b.textContent===text)!.click();
async function saveNote(ui:any,note:string) {
  clickText(ui.document,'Request changes');
  const editor=ui.document.querySelector('#review-note');editor.value=note;editor.oninput();
  ui.document.querySelector('.review-note-form').onsubmit({preventDefault(){}});
  for(let i=0;i<8;i++)await turn();
}

test('review buttons bind the exact comparison and saved notes survive a reload',async()=>{
  const ui=await setup();
  await saveNote(ui,'Please simplify the search flow. <script>inert</script>');
  const submit=ui.calls.find((call:any)=>call.action==='review.submit')!;
  assert.deepEqual(submit.input.target,{kind:'document',projectId:'one',path:'spec/PRD.md',beforeVersion:'git:old',afterVersion:'spec:new'});
  assert.equal(submit.input.decision,'request_changes');
  assert.equal(submit.input.note,'Please simplify the search flow. <script>inert</script>');
  assert.match(ui.document.querySelector('.review-success')!.textContent!,/project inbox/);
  const reloaded=await setup({reviewStore:ui.reviewStore});
  assert.match(reloaded.document.querySelector('.saved-feedback')!.textContent!,/Please simplify the search flow/);
  assert.equal(reloaded.document.querySelectorAll('.saved-feedback script').length,0);
  clickText(reloaded.document,'Accept changes');for(let i=0;i<8;i++)await turn();
  const accept=reloaded.calls.find(call=>call.action==='review.submit')!;
  assert.equal(accept.input.decision,'accept');assert.equal(accept.input.fingerprint,'review-v1');
  assert.ok([...reloaded.document.querySelectorAll('button')].find(b=>b.textContent==='Accepted')!.disabled);
});

test('a lost response keeps the note and retries the same submission without duplicating it',async()=>{
  const ui=await setup({loseSubmitResponse:true});await saveNote(ui,'Keep this feedback after a network failure.');
  assert.equal(ui.document.querySelector('textarea')?.value,'Keep this feedback after a network failure.');
  assert.match(ui.document.querySelector('.review-error')!.textContent!,/try again/);
  (ui.document.querySelector('.review-note-form') as any).onsubmit({preventDefault(){}});
  for(let i=0;i<8;i++)await turn();
  const submits=ui.calls.filter(call=>call.action==='review.submit');
  assert.equal(submits.length,2);assert.equal(submits[0].input.submissionId,submits[1].input.submissionId);
  assert.equal(ui.reviewStore.size,1);assert.ok(ui.document.querySelector('.review-success'));
});

test('draft review notes stay attached to their exact target when navigating history',async()=>{
  const ui=await setup();clickText(ui.document,'Request changes');
  const note=ui.document.querySelector('textarea')!;note.value='For the latest version only.';note.oninput!({} as any);
  (ui.document.querySelectorAll('.history-pick')[1] as any).click();for(let i=0;i<4;i++)await turn();
  assert.equal(ui.document.querySelector('textarea'),null);
  (ui.document.querySelectorAll('.history-pick')[0] as any).click();for(let i=0;i<4;i++)await turn();
  assert.equal(ui.document.querySelector('textarea')?.value,'For the latest version only.');
});


test('saving a review while switching projects cannot attach its note or success state to the new project',async()=>{
  const ui=await setup();ui.holdNextSubmission();await saveNote(ui,'Only for the first project.');
  const project=ui.document.querySelector('[aria-label="Project"]') as any;
  project.children[0].selected=false;project.children[1].selected=true;project.onchange();
  for(let i=0;i<6;i++)await turn();
  ui.releaseComparison();for(let i=0;i<8;i++)await turn();
  assert.equal(ui.document.querySelector('.markdown-document h1')?.textContent,'Second requirements');
  assert.equal(ui.document.querySelector('.review-success'),null);
  assert.equal(ui.document.querySelector('.saved-feedback'),null);
  assert.equal([...ui.reviewStore.values()][0].target.projectId,'one');
});


test('task review refuses a prepared candidate different from the displayed diff',async()=>{
  const ui=await setup({taskReview:'mismatch'});clickText(ui.document,'Board');for(let i=0;i<6;i++)await turn();(ui.document.querySelector('.board-card') as any).click();for(let i=0;i<6;i++)await turn();
  assert.match(ui.document.querySelector('.review-error')!.textContent!,/result changed while its diff was loading/);
  assert.ok([...ui.document.querySelectorAll('button')].find(b=>b.textContent==='Accept changes')!.disabled);
  assert.equal(ui.calls.filter(call=>call.action==='review.submit').length,0);
});

test('task acceptance targets the entire displayed result',async()=>{
  const ui=await setup({taskReview:'match'});clickText(ui.document,'Board');for(let i=0;i<6;i++)await turn();(ui.document.querySelector('.board-card') as any).click();for(let i=0;i<6;i++)await turn();
  assert.match(ui.document.querySelector('.review-decision')!.textContent!,/whole work result/);
  clickText(ui.document,'Accept changes');for(let i=0;i<8;i++)await turn();
  const submit=ui.calls.find(call=>call.action==='review.submit')!;
  assert.deepEqual(submit.input.target,{kind:'task',projectId:'one',taskId:'result'});
});
