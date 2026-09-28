import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';

const owner={role:'owner' as const,id:'fixture-owner'};
const system={role:'system' as const,id:'fixture-system'};

function git(cwd:string,...args:string[]):string {
  return execFileSync('git',['-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Wimzo Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Wimzo Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
}

function fixture(stateOutsideProject = false) {
  const container=mkdtempSync(join(tmpdir(),'wimzo-execution-'));
  const root=stateOutsideProject ? join(container,'project') : container;
  if (stateOutsideProject) mkdirSync(root);
  mkdirSync(join(root,'spec'));
  writeFileSync(join(root,'.gitignore'),'.state/\n');
  writeFileSync(join(root,'spec','PRD.md'),'**H-024 Capacity queue.** Approved work waits for capacity.\n');
  writeFileSync(join(root,'quick.test.js'),"import test from 'node:test'; import assert from 'node:assert/strict'; test('quick',()=>assert.equal(2+2,4));\n");
  writeFileSync(join(root,'slow.test.js'),"import test from 'node:test'; test('slow',async()=>{await new Promise(resolve=>setTimeout(resolve,30000))});\n");
  writeFileSync(join(root,'writer.test.js'),"import test from 'node:test'; import {appendFileSync,writeFileSync} from 'node:fs'; test('writer',()=>{appendFileSync('quick.test.js','// worktree change\\n');writeFileSync('untracked-result.txt','synthetic result\\n')});\n");
  git(root,'init'); git(root,'add','.'); git(root,'commit','-m','fixture baseline');
  const candidate=git(root,'rev-parse','HEAD');
  const stateDir=stateOutsideProject ? join(container,'state') : join(root,'.state');
  const store=new Store(join(stateDir,'state.sqlite'));
  const domain=Domain(store);
  const project=domain.call('project.register',{id:'project_fixture',name:'Fixture',root,purpose:'Execution integration fixture',canonicalPaths:['spec/PRD.md']},owner);
  const captured=domain.call('spec.capture',{projectId:project.id,path:'spec/PRD.md'},owner);
  const accepted=domain.call('spec.accept',{specId:captured.id,hash:captured.hash,expectedRev:captured.rev,decision:'Accept fixture specification',source:'isolated execution test'},owner).spec;
  return {root,stateDir,store,domain,project,accepted,candidate};
}

function approvedTask(f:any,overrides:Record<string,any>={}) {
  const task=f.domain.call('task.create',{
    projectId:f.project.id,specId:f.accepted.id,specHash:f.accepted.hash,requirements:['H-024'],
    objective:'Run a deterministic fixture check',criteria:['The check exits successfully'],scope:'Fixture repository only',permissions:[],budget:{timeoutMs:10000},
    sourceCandidate:{id:f.candidate,specHash:f.accepted.hash},runtime:'script',capability:'node.test',capabilityInput:{args:['quick.test.js']},resources:[],...overrides,
  },owner);
  return f.domain.call('task.approve',{taskId:task.id,expectedRev:task.rev,decision:'Approve fixture task',source:'isolated execution test'},owner).task;
}

async function waitFor<T>(read:()=>Promise<T>,done:(value:T)=>boolean,timeoutMs=8000):Promise<T> {
  const deadline=Date.now()+timeoutMs; let value=await read();
  while(!done(value)&&Date.now()<deadline) { await new Promise(resolve=>setTimeout(resolve,50)); value=await read(); }
  assert.ok(done(value),`Condition was not met before timeout: ${JSON.stringify(value)}`);
  return value;
}

test('runtime probe accepts Codex ChatGPT status on stderr and separates install from eligibility',async()=>{
  const f=fixture(); const bin=join(f.root,'fake-bin'); mkdirSync(bin);
  const cli=(name:string,body:string)=>{const path=join(bin,name);writeFileSync(path,`#!${process.execPath}\n${body}\n`);chmodSync(path,0o755)};
  cli('codex',"if(process.argv.includes('status')) console.error('Logged in using ChatGPT'); else console.log('codex-cli fixture')");
  cli('claude',"if(process.argv.includes('status')) console.log(JSON.stringify({loggedIn:false,authMethod:'none'})); else console.log('claude fixture')");
  cli('pi',"if(process.argv.includes('--list-models')) console.log('openai-codex  gpt-5.6-luna'); else console.log('pi fixture')");
  const oldPath=process.env.PATH; process.env.PATH=`${bin}:${oldPath}`;
  try {
    const execution=Execution(f.store,f.domain,f.stateDir,{discoverPi:async()=>({installed:true,authKind:'subscription',availableModels:[{id:'fixture-pi-model',provider:'openai-codex',contextWindow:200000,thinkingSupport:['low']}]})});
    const runtimes:any[]=await execution.call('runtime.capabilities',{refresh:true},owner);
    assert.equal(runtimes.find(item=>item.name==='codex').eligible,true);
    assert.equal(runtimes.find(item=>item.name==='claude').available,true);
    assert.equal(runtimes.find(item=>item.name==='claude').eligible,false);
    const claude=runtimes.find(item=>item.name==='claude');
    assert.equal(claude.provider,'anthropic');
    assert.equal(claude.authRoute,'subscription');
    assert.deepEqual(claude.models.map((model:any)=>model.id).sort(),['claude-haiku-4-5-20251001','claude-opus-5-5','claude-sonnet-5']);
    assert.equal(runtimes.find(item=>item.name==='pi').eligible,true);
    assert.equal(runtimes.find(item=>item.name==='pi').models[0].id,'fixture-pi-model');
    await execution.close();
  } finally { process.env.PATH=oldPath; f.store.close(); }
});

test('detached capability survives execution service restart and its launch key is idempotent',async()=>{
  const f=fixture();
  const first=Execution(f.store,f.domain,f.stateDir);
  const run=await first.call('capability.run',{capability:'node.test',input:{args:['quick.test.js']},cwd:f.root,idempotencyKey:'same-check'},owner);
  await first.close();
  const restarted=Execution(f.store,f.domain,f.stateDir);
  const duplicate=await restarted.call('capability.run',{capability:'node.test',input:{args:['quick.test.js']},cwd:f.root,idempotencyKey:'same-check'},owner);
  assert.equal(duplicate.id,run.id);
  const finished:any=await waitFor(()=>restarted.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='completed');
  assert.equal(finished.exitCode,0);
  assert.equal(f.store.events().filter(event=>event.type==='run.started'&&event.data.runId===run.id).length,1);
  const result=await restarted.call('runtime.collect_result',{runId:run.id},owner);
  assert.equal(result.status,'completed');
  assert.ok(existsSync(result.logs.stdout));
  await restarted.close(); f.store.close();
});

test('detached process cancellation stops its process group and persists an accurate acknowledgement',async()=>{
  const f=fixture(); const execution=Execution(f.store,f.domain,f.stateDir);
  const run:any=await execution.call('capability.run',{capability:'node.test',input:{args:['slow.test.js']},cwd:f.root},owner);
  const running:any=await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='running'&&Boolean(value.childPid));
  const canceled:any=await execution.call('runtime.cancel',{runId:run.id},owner);
  assert.equal(canceled.status,'canceled');
  assert.equal(canceled.cancellationAcknowledged,true);
  assert.throws(()=>process.kill(-running.processGroupId,0));
  await execution.close(); f.store.close();
});

test('worker capability keys are isolated by parent task and do not complete the parent task',async()=>{
 const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
 try{
  const workers=[0,1].map(index=>{const task=approvedTask(f);const actor={role:'worker' as const,id:`worker-${index}`,taskId:task.id};const claimed=f.domain.call('task.claim',{taskId:task.id,expectedRev:task.rev,workerId:actor.id,runType:'script'},actor);assert.equal(claimed.claimed,true);return {task:claimed.task,actor};});
  const input={capability:'node.test',input:{args:['quick.test.js']},idempotencyKey:'same-worker-check'};
  const first=await execution.call('capability.run',input,workers[0].actor),second=await execution.call('capability.run',input,workers[1].actor);
  assert.notEqual(first.id,second.id);assert.equal(first.parentTaskId,workers[0].task.id);assert.equal(first.parentRunId,workers[0].task.runId);assert.equal(first.projectId,f.project.id);
  assert.equal((await execution.call('capability.run',input,workers[0].actor)).id,first.id);
  await assert.rejects(execution.call('runtime.inspect',{runId:first.id},workers[1].actor),/not bound/);
  await waitFor(()=>execution.call('runtime.inspect',{runId:first.id},workers[0].actor),run=>run.status==='completed');
  await execution.call('runtime.collect_result',{runId:first.id},workers[0].actor);
  assert.equal(f.store.require<any>('task',workers[0].task.id).state,'Running');
 }finally{await execution.close();f.store.close();}
});

test('candidate collection rejects a clean unrelated Git history after worker execution',async()=>{
 const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
 try{
  const orphan=git(f.root,'commit-tree',git(f.root,'rev-parse','HEAD^{tree}'),'-m','Unrelated fixture history');
  const cwd=join(f.stateDir,'worktrees','unrelated');git(f.root,'worktree','add','--detach',cwd,f.candidate);
  writeFileSync(join(cwd,'quick.test.js'),`import test from 'node:test';import {execFileSync} from 'node:child_process';test('switch history',()=>execFileSync('git',['reset','--hard',${JSON.stringify(orphan)}]));\n`);
  const task=approvedTask(f,{worktree:cwd});const run=await execution.call('runtime.start',{taskId:task.id},owner);
  await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='completed');
  await assert.rejects(execution.call('runtime.collect_result',{runId:run.id},owner),/does not descend/);
  assert.equal(f.store.require<any>('task',task.id).candidate,undefined);
 }finally{await execution.close();f.store.close();}
});

test('the detached wrapper enforces its deadline after the execution service closes',async()=>{
  const f=fixture(); const first=Execution(f.store,f.domain,f.stateDir);
  const run:any=await first.call('capability.run',{capability:'node.test',input:{args:['slow.test.js']},cwd:f.root,deadline:new Date(Date.now()+350).toISOString()},owner);
  await first.close();
  const restarted=Execution(f.store,f.domain,f.stateDir);
  const failed:any=await waitFor(()=>restarted.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='failed');
  assert.match(failed.error,/deadline/i);
  assert.equal(failed.launchState,'finished');
  await restarted.close(); f.store.close();
});

test('runtime threshold stops new launches, checkpoints active work, and abrupt loss does not relaunch',async()=>{
  const f=fixture();
  const activeTask=approvedTask(f,{capabilityInput:{args:['slow.test.js']}});
  const execution=Execution(f.store,f.domain,f.stateDir);
  const active:any=await execution.call('runtime.start',{taskId:activeTask.id,runtime:'script',runType:'script'},owner);
  const running:any=await waitFor(()=>execution.call('runtime.inspect',{runId:active.id},owner),value=>value.status==='running'&&Boolean(value.processGroupId));
  const waitingTask=approvedTask(f);
  const limit:any=await execution.call('runtime.limit_set',{runtime:'script',providerRemaining:5,providerUnit:'jobs',warningThreshold:{providerRemaining:10},contextUsed:null,contextCapacity:null,taskTimeoutMs:10000,source:'fixture telemetry'},owner);
  assert.equal(limit.provider.status,'known'); assert.equal(limit.context.status,'unknown');
  const tick:any=await execution.tick();
  assert.equal(tick.queue.started.length,0);
  assert.match(tick.queue.waiting.find((item:any)=>item.taskId===waitingTask.id).reason,/runtime_limit/);
  assert.ok(f.store.list<any>('checkpoint').some(item=>item.taskId===activeTask.id&&String(item.id).includes('runtime-limit')));
  process.kill(-running.processGroupId,'SIGKILL');
  await new Promise(resolve=>setTimeout(resolve,100));
  await execution.tick();
  assert.equal(f.store.require<any>('task',activeTask.id).state,'Paused');
  assert.equal(f.store.events().filter(event=>event.type==='run.started'&&event.data.runId===active.id).length,1);
  assert.equal((await execution.call('runtime.limits',{runtime:'script'},owner)).source,'fixture telemetry');
  await execution.close(); f.store.close();
});

test('approved script task dispatches once, finishes after restart, and stops at Verifying',async()=>{
  const f=fixture(); const task=approvedTask(f);
  const first=Execution(f.store,f.domain,f.stateDir);
  const dispatched=await first.tick();
  assert.equal(dispatched.queue.started.length,1);
  const runId=dispatched.queue.started[0];
  await first.close();
  const restarted=Execution(f.store,f.domain,f.stateDir);
  await waitFor(async()=>{await restarted.tick(); return f.store.require<any>('task',task.id)},value=>value.state==='Verifying');
  assert.equal(f.store.require<any>('task',task.id).state,'Verifying');
  assert.equal(f.store.require<any>('task',task.id).candidate.id,f.candidate);
  assert.equal(f.store.require<any>('run',runId).resultReported,true);
  assert.equal(f.store.list<any>('run').filter(run=>run.taskId===task.id).length,1);
  assert.equal(f.store.list<any>('approval').filter(item=>item.kind==='task'&&item.subjectId===task.id).length,1);
  await restarted.close(); f.store.close();
});

test('approved script uses its persisted worktree and reports a dirty candidate fingerprint',async()=>{
  const f=fixture();const approvedWorktree=join(f.stateDir,'approved-script-worktree');
  git(f.root,'worktree','add','--detach',approvedWorktree,f.candidate);
  const original=readFileSync(join(f.root,'quick.test.js'),'utf8');
  const task=approvedTask(f,{worktree:approvedWorktree,capabilityInput:{args:['writer.test.js']}});
  const execution=Execution(f.store,f.domain,f.stateDir);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script',worktree:f.root},owner),/Worktree differs/);
  const run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script'},owner);
  assert.equal(run.cwd,realpathSync(approvedWorktree));
  const finished:any=await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='completed');
  await execution.call('runtime.collect_result',{runId:finished.id},owner);
  const candidate=f.store.require<any>('task',task.id).candidate;
  assert.match(candidate.id,/^sha256:[0-9a-f]{64}$/);assert.equal(candidate.baseCommit,f.candidate);assert.equal(candidate.worktreeDigest,candidate.id.slice(7));
  assert.match(candidate.diffDigest,/^[0-9a-f]{64}$/);assert.match(candidate.untrackedDigest,/^[0-9a-f]{64}$/);assert.equal(candidate.dirty,true);
  assert.equal(readFileSync(join(f.root,'quick.test.js'),'utf8'),original);assert.equal(readFileSync(join(approvedWorktree,'untracked-result.txt'),'utf8'),'synthetic result\n');
  await execution.close();f.store.close();
});

test('approved script rejects a sibling path that only shares the project prefix',async()=>{
  const f=fixture();const sibling=`${f.root}-sibling`;mkdirSync(sibling);
  const task=approvedTask(f,{worktree:sibling});const execution=Execution(f.store,f.domain,f.stateDir);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script'},owner),/outside the task project/);
  assert.equal(f.store.require<any>('task',task.id).state,'Approved');
  assert.equal(f.store.list('run').length,0);
  await execution.close();f.store.close();
});

test('approved script honors budget maxExecutionMs',async()=>{
  const f=fixture();const task=approvedTask(f,{budget:{maxExecutionMs:1000},capabilityInput:{args:['slow.test.js']}});
  const execution=Execution(f.store,f.domain,f.stateDir);
  const run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script'},owner);
  const duration=Date.parse(run.deadline)-Date.parse(run.createdAt);assert.ok(duration>=800&&duration<=1500,`unexpected task deadline ${duration}`);
  const failed:any=await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='failed',5000);
  assert.match(failed.error,/deadline/i);await execution.call('runtime.collect_result',{runId:run.id},owner);
  assert.equal(f.store.require<any>('task',task.id).state,'Failed');assert.equal(f.store.require<any>('run',run.id).state,'Failed');
  await execution.close();f.store.close();
});

test('a fresh continuation cannot reset execution time already consumed by a stopped run',async()=>{
  const f=fixture();const task=approvedTask(f,{budget:{maxExecutionMs:500}});
  const endedAt=new Date(Date.now()-1_000).toISOString();
  f.store.put<any>('run',{id:'prior-stopped-run',taskId:task.id,projectId:task.projectId,runtime:'script',runType:'script',state:'Paused',status:'paused',startedAt:new Date(Date.now()-2_000).toISOString(),finishedAt:endedAt});
  const execution=Execution(f.store,f.domain,f.stateDir);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script'},owner),/Execution budget is exhausted/);
  assert.equal(f.store.require<any>('task',task.id).state,'Approved');
  await execution.close();f.store.close();
});

test('queued task controls handle no-run pause and resume without launching unavailable work',async()=>{
  const f=fixture(); const task=approvedTask(f,{runtime:'unavailable-runtime',capability:undefined,capabilityInput:undefined});
  const execution=Execution(f.store,f.domain,f.stateDir);
  let current=f.store.require<any>('task',task.id);
  f.domain.call('task.control',{taskId:task.id,expectedRev:current.rev,command:'pause'},owner);
  await execution.tick(); current=f.store.require<any>('task',task.id);
  assert.equal(current.state,'Paused');
  f.domain.call('task.control',{taskId:task.id,expectedRev:current.rev,command:'resume'},owner);
  const resumed=await execution.tick(); current=f.store.require<any>('task',task.id);
  assert.equal(current.state,'Approved');
  assert.match(resumed.queue.waiting.find((item:any)=>item.taskId===task.id).reason,/runtime_unavailable/);
  await execution.close(); f.store.close();
});

test('paused worker continuation preserves a materialized dirty candidate across restart without a ghost capacity run',async()=>{
  const f=fixture();const worktree=join(f.stateDir,'resume-worktree');git(f.root,'worktree','add','--detach',worktree,f.candidate);
  const resumed=approvedTask(f,{worktree,capabilityInput:{args:['slow.test.js']}});
  const queued=approvedTask(f,{capabilityInput:{args:['slow.test.js']}});
  const first=Execution(f.store,f.domain,f.stateDir);
  const pausedRun:any=await first.call('runtime.start',{taskId:resumed.id,runtime:'script',runType:'script'},owner);
  await waitFor(()=>first.call('runtime.inspect',{runId:pausedRun.id},owner),value=>value.status==='running');
  writeFileSync(join(worktree,'resume-handoff.txt'),'durable dirty continuation\n');
  let task=f.store.require<any>('task',resumed.id);f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'pause'},owner);
  await first.tick();task=f.store.require<any>('task',resumed.id);const stopped=f.store.require<any>('run',pausedRun.id);
  assert.equal(task.state,'Paused');assert.equal(stopped.status,'paused');assert.equal(stopped.checkpointCandidate.dirty,true);assert.equal(typeof stopped.checkpointCandidate.materializedCommit,'string');assert.equal(git(worktree,'show',`${stopped.checkpointCandidate.materializedCommit}:resume-handoff.txt`),'durable dirty continuation');
  await first.close();
  const restarted=Execution(f.store,f.domain,f.stateDir);
  f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'resume'},owner);
  const resumedTick:any=await restarted.tick();task=f.store.require<any>('task',resumed.id);
  assert.equal(task.state,'Running');
  assert.equal(f.store.require<any>('run',pausedRun.id).state,'Paused');
  assert.equal(f.store.list<any>('run').filter(run=>run.taskId===resumed.id).length,2);
  assert.equal(f.store.require<any>('task',queued.id).state,'Running');
  assert.equal(resumedTick.queue.started.length,1);
  for(const taskId of [resumed.id,queued.id]){const active=f.store.require<any>('task',taskId);f.domain.call('task.control',{taskId,expectedRev:active.rev,command:'cancel'},owner);}
  await restarted.tick();await restarted.close();f.store.close();
});

test('resume remains paused when its preserved worktree is unavailable',async()=>{
  const f=fixture();const task=approvedTask(f);const run=f.store.put<any>('run',{id:'missing-resume-run',taskId:task.id,projectId:task.projectId,runtime:'script',runType:'script',state:'Paused',status:'paused',cwd:join(f.root,'missing-worktree'),checkpointCandidate:{id:'sha256:missing',baseCommit:f.candidate,dirty:true,specHash:f.accepted.hash,materializedCommit:f.candidate}});
  const paused=f.store.put<any>('task',{...task,state:'Paused',runId:run.id,pausedFrom:'Running'},task.rev);
  const execution=Execution(f.store,f.domain,f.stateDir);f.domain.call('task.control',{taskId:paused.id,expectedRev:paused.rev,command:'resume'},owner);await execution.tick();
  const current=f.store.require<any>('task',task.id);assert.equal(current.state,'Paused');assert.equal(current.requested.command,'resume');assert.match(f.store.require<any>('run',run.id).resumeBlockedReason,/worktree is unavailable/);
  await execution.close();f.store.close();
});

test('task cancellation is acknowledged only after the detached process group stops and a checkpoint persists',async()=>{
  const f=fixture(); const task=approvedTask(f,{capabilityInput:{args:['slow.test.js']}});
  const execution=Execution(f.store,f.domain,f.stateDir);
  const run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script'},owner);
  await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='running'&&Boolean(value.childPid));
  let current=f.store.require<any>('task',task.id);
  f.domain.call('task.control',{taskId:task.id,expectedRev:current.rev,command:'cancel'},owner);
  await execution.tick(); current=f.store.require<any>('task',task.id);
  assert.equal(current.state,'Canceled');
  assert.equal(current.acknowledged.command,'cancel');
  assert.equal(f.store.require<any>('run',run.id).cancellationAcknowledged,true);
  assert.ok(f.store.list<any>('checkpoint').some(item=>item.taskId===task.id&&item.runId===run.id));
  await execution.close(); f.store.close();
});

test('runtime start is bound to the approved runtime, capability input, and GUI run type',async()=>{
  const f=fixture(); const task=approvedTask(f);
  const execution=Execution(f.store,f.domain,f.stateDir);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script',capability:'git.validate'},owner),/Capability differs/);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'script',runType:'script',capabilityInput:{args:['slow.test.js']}},owner),/input differs/);
  assert.equal(f.store.require<any>('task',task.id).state,'Approved');
  assert.equal(f.store.list<any>('run').filter(run=>run.taskId===task.id).length,0);

  const guiTask=approvedTask(f,{runtime:'codex-app',capability:undefined,capabilityInput:undefined});
  await assert.rejects(()=>execution.call('runtime.start',{taskId:guiTask.id,runtime:'codex-app',runType:'technical'},owner),/requires runType gui/);
  assert.equal(f.store.require<any>('task',guiTask.id).state,'Approved');
  const waiting:any=await execution.call('runtime.start',{taskId:guiTask.id,runtime:'codex-app',runType:'gui'},owner);
  assert.equal(waiting.status,'awaiting_session');
  assert.equal(waiting.runType,'gui');
  await execution.call('runtime.cancel',{runId:waiting.id},owner);
  await execution.close(); f.store.close();
});

test('native controls remain pending until the bound app worker acknowledges them',async()=>{
  const f=fixture();let task=approvedTask(f,{runtime:'codex-app',capability:undefined,capabilityInput:undefined});
  const execution=Execution(f.store,f.domain,f.stateDir);let run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'codex-app',runType:'gui'},owner);
  const worker={role:'worker' as const,id:`execution:${task.id}`,taskId:task.id};
  for(const command of ['checkpoint','pause'] as const) {
    task=f.store.require<any>('task',task.id);f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command},owner);
    const tick=await execution.tick();task=f.store.require<any>('task',task.id);
    assert.equal(task.requested.command,command);assert.ok(!tick.controls.includes(task.id));
    task=f.domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command,checkpoint:{summary:`native ${command}`}},worker);
  }
  run=await execution.call('runtime.inspect',{runId:run.id},owner);assert.equal(run.status,'paused');assert.equal(task.state,'Paused');
  task=f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'resume'},owner);
  await execution.tick();task=f.store.require<any>('task',task.id);assert.equal(task.requested.command,'resume');
  task=f.domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command:'resume'},worker);assert.equal(task.state,'Approved');
  run=await execution.call('runtime.start',{taskId:task.id,runtime:'codex-app',runType:'gui'},owner);
  task=f.store.require<any>('task',task.id);f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'cancel'},owner);
  await execution.tick();task=f.store.require<any>('task',task.id);assert.equal(task.requested.command,'cancel');assert.equal(f.store.require<any>('run',run.id).status,'awaiting_session');
  task=f.domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command:'cancel',checkpoint:{summary:'native cancel'}},worker);
  run=await execution.call('runtime.inspect',{runId:run.id},owner);assert.equal(run.status,'canceled');assert.equal(run.cancellationAcknowledged,true);assert.equal(task.state,'Canceled');
  await execution.close();f.store.close();
});

test('scheduler honors the domain project dispatch pause',async()=>{
  const f=fixture(); const task=approvedTask(f);
  f.domain.call('dispatch.pause',{projectId:f.project.id,decision:'Fixture maintenance window'},owner);
  const execution=Execution(f.store,f.domain,f.stateDir);
  const tick=await execution.tick();
  assert.equal(tick.queue.started.length,0);
  assert.match(tick.queue.waiting.find((item:any)=>item.taskId===task.id).reason,/dispatch_paused/);
  assert.equal(f.store.require<any>('task',task.id).state,'Approved');
  await execution.close(); f.store.close();
});

test('scheduler keeps a second native app task waiting behind the single GUI slot',async()=>{
  const f=fixture();
  const first=approvedTask(f,{runtime:'codex-app',capability:undefined,capabilityInput:undefined,priority:2});
  const second=approvedTask(f,{runtime:'codex-app',capability:undefined,capabilityInput:undefined,priority:1});
  const execution=Execution(f.store,f.domain,f.stateDir);
  const tick=await execution.tick();
  assert.equal(tick.queue.started.length,1);
  assert.equal(f.store.require<any>('run',tick.queue.started[0]).taskId,first.id);
  assert.match(tick.queue.waiting.find((item:any)=>item.taskId===second.id).reason,/gui_controller_capacity/);
  assert.equal(f.store.require<any>('task',second.id).state,'Approved');
  await execution.call('runtime.cancel',{runId:tick.queue.started[0]},owner);
  await execution.close(); f.store.close();
});

test('technical start creates an exact detached worktree and preserves a dirty original',async()=>{
  const f=fixture(); const task=approvedTask(f,{runtime:'unavailable-runtime',capability:undefined,capabilityInput:undefined,permissions:['write']});
  writeFileSync(join(f.root,'quick.test.js'),'// dirty original\n',{flag:'a'});
  const dirtyBefore=readFileSync(join(f.root,'quick.test.js'),'utf8');
  const execution=Execution(f.store,f.domain,f.stateDir);
  await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:'unavailable-runtime',runType:'technical'},owner),/unavailable/);
  const worktree=join(f.root,'.wimzo','worktrees',task.id);
  assert.equal(git(worktree,'rev-parse','HEAD'),f.candidate);
  assert.equal(readFileSync(join(f.root,'quick.test.js'),'utf8'),dirtyBefore);
  const blocked=f.store.require<any>('task',task.id);assert.equal(blocked.state,'Blocked');assert.match(blocked.stopped.reason,/could not start/);
  assert.equal(f.store.require<any>('run',blocked.runId).state,'Failed');
  assert.ok(f.store.list<any>('inbox').some(item=>item.kind==='run blocked'&&item.status==='pending'&&item.data.taskId===task.id));
  await execution.close(); f.store.close();
});

test('implicit writer and verifier worktrees stay below the owning project when state is elsewhere',async()=>{
  const f=fixture(true); const bin=join(f.root,'fake-bin'); mkdirSync(bin);
  const codex=join(bin,'codex'); writeFileSync(codex,`#!${process.execPath}\nif(process.argv.includes('login')&&process.argv.includes('status')){console.error('Logged in using ChatGPT');process.exit(0)}\nif(process.argv.includes('--version')){console.log('fixture');process.exit(0)}\nprocess.exit(0);\n`); chmodSync(codex,0o755);
  const previousPath=process.env.PATH; process.env.PATH=`${bin}:${previousPath}`;
  const execution=Execution(f.store,f.domain,f.stateDir);
  try {
    const writer=approvedTask(f,{runtime:'codex',capability:undefined,capabilityInput:undefined,permissions:['workspace-write'],worktree:true,deadline:new Date(Date.now()+60_000).toISOString()});
    const verifierDraft=f.domain.call('task.create',{projectId:f.project.id,specId:f.accepted.id,specHash:f.accepted.hash,requirements:['H-024'],objective:'Verify the isolated writer candidate',criteria:['Verification command exits successfully'],scope:'Read the isolated fixture only.',permissions:[],budget:{maxExecutionMs:60_000},sourceCandidate:{id:f.candidate,specHash:f.accepted.hash},runtime:'codex',worktree:true,resources:[],deadline:new Date(Date.now()+60_000).toISOString()},owner);
    const verifier=f.domain.call('task.approve',{taskId:verifierDraft.id,expectedRev:verifierDraft.rev,decision:'Approve isolated verification',source:'execution fixture'},owner).task;
    for (const task of [writer,verifier]) {
      const run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'codex',runType:'technical'},owner);
      const completed:any=await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='completed');
      const expected=realpathSync(join(f.root,'.wimzo','worktrees',task.id));
      assert.equal(completed.cwd,expected); assert.ok(existsSync(expected)); assert.ok(expected.startsWith(realpathSync(f.root))); assert.ok(!expected.startsWith(realpathSync(f.stateDir)));
    }
  } finally { await execution.close(); process.env.PATH=previousPath; f.store.close(); }
});

test('Git watches make unchanged polls model-free, coalesce outside commits, and expose health',async()=>{
  const f=fixture(); const execution=Execution(f.store,f.domain,f.stateDir);
  const one:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:f.root,ref:'HEAD',intervalMs:1000},owner);
  const two:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:f.root,ref:'HEAD',intervalMs:1000},owner);
  let tick:any=await execution.call('watch.tick',{},system);
  assert.equal(tick.modelInvocations,0);
  for(const watch of [one,two]) { const current=f.store.require<any>('watch',watch.id); f.store.put('watch',{...current,nextCheckAt:new Date(0).toISOString()},current.rev); }
  const before=f.store.events().filter(event=>event.type==='watch.observation.changed').length;
  tick=await execution.call('watch.tick',{},system);
  assert.equal(tick.unchanged.length,2);
  assert.equal(tick.modelInvocations,0);
  assert.equal(f.store.events().filter(event=>event.type==='watch.observation.changed').length,before);
  writeFileSync(join(f.root,'new.txt'),'outside\n'); git(f.root,'add','new.txt'); git(f.root,'commit','-m','outside change');
  for(const watch of [one,two]) { const current=f.store.require<any>('watch',watch.id); f.store.put('watch',{...current,nextCheckAt:new Date(0).toISOString()},current.rev); }
  await execution.call('watch.tick',{},system);
  assert.equal(f.store.list<any>('inbox').filter(item=>item.kind==='outside commit').length,1);
  assert.equal(f.store.list<any>('followup').filter(item=>item.kind==='outside commit').length,1);

  const badRoot=mkdtempSync(join(tmpdir(),'wimzo-not-a-repo-'));
  const bad:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:badRoot,ref:'HEAD'},owner);
  const health:any=await execution.call('watch.tick',{},system);
  assert.ok(health.failures.includes(bad.id));
  assert.equal(f.store.require<any>('watch',bad.id).health,'unhealthy');
  await execution.close(); f.store.close();
});

test('PR watch keeps pending checks healthy and never passes checks from a different head',async()=>{
  const f=fixture(); const bin=join(f.root,'fake-gh-bin'); mkdirSync(bin);
  const gh=join(bin,'gh');
  writeFileSync(gh,`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const state=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.gh-state.json'),'utf8'));console.log(JSON.stringify(state));\n`); chmodSync(gh,0o755);
  const oldPath=process.env.PATH; process.env.PATH=`${bin}:${oldPath}`;
  try {
    writeFileSync(join(f.root,'.gh-state.json'),JSON.stringify({headRefOid:f.candidate,state:'OPEN',url:'https://example.invalid/pr/1',statusCheckRollup:[{name:'build',status:'IN_PROGRESS',conclusion:null}]}));
    const execution=Execution(f.store,f.domain,f.stateDir);
    const pending:any=await execution.call('watch.create',{projectId:f.project.id,kind:'pr-checks',repository:f.root,pr:1,expectedCandidate:f.candidate,intervalMs:1000},owner);
    await execution.call('watch.tick',{},system);
    let current=f.store.require<any>('watch',pending.id);
    assert.equal(current.health,'healthy'); assert.equal(current.lastObservation.terminal,false); assert.equal(current.lastObservation.passing,false);
    assert.equal(f.store.list<any>('inbox').filter(item=>item.kind==='monitor health').length,0);

    writeFileSync(join(f.root,'.gh-state.json'),JSON.stringify({headRefOid:'new-head',state:'OPEN',url:'https://example.invalid/pr/1',statusCheckRollup:[{name:'build',status:'COMPLETED',conclusion:'SUCCESS'}]}));
    f.store.put('watch',{...current,nextCheckAt:new Date(0).toISOString()},current.rev);
    await execution.call('watch.tick',{},system); current=f.store.require<any>('watch',pending.id);
    assert.equal(current.lastObservation.commitExact,false); assert.equal(current.lastObservation.passing,false);
    assert.match(f.store.list<any>('inbox').find(item=>item.kind==='PR checks').summary,/stale/);

    writeFileSync(join(f.root,'.gh-state.json'),JSON.stringify({headRefOid:'new-head',state:'OPEN',url:'https://example.invalid/pr/1',statusCheckRollup:[{name:'build',status:'COMPLETED',conclusion:'FAILURE'}]}));
    const failing:any=await execution.call('watch.create',{projectId:f.project.id,kind:'pr-checks',repository:f.root,pr:2,expectedCandidate:'new-head'},owner);
    await execution.call('watch.tick',{},system); const failed=f.store.require<any>('watch',failing.id);
    assert.equal(failed.health,'healthy'); assert.equal(failed.lastObservation.failed,true); assert.equal(failed.lastObservation.passing,false);
    assert.ok(f.store.list<any>('inbox').some(item=>item.kind==='PR checks'&&/failed/.test(item.summary)));
    await execution.close();
  } finally { process.env.PATH=oldPath; f.store.close(); }
});

test('expired watches stop before observing and capability validation rejects unsafe shapes',async()=>{
  const f=fixture(); const execution=Execution(f.store,f.domain,f.stateDir);
  const watch:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:f.root,ref:'HEAD',expiresAt:new Date(0).toISOString()},owner);
  const result=await execution.call('watch.tick',{},system);
  assert.ok(result.expired.includes(watch.id));
  assert.equal(f.store.events().filter(event=>event.type==='watch.observation.changed'&&event.data.watchId===watch.id).length,0);
  await assert.rejects(()=>execution.call('capability.run',{capability:'git.validate',input:{args:['branch','new-branch']},cwd:f.root},owner),/not read-only/);
  await assert.rejects(()=>execution.call('capability.run',{capability:'node.test',input:{args:['--eval','process.exit()']},cwd:f.root},owner),/Only explicit Node test/);
  await execution.close(); f.store.close();
});


test('tick reconciles a failed run already observed by runtime inspection',async()=>{
 const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
 try{
  writeFileSync(join(f.root,'fail.test.js'),"import test from 'node:test';test('failure',()=>{throw new Error('synthetic failure')});\n");
  git(f.root,'add','fail.test.js');git(f.root,'commit','-m','Failing fixture');f.candidate=git(f.root,'rev-parse','HEAD');
  const task=approvedTask(f,{capabilityInput:{args:['fail.test.js']}});
  const run=await execution.call('runtime.start',{taskId:task.id},owner);
  await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='failed');
  assert.equal(f.store.require('task',task.id).state,'Running');
  await execution.tick();
  assert.equal(f.store.require('task',task.id).state,'Failed');
  assert.equal(f.store.require<any>('run',run.id).state,'Failed');
  assert.ok(f.store.list('checkpoint').some(value=>value.runId===run.id));
  assert.equal(f.store.list('lease').filter(value=>value.taskId===task.id&&value.active).length,0);
  const notice=()=>f.store.list<any>('inbox').find(item=>item.kind==='run failed'&&item.data.runId===run.id);
  assert.equal(notice()?.status,'pending');assert.equal(notice()?.data.taskId,task.id);assert.match(notice()?.data.reason,/exit|fail/i);
  const failedTask=f.store.require<any>('task',task.id);
  f.domain.call('task.control',{taskId:task.id,expectedRev:failedTask.rev,command:'resume'},owner);
  await execution.tick();
  assert.equal(notice()?.status,'pending');
  assert.equal(f.store.require<any>('run',run.id).state,'Failed');
  const runs=f.store.list<any>('run').filter(value=>value.taskId===task.id);
  assert.equal(runs.length,2);assert.notEqual(f.store.require<any>('task',task.id).runId,run.id);
  await waitFor(async()=>{await execution.tick();return f.store.require<any>('task',task.id)},value=>value.state==='Failed');
 }finally{await execution.close();f.store.close();}
});

test('a failed run releases domain capacity even when its task is not Running',async()=>{
 const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
 try{
  const task=approvedTask(f);const claimed=f.domain.call('task.claim',{taskId:task.id,expectedRev:task.rev,workerId:'capacity-fixture',runType:'script'},system);
  f.store.put<any>('task',{...claimed.task,state:'Verifying'},claimed.task.rev);
  const run=f.store.require<any>('run',claimed.run.id);f.store.put<any>('run',{...run,status:'failed',launchState:'finished',error:'fixture failure'},run.rev);
  await execution.tick();
  assert.equal(f.store.require<any>('run',run.id).state,'Failed');assert.equal(f.store.require<any>('task',task.id).state,'Verifying');
 }finally{await execution.close();f.store.close();}
});

test('Pi allowance threshold checkpoints active Pi profiles without attributing them to Codex',async()=>{
 const f=fixture(),execution=Execution(f.store,f.domain,f.stateDir);
 try{
  const value=approvedTask(f,{runtime:'pi-profile',capability:undefined,capabilityInput:undefined,deadline:new Date(Date.now()+60000).toISOString(),budget:{maxExecutionMs:60000,workerProfile:{id:'pi:fixture:low',runtime:'pi',provider:'openai-codex',authRoute:'subscription',model:'fixture',thinking:'low',contextWindow:200000,label:'Fixture',source:'pi-sdk',verified:true}}});
  const claimed=f.domain.call('task.claim',{taskId:value.id,expectedRev:value.rev,workerId:'pi-threshold-fixture',runType:'technical'},system);
  const run=f.store.require('run',claimed.task.runId);
  f.store.put('run',{...run,runtime:'pi-profile',status:'awaiting_session',runType:'technical'},run.rev);
  await execution.call('runtime.limit_set',{runtime:'pi',providerRemaining:0,providerUnit:'tokens',warningThreshold:{providerRemaining:10},source:'fixture telemetry'},owner);
  await execution.tickProfiles();
  assert.ok(f.store.list('checkpoint').some(value=>value.runId===run.id&&String(value.id).includes('runtime-limit')));
  assert.ok(f.store.list('followup').some(value=>value.projectId===f.project.id&&value.kind==='runtime limit'));
 }finally{await execution.close();f.store.close();}
});

test('project worker policy refuses a disallowed harness, provider or model before any worker process starts',async()=>{
  const f=fixture(); const bin=join(f.root,'fake-bin'); mkdirSync(bin);
  const marker=join(f.root,'worker-launched.log');
  const codex=join(bin,'codex'); writeFileSync(codex,`#!${process.execPath}\nif(process.argv.includes('login')&&process.argv.includes('status')){console.error('Logged in using ChatGPT');process.exit(0)}\nif(process.argv.includes('--version')){console.log('fixture');process.exit(0)}\nimport('node:fs').then(fs=>fs.appendFileSync(${JSON.stringify(marker)},process.argv.slice(2).join(' ')+'\\n'));\n`); chmodSync(codex,0o755);
  const previousPath=process.env.PATH; process.env.PATH=`${bin}:${previousPath}`;
  const piProfile={id:'pi:openai:fixture-pi-model:low',runtime:'pi',provider:'openai',authRoute:'subscription',model:'fixture-pi-model',thinking:'low',contextWindow:200000,label:'Fixture Pi',source:'pi-sdk',verified:true};
  const execution=Execution(f.store,f.domain,f.stateDir,{discoverPi:async()=>({installed:true,authKind:'subscription',availableModels:[{id:'fixture-pi-model',provider:'openai-codex',contextWindow:200000,thinkingSupport:['low']}]})});
  const setPolicy=(policy:any)=>{const current=f.store.get<any>('project_worker_policy',f.project.id);f.store.put('project_worker_policy',{id:f.project.id,projectId:f.project.id,policy},current?.rev)};
  const codexTask=()=>approvedTask(f,{runtime:'codex',capability:undefined,capabilityInput:undefined,permissions:['workspace-write'],deadline:new Date(Date.now()+60_000).toISOString()});
  const refused=async(task:any,pattern:RegExp)=>{
    await assert.rejects(()=>execution.call('runtime.start',{taskId:task.id,runtime:task.runtime,runType:'technical'},owner),pattern);
    assert.equal(f.store.require<any>('task',task.id).state,'Approved');
    assert.equal(f.store.list<any>('run').filter(run=>run.taskId===task.id).length,0);
    assert.equal(existsSync(marker),false);
  };
  try {
    setPolicy({harnesses:['pi'],providers:['openai'],authRoutes:['subscription']});
    await refused(codexTask(),/Project worker policy denies harness: codex/);
    setPolicy({harnesses:['codex'],providers:['anthropic'],authRoutes:['subscription']});
    await refused(codexTask(),/Project worker policy denies provider: openai/);
    setPolicy({harnesses:['codex'],providers:['openai'],authRoutes:['subscription'],models:['gpt-other']});
    await refused(codexTask(),/Project worker policy denies model: gpt-5\.6-luna/);
    setPolicy({harnesses:['codex','pi'],providers:['openai'],authRoutes:['subscription'],models:['another-pi-model']});
    await refused(approvedTask(f,{runtime:'pi-profile',capability:undefined,capabilityInput:undefined,deadline:new Date(Date.now()+60_000).toISOString(),budget:{maxExecutionMs:60_000,workerProfile:piProfile}}),/Project worker policy denies model: fixture-pi-model/);
    const scheduled:any=await execution.tick();
    assert.equal(scheduled.queue.started.length,0);
    const reasons=f.store.list<any>('execution_queue').map(item=>String(item.reason));
    assert.ok(reasons.some(reason=>/^policy_denied:codex:.*Project worker policy denies model: gpt-5\.6-luna/.test(reason)),JSON.stringify(reasons));
    assert.ok(reasons.some(reason=>/^policy_denied:pi-profile:.*Project worker policy denies model: fixture-pi-model/.test(reason)),JSON.stringify(reasons));
    assert.equal(f.store.list<any>('run').length,0);
    assert.equal(existsSync(marker),false);
    setPolicy({harnesses:['codex'],providers:['openai'],authRoutes:['subscription'],models:['gpt-5.6-luna']});
    const allowed=codexTask();
    const run:any=await execution.call('runtime.start',{taskId:allowed.id,runtime:'codex',runType:'technical'},owner);
    await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),(value:any)=>value.status==='completed');
    assert.equal(existsSync(marker),true);
  } finally { await execution.close(); process.env.PATH=previousPath; f.store.close(); }
});

test('scheduler skips an eligible default runtime that project policy denies',async()=>{
  const f=fixture(); const bin=join(f.root,'fake-bin'); mkdirSync(bin);
  const codex=join(bin,'codex'); writeFileSync(codex,`#!${process.execPath}\nif(process.argv.includes('login')&&process.argv.includes('status')){console.error('Logged in using ChatGPT');process.exit(0)}\nif(process.argv.includes('--version')){console.log('fixture');process.exit(0)}\n`); chmodSync(codex,0o755);
  const previousPath=process.env.PATH; process.env.PATH=`${bin}:${previousPath}`;
  const execution=Execution(f.store,f.domain,f.stateDir,{discoverPi:async()=>({installed:true,authKind:'subscription',availableModels:[{id:'fixture-pi-model',provider:'openai-codex',contextWindow:200000,thinkingSupport:['low']}]})});
  try {
    f.store.put('project_worker_policy',{id:f.project.id,projectId:f.project.id,policy:{harnesses:['codex'],providers:['openai'],authRoutes:['subscription']}});
    const task=approvedTask(f,{runtime:undefined,capability:undefined,capabilityInput:undefined,permissions:['workspace-write'],deadline:new Date(Date.now()+60_000).toISOString()});
    await execution.tick();
    const runs=f.store.list<any>('run').filter(run=>run.taskId===task.id);
    assert.equal(runs.length,1); assert.equal(runs[0].runtime,'codex');
    assert.ok(!f.store.list<any>('execution_queue').some(item=>/^policy_denied:pi/.test(String(item.reason))));
  } finally { await execution.close(); process.env.PATH=previousPath; f.store.close(); }
});

test('a dirty writer exit pauses with a checkpoint and only a clean commit is collected after resume',async()=>{
  const f=fixture(true); const bin=join(f.root,'fake-bin'); mkdirSync(bin); const counter=join(f.root,'invocations');
  writeFileSync(join(f.root,'.gitignore'),'.state/\nfake-bin/\ninvocations\n');git(f.root,'add','.gitignore');git(f.root,'commit','-m','ignore fixture tools');const source=git(f.root,'rev-parse','HEAD');
  const codex=join(bin,'codex'); writeFileSync(codex,`#!${process.execPath}
if(process.argv.includes('login')&&process.argv.includes('status')){console.error('Logged in using ChatGPT');process.exit(0)}
if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}
const fs=await import('node:fs');const {execFileSync}=await import('node:child_process');const cwd=process.argv[process.argv.indexOf('-C')+1];
const invocation=(fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0)+1;fs.writeFileSync(${JSON.stringify(counter)},String(invocation));
fs.writeFileSync(cwd+'/writer-output.txt','writer change\\n');
if(invocation>1){const env={...process.env,GIT_AUTHOR_NAME:'W',GIT_AUTHOR_EMAIL:'w@example.invalid',GIT_COMMITTER_NAME:'W',GIT_COMMITTER_EMAIL:'w@example.invalid'};execFileSync('git',['add','writer-output.txt'],{cwd,env});execFileSync('git',['-c','commit.gpgsign=false','commit','-m','writer'],{cwd,env});}
`); chmodSync(codex,0o755);
  const previousPath=process.env.PATH; process.env.PATH=`${bin}:${previousPath}`;
  let execution=Execution(f.store,f.domain,f.stateDir);
  try {
    const task=approvedTask(f,{runtime:'codex',capability:undefined,capabilityInput:undefined,permissions:['workspace-write'],sourceCandidate:{id:source,specHash:f.accepted.hash},deadline:new Date(Date.now()+120_000).toISOString()});
    await waitFor(async()=>{await execution.tick();return f.store.require<any>('task',task.id)},value=>value.state==='Paused');
    const [first]=f.store.list<any>('run').filter(run=>run.taskId===task.id);
    assert.equal(first.status,'paused');assert.equal(first.cleanCommitRequired,true);assert.equal(first.resultReported,undefined);
    assert.equal(first.checkpointCandidate.dirty,true);assert.equal(typeof first.checkpointCandidate.materializedCommit,'string');
    assert.ok(f.store.get('checkpoint',`checkpoint:${first.id}:clean-commit-required`));
    assert.equal(f.store.list<any>('result').filter(item=>item.taskId===task.id).length,0);
    await execution.close(); execution=Execution(f.store,f.domain,f.stateDir);
    await execution.tick(); assert.equal(f.store.require<any>('task',task.id).state,'Paused');
    const paused=f.store.require<any>('task',task.id);
    f.domain.call('task.control',{taskId:paused.id,expectedRev:paused.rev,command:'resume'},owner);
    const verifying=await waitFor(async()=>{await execution.tick();return f.store.require<any>('task',task.id)},value=>value.state==='Verifying');
    assert.match(verifying.candidate.id,/^[0-9a-f]{40}$/);assert.notEqual(verifying.candidate.id,source);assert.equal(verifying.candidate.dirty,undefined);
  } finally { await execution.close(); process.env.PATH=previousPath; f.store.close(); }
});

test('a restart after a claim or reservation without a launch pauses the task and never replays it',async()=>{
  const f=fixture();const past=new Date(Date.now()-120_000).toISOString();
  const claimOnly=approvedTask(f),reservedOnly=approvedTask(f);
  const first=f.domain.call('task.claim',{taskId:claimOnly.id,expectedRev:claimOnly.rev,runType:'script',workerId:`execution:${claimOnly.id}`},system).run;
  f.store.put('run',{...first,startedAt:past},first.rev);
  const second=f.domain.call('task.claim',{taskId:reservedOnly.id,expectedRev:reservedOnly.rev,runType:'script',workerId:`execution:${reservedOnly.id}`},system).run;
  const folder=join(f.stateDir,'runs',second.id);mkdirSync(folder,{recursive:true});
  f.store.put('run',{...second,status:'reserved',launchState:'reserved',createdAt:past,launchKey:'fixture-key',paths:{status:join(folder,'status.json'),stdout:join(folder,'stdout.log'),stderr:join(folder,'stderr.log')}},second.rev);
  const execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const tick=await execution.tick();
    assert.deepEqual(tick.queue.started,[]);
    for(const [task,run,pattern] of [[claimOnly,first,/before the run was reserved/],[reservedOnly,second,/before the launch fence/]] as const){
      const stored=f.store.require<any>('run',run.id);
      assert.equal(stored.launchState,'outcome-unknown');assert.match(stored.error,pattern);
      assert.equal(f.store.require<any>('task',task.id).state,'Paused');
      assert.ok(f.store.get('checkpoint',`checkpoint:${run.id}:interrupted`));
      assert.equal(f.store.list<any>('run').filter(item=>item.taskId===task.id).length,1);
    }
  }finally{await execution.close();f.store.close();}
});

test('a live pre-launch claim inside the grace window is left alone by tick',async()=>{
  const f=fixture();const task=approvedTask(f);
  const run=f.domain.call('task.claim',{taskId:task.id,expectedRev:task.rev,runType:'script',workerId:`execution:${task.id}`},system).run;
  const execution=Execution(f.store,f.domain,f.stateDir);
  try{await execution.tick();assert.equal(f.store.require<any>('run',run.id).status,undefined);assert.equal(f.store.require<any>('task',task.id).state,'Running');}
  finally{await execution.close();f.store.close();}
});

test('the wrapper deadline terminates the whole process group including SIGTERM-ignoring descendants',async()=>{
  const f=fixture();const pidFile=join(f.root,'grandchild.pid');
  writeFileSync(join(f.root,'stubborn.cjs'),`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`);
  writeFileSync(join(f.root,'spawner.test.js'),`import test from 'node:test'; import {spawn} from 'node:child_process'; test('spawn',async()=>{spawn(process.execPath,[${JSON.stringify(join(f.root,'stubborn.cjs'))}],{stdio:'ignore'});await new Promise(resolve=>setTimeout(resolve,30000))});\n`);
  const execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const run:any=await execution.call('capability.run',{capability:'node.test',input:{args:['spawner.test.js']},cwd:f.root,deadline:new Date(Date.now()+1500).toISOString()},owner);
    await waitFor(async()=>existsSync(pidFile),Boolean);
    const failed:any=await waitFor(()=>execution.call('runtime.inspect',{runId:run.id},owner),value=>value.status==='failed',15000);
    assert.match(failed.error,/deadline/i);
    const alive=()=>{try{process.kill(Number(readFileSync(pidFile,'utf8')),0);return true;}catch{return false;}};
    await waitFor(async()=>alive(),value=>!value,5000);
    await assert.rejects(()=>execution.call('capability.run',{capability:'node.test',input:{args:['quick.test.js']},cwd:f.root,deadline:new Date(Date.now()-1000).toISOString()},owner),/deadline must be in the future/);
  }finally{await execution.close();f.store.close();}
});

test('tick reconciles an acknowledged native pause so the GUI slot is released',async()=>{
  const f=fixture();let task=approvedTask(f,{runtime:'codex-app',capability:undefined,capabilityInput:undefined});
  const execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const run:any=await execution.call('runtime.start',{taskId:task.id,runtime:'codex-app',runType:'gui'},owner);
    task=f.store.require<any>('task',task.id);task=f.domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'pause'},owner);
    f.domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command:'pause',checkpoint:{summary:'native pause'}},{role:'worker',id:`execution:${task.id}`,taskId:task.id});
    const tick=await execution.tick();
    assert.ok(tick.reconciled.includes(run.id));assert.equal(f.store.require<any>('run',run.id).status,'paused');
  }finally{await execution.close();f.store.close();}
});

test('an outside commit already reported stays deduplicated after its inbox item is resolved',async()=>{
  const f=fixture();const execution=Execution(f.store,f.domain,f.stateDir);
  try{
    const one:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:f.root,ref:'HEAD',intervalMs:60_000},owner);
    const two:any=await execution.call('watch.create',{projectId:f.project.id,kind:'git-ref',repository:f.root,ref:'HEAD',intervalMs:60_000},owner);
    await execution.call('watch.tick',{},system);
    const due=(watch:any)=>{const current=f.store.require<any>('watch',watch.id);f.store.put('watch',{...current,nextCheckAt:new Date(0).toISOString()},current.rev);};
    writeFileSync(join(f.root,'new.txt'),'outside\n');git(f.root,'add','new.txt');git(f.root,'commit','-m','outside change');
    due(one);await execution.call('watch.tick',{},system);
    const [inbox]=f.store.list<any>('inbox').filter(item=>item.kind==='outside commit');
    f.domain.call('inbox.deliver',{inboxId:inbox.id,expectedRev:inbox.rev,status:'resolved'},owner);
    due(two);const tick:any=await execution.call('watch.tick',{},system);
    assert.equal(tick.modelInvocations,0);
    assert.equal(f.store.list<any>('inbox').filter(item=>item.kind==='outside commit').length,1);
    writeFileSync(join(f.root,'newer.txt'),'outside\n');git(f.root,'add','newer.txt');git(f.root,'commit','-m','second outside change');
    due(one);await execution.call('watch.tick',{},system);
    assert.equal(f.store.list<any>('inbox').filter(item=>item.kind==='outside commit').length,2);
  }finally{await execution.close();f.store.close();}
});
