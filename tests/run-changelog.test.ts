import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';
import { saveWorkerCheckpoint } from '../src/worker-context.ts';

const owner={role:'owner' as const,id:'fixture-owner'};
const system={role:'system' as const,id:'fixture-system'};

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'wimzo-changelog-'));
  mkdirSync(join(root,'spec'));
  writeFileSync(join(root,'.gitignore'),'.state/\n');
  writeFileSync(join(root,'spec','PRD.md'),'**H-044 Run changelogs.** Every run has a changelog.\n');
  writeFileSync(join(root,'quick.test.js'),"import test from 'node:test'; test('quick',()=>{});\n");
  const git=(...args:string[])=>execFileSync('git',['-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:root,encoding:'utf8'}).trim();
  git('init'); git('add','.'); git('commit','-m','fixture');
  const stateDir=join(root,'.state'), store=new Store(join(stateDir,'state.sqlite')), domain=Domain(store);
  const project=domain.call('project.register',{id:'project_changelog',name:'Changelog',root,purpose:'Changelog fixture',canonicalPaths:['spec/PRD.md']},owner);
  const captured=domain.call('spec.capture',{projectId:project.id,path:'spec/PRD.md'},owner);
  const accepted=domain.call('spec.accept',{specId:captured.id,hash:captured.hash,expectedRev:captured.rev,decision:'Accept fixture',source:'changelog test'},owner).spec;
  const task=(overrides:Record<string,any>={})=>{const created=domain.call('task.create',{projectId:project.id,specId:accepted.id,specHash:accepted.hash,requirements:['H-044'],objective:'Add run changelogs',criteria:['Changelog exists'],scope:'Fixture only',permissions:[],budget:{timeoutMs:10000},sourceCandidate:{id:git('rev-parse','HEAD'),specHash:accepted.hash},runtime:'script',capability:'node.test',capabilityInput:{args:['quick.test.js']},resources:[],...overrides},owner);return domain.call('task.approve',{taskId:created.id,expectedRev:created.rev,decision:'Approve',source:'changelog test'},owner).task;};
  return {root,stateDir,store,domain,project,task};
}

async function waitFor<T>(read:()=>Promise<T>|T,done:(value:T)=>boolean):Promise<T> {
  const until=Date.now()+15000;
  while(Date.now()<until){const value=await read();if(done(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Timed out');
}

test('run.changelog is exposed for chat retrieval by project, task or run',async()=>{
  const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const descriptor:any=execution.actions().find((item:any)=>item.name==='run.changelog');
    assert.deepEqual(descriptor.roles,['owner','guide','worker','system']);
    assert.deepEqual(Object.keys(descriptor.inputSchema.properties).sort(),['limit','projectId','runId','taskId']);
    await assert.rejects(()=>execution.call('run.changelog',{},owner),/projectId, taskId or runId is required/);
  }finally{await execution.close();f.store.close();}
});

test('a completed run without a worker account says nothing new is available and survives a restart',async()=>{
  const f=fixture();let execution=Execution(f.store,f.domain,f.stateDir);
  const task=f.task();
  await execution.tick();
  await waitFor(async()=>{await execution.tick();return f.store.require<any>('task',task.id)},value=>value.state==='Verifying');
  const [entry]=(await execution.call('run.changelog',{taskId:task.id},owner)).entries;
  assert.equal(entry.outcome,'completed');assert.equal(entry.possibleNow,'Nothing new is available to use yet.');
  assert.match(entry.changed,/No user-facing change was reported/);assert.match(entry.availability,/candidate awaiting verification.*not active/);
  assert.equal(entry.attempt,1);assert.deepEqual(entry.earlierAttempts,[]);assert.ok(entry.evidence.logs.stdout);
  await execution.close();f.store.close();
  const store=new Store(join(f.stateDir,'state.sqlite'));execution=Execution(store,Domain(store),f.stateDir);
  try{
    const [restored]=(await execution.call('run.changelog',{projectId:f.project.id},owner)).entries;
    assert.equal(restored.runId,entry.runId);assert.equal(restored.outcome,'completed');assert.equal(restored.changed,entry.changed);
  }finally{await execution.close();store.close();}
});

test('an interrupted run keeps its last saved account, marks unknowns and a retry links the earlier attempt',async()=>{
  const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const task=f.task({runtime:'pi',capability:undefined,capabilityInput:undefined,deadline:new Date(Date.now()+60_000).toISOString()});
    const claimed=f.domain.call('task.claim',{taskId:task.id,expectedRev:task.rev,workerId:'changelog-worker',runType:'technical'},system);
    saveWorkerCheckpoint(f.store,task.id,claimed.run.id,{summary:'Planned the changelog store',changelog:{changed:'Runs now keep a readable account of their outcome.',possibleNow:'Ask in chat what a run changed.',limits:['Only saved in the candidate so far.']}});
    assert.equal(f.store.require<any>('run_changelog',claimed.run.id).outcome,'in_progress');
    const run=f.store.require<any>('run',claimed.run.id);f.store.put('run',{...run,status:'paused',state:'Paused',launchState:'outcome-unknown',error:'Process ended without a durable final status'},run.rev);
    const [interrupted]=(await execution.call('run.changelog',{runId:run.id},owner)).entries;
    assert.equal(interrupted.outcome,'interrupted');assert.equal(interrupted.changed,'Runs now keep a readable account of their outcome.');
    assert.match(interrupted.unknowns.join(' '),/without a final report/);assert.match(interrupted.availability,/did not deliver a usable change/);
    assert.ok(interrupted.limits.includes('Only saved in the candidate so far.'));assert.ok(interrupted.limits.some((item:string)=>/durable final status/.test(item)));
    assert.equal(interrupted.progress[0].summary,'Planned the changelog store');
    const current=f.store.require<any>('task',task.id);
    f.domain.call('task.fail',{taskId:current.id,expectedRev:current.rev,runId:run.id,reason:'Interrupted fixture'},system);
    const failed=f.store.require<any>('task',task.id);
    const requested=f.domain.call('task.control',{taskId:failed.id,expectedRev:failed.rev,command:'resume'},owner);
    const resumed=f.domain.call('task.ack',{taskId:task.id,expectedRev:requested.rev,command:'resume'},system);
    const again=f.domain.call('task.claim',{taskId:resumed.id,expectedRev:resumed.rev,workerId:'changelog-worker',runType:'technical'},system);
    assert.ok(again.run,JSON.stringify(again.reasons));
    const entries=(await execution.call('run.changelog',{taskId:task.id},owner)).entries;
    assert.deepEqual(entries.map((item:any)=>item.runId),[again.run.id,run.id]);
    assert.equal(entries[0].attempt,2);assert.deepEqual(entries[0].earlierAttempts.map((item:any)=>item.runId),[run.id]);
    assert.equal(entries[0].changed,'No user-facing change was completed in this run.');assert.equal(entries[0].outcome,'in_progress');
    const worker={role:'worker' as const,id:'changelog-worker',taskId:'task_other'};
    await assert.rejects(async()=>execution.call('run.changelog',{runId:run.id},worker),/not bound/);
  }finally{await execution.close();f.store.close();}
});
