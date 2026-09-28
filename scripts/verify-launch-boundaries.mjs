import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,chmodSync,symlinkSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const source=resolve(process.argv[2] ?? fileURLToPath(new URL('..',import.meta.url)));
const {App}=await import(pathToFileURL(join(source,'src/app.ts')));
const owner={role:'owner',id:'independent-fixture-review'};
const results=[];
const oldPath=process.env.PATH;
function git(root,...args){return execFileSync('/usr/bin/git',['-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();}
async function fixture(){
  const root=mkdtempSync('/private/tmp/wimzo-independent-launch-');
  mkdirSync(join(root,'spec'));mkdirSync(join(root,'bin'));
  writeFileSync(join(root,'.gitignore'),'.state/\nbin/\n');
  writeFileSync(join(root,'spec/PRD.md'),'**H-023 Bounded task.** Exact approved source and execution constraints.\n');
  writeFileSync(join(root,'sentinel.txt'),'canonical untouched\n');
  git(root,'init');git(root,'add','.');git(root,'commit','-m','isolated fixture');
  const commit=git(root,'rev-parse','HEAD');
  const fake=join(root,'bin/codex');
  writeFileSync(fake,`#!${process.execPath}\nif(process.argv.includes('status')) console.error('Logged in using ChatGPT'); else if(process.argv.includes('exec')) console.log(JSON.stringify({fixture:true,cwd:process.cwd()})); else console.log('codex-cli fixture');\n`);chmodSync(fake,0o755);
  process.env.PATH=join(root,'bin')+':/usr/bin:/bin';
  const app=new App(join(root,'.state'));
  const call=(action,input)=>app.call(action,input,owner);
  await call('project.register',{id:'fixture',name:'Fixture',root,purpose:'Independent isolated launch review',canonicalPaths:['spec/PRD.md']});
  const spec=await call('spec.capture',{projectId:'fixture',path:'spec/PRD.md'});
  await call('spec.accept',{specId:spec.id,hash:spec.hash,expectedRev:spec.rev,decision:'Accept isolated fixture only',source:'independent deterministic test'});
  const input={id:'bounded-fixture',projectId:'fixture',specId:spec.id,specHash:spec.hash,requirements:['H-023'],objective:'Synthetic fixture only',criteria:['fixture passes'],scope:'No inference and no external effects',permissions:['read','write'],budget:{maxExecutionMs:5000},deadline:new Date(Date.now()+60000).toISOString(),sourceCandidate:{id:commit,commit},runtime:'codex',worktree:join(root,'.state/worktrees/bounded-fixture'),resources:[join(root,'.state/worktrees/bounded-fixture')]};
  return {root,commit,app,call,input,close:async()=>{await app.close();process.env.PATH=oldPath;}};
}
async function test(name,body){const f=await fixture();try{await body(f);results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e)});}finally{await f.close();}}
async function approve(f,change={}){const input={...f.input,...change};for(const key of Object.keys(input))if(input[key]===undefined)delete input[key];const task=await f.call('task.create',input);return (await f.call('task.approve',{taskId:task.id,expectedRev:task.rev,decision:'Approve isolated fixture only',source:'independent deterministic test'})).task;}
for(const [name,change] of [['missing source',{sourceCandidate:undefined}],['empty source',{sourceCandidate:{}}],['missing deadline',{deadline:undefined}],['invalid deadline',{deadline:'invalid'}],['expired deadline',{deadline:'2020-01-01T00:00:00Z'}],['writer isolation disabled',{worktree:false}],['unassigned technical task missing source',{runtime:undefined,sourceCandidate:undefined}],['unassigned technical task missing deadline',{runtime:undefined,deadline:undefined}]]){
  await test('approval rejects '+name,async f=>{let rejected=false;try{await approve(f,change);}catch{rejected=true;}assert.equal(rejected,true);assert.equal(f.app.store.list('run').length,0);});
}
for(const [name,override] of [['worktree disabled',{worktree:false}],['foreign worktree',{worktree:'/private/tmp/foreign-unapproved'}],['longer deadline',{deadline:'2099-01-01T00:00:00Z'}],['shorter deadline',{deadline:new Date(Date.now()+15000).toISOString()}],['additional resource',{resources:['unapproved-gui']}],['different run type',{runType:'script'}],['different runtime',{runtime:'pi'}],['different directory',{cwd:'/private/tmp'}]]){
  await test('direct start rejects '+name+' before side effects',async f=>{
    const task=await approve(f);let rejected=false;
    const effectiveOverride=name==='shorter deadline'?{deadline:new Date(Date.now()+15000).toISOString()}:override;
    try{await f.call('runtime.start',{taskId:task.id,...effectiveOverride});}catch{rejected=true;}
    assert.equal(rejected,true,'start was not rejected');
    assert.equal(f.app.store.list('run').length,0,'a run was claimed before rejection');
    assert.equal(existsSync(f.input.worktree),false,'worktree was created before rejection');
    assert.equal((await f.call('task.get',{taskId:task.id})).state,'Approved');
  });
}
for (const [name, override] of [['runtime',{runtime:'pi'}],['run type',{runType:'script'}],['resources',{resources:['unapproved']}],['worktree',{worktree:'/private/tmp/unapproved'}]]) {
  await test('direct worker claim cannot change approved '+name,async f=>{
    const task=await approve(f);
    await assert.rejects(f.app.call('task.claim',{taskId:task.id,expectedRev:task.rev,...override},{role:'worker',id:'fixture-worker',taskId:task.id}));
    assert.equal(f.app.store.list('run').length,0);
    assert.equal((await f.call('task.get',{taskId:task.id})).rev,task.rev);
  });
}
await test('omitted worktree does not authorize disabling isolation',async f=>{
  const task=await approve(f,{worktree:undefined});
  await assert.rejects(f.call('runtime.start',{taskId:task.id,worktree:false}));
  assert.equal(f.app.store.list('run').length,0);
});
for (const [name, override] of [['directory',{cwd:'/private/tmp'}],['deadline',{deadline:'2099-01-01T00:00:00Z'}]]) {
  await test('task-bound capability cannot override approved '+name,async f=>{
    const task=await approve(f,{runtime:'script',capability:'node.test',capabilityInput:{args:['quick.test.js']},worktree:f.root,resources:[f.root]});
    const worker={role:'worker',id:'fixture-worker',taskId:task.id};
    await f.app.call('task.claim',{taskId:task.id,expectedRev:task.rev},worker);
    await assert.rejects(f.app.call('capability.run',{capability:'node.test',...override},worker));
    assert.equal(f.app.store.list('run').length,1);
  });
}
await test('scheduler rejects legacy missing source before side effects',async f=>{
  const task=await approve(f);const {sourceCandidate,...rest}=task;f.app.store.put('task',{...rest},task.rev);
  await f.call('execution.tick',{});
  assert.equal(f.app.store.list('run').length,0);assert.equal(existsSync(f.input.worktree),false);
  assert.equal((await f.call('task.get',{taskId:task.id})).state,'Approved');
});
await test('foreign repository cannot replace owning canonical repository',async f=>{
  let rejected=false;
  try{await approve(f,{sourceCandidate:{id:f.commit,commit:f.commit,repository:'/private/tmp'},worktree:{repository:'/private/tmp'}});}catch{rejected=true;}
  assert.equal(rejected,true);assert.equal(f.app.store.list('run').length,0);
});
await test('symlinked existing worktree cannot escape canonical project',async f=>{
  const task=await approve(f);mkdirSync(join(f.root,'.state/worktrees'),{recursive:true});symlinkSync('/private/tmp',f.input.worktree);
  let rejected=false;try{await f.call('runtime.start',{taskId:task.id});}catch{rejected=true;}
  assert.equal(rejected,true);assert.equal(f.app.store.list('run').length,0);
});
await test('valid scheduler writer stays isolated and budget caps deadline',async f=>{
  const task=await approve(f);const before=Date.now();const tick=await f.call('execution.tick',{});assert.equal(tick.queue.started.length,1);
  const run=f.app.store.require('run',tick.queue.started[0]);
  assert.equal(run.runtime,'codex');assert.equal(run.sourceCandidate,f.commit);assert.equal(run.cwd,f.input.worktree);assert.deepEqual(run.resources,task.resources);
  assert.ok(Date.parse(run.deadline)<=before+7000,'absolute deadline exceeded approved 5 second budget');
  assert.equal(git(f.input.worktree,'rev-parse','HEAD'),f.commit);assert.equal(readFileSync(join(f.root,'sentinel.txt'),'utf8'),'canonical untouched\n');
  assert.equal(git(f.root,'status','--porcelain'),'');
});
const report={source,at:new Date().toISOString(),total:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results};
console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;
