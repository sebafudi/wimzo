import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'workflow-fixture-owner' };
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

for (const mode of ['direct', 'paused-direct', 'planned', 'prepared', 'rework', 'planned-rework']) test(`official SDK ${mode} workflow carries exact snapshots into independent verification and owner result review`, async () => {
  const planned = mode === 'planned' || mode === 'prepared' || mode === 'planned-rework', prepare = mode === 'prepared', rework = mode === 'rework' || mode === 'planned-rework', pauseDirect = mode === 'paused-direct';
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-workflow-execution-'));
  const root = join(temp, 'project'); mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  writeFileSync(join(root, 'spec/PRD.md'), '# Calculation\n\nThe answer file contains four.\n');
  writeFileSync(join(root, 'answer.txt'), 'TODO\n');
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Fixture baseline');
  const baseline = git(root, 'rev-parse', 'HEAD');
  const bin = join(temp, 'bin'); mkdirSync(bin);
  const codexHome = join(temp, 'codex-home'); mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] }));
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!${process.execPath}
if(process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const {readFileSync,writeFileSync}=await import('node:fs');
const {App}=await import(${JSON.stringify(new URL('../src/app.ts', import.meta.url).href)});
const {scopedWorkerTools}=await import(${JSON.stringify(new URL('../src/worker-bridge.ts', import.meta.url).href)});
const argument=process.argv.find(value=>value.startsWith('mcp_servers.wimzo.args='));
if(!argument)throw new Error('Scoped bridge configuration is missing');
const config=JSON.parse(readFileSync(JSON.parse(argument.slice(argument.indexOf('=')+1))[1],'utf8'));
const app=new App(config.stateDir), bridge=scopedWorkerTools(app,config.taskId,config.runId);
const pauseDirect=${pauseDirect};
try {
 const context=await bridge.invoke('wimzo_context');
 if(context.task.workflow.purpose==='requirements_preparation') {
  const reference=context.task.workflow.preparationSpecs?.find(spec=>spec.path==='spec/PRD.md');
  if(!reference)throw new Error('Preparation lacks accepted specification index');
  const page=await bridge.invoke('wimzo_specification',{specId:reference.id});
  await bridge.invoke('wimzo_workflow_propose_requirements',{changes:[{path:reference.path,baseSpecId:reference.id,baseHash:reference.hash,content:page.content+'\\nThe calculation has an independent verification record.\\n'}],revisionNote:'Record independent verification.',submissionId:'fixture-preparation'});
 } else if(context.task.workflow.purpose==='planning') {
  await bridge.invoke('wimzo_workflow_submit_plan',{submissionId:'fixture-plan',slices:[{id:'calculate',objective:'Calculate four',scope:'Update answer.txt only',criteria:['The answer is four'],requirements:['fixture:calculation'],permissions:['workspace-write'],budget:{maxExecutionMs:40000},dependencies:[]},{id:'record',objective:'Record the verified calculation',scope:'Read answer.txt and add checked.txt',criteria:['The verified answer is recorded'],requirements:['fixture:calculation'],permissions:['workspace-write'],budget:{maxExecutionMs:40000},dependencies:['calculate']}]});
 } else if(context.task.workflow.purpose==='verification') {
  if(config.write)throw new Error('Verifier received write permissions');
  const answer=readFileSync('answer.txt','utf8');
  if(answer!=='4\\n'&&answer!=='5\\n')throw new Error('Verifier did not receive implementation snapshot');
  const checked=await import('node:fs').then(fs=>fs.existsSync('checked.txt')?readFileSync('checked.txt','utf8'):null);
  if(checked!==null&&checked!==(answer==='5\\n'?'five verified\\n':'four verified\\n'))throw new Error('Verifier did not receive the exact dependent candidate');
  await bridge.invoke('wimzo_workflow_submit_verification',{candidate:context.task.workflow.targetCandidate,checks:context.task.criteria.map(check=>({check,result:'pass',details:{fixture:true}})),summary:'The exact snapshot contains the expected answer and saved internal plan.',submissionId:'fixture-verification'});
 } else if(context.task.objective==='Record the verified calculation') {
  const rework=!!context.task.workflow.reworkOf;
  if(readFileSync('answer.txt','utf8')!==(rework?'5\\n':'4\\n'))throw new Error('Successor did not receive the verified dependency source');
  const continuation=await bridge.invoke('wimzo_workflow_continuation');
  if(continuation.dependencies.length!==1)throw new Error('Verified continuation receipt is missing');
  writeFileSync('checked.txt',rework?'five verified\\n':'four verified\\n');
 } else {
  await bridge.invoke('wimzo_checkpoint',{summary:'Internal plan: write four, then independently verify the saved candidate.',submissionId:'fixture-plan'});
  writeFileSync('answer.txt',context.task.workflow.reworkOf?'5\\n':'4\\n');
  if(pauseDirect&&app.store.list('run').filter(run=>run.taskId===config.taskId).length===1) {
   writeFileSync(config.stateDir+'/pause-ready',config.runId);
   console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session-'+config.runId}));
   await new Promise(resolve=>setTimeout(resolve,30000));
   process.exit(0);
  }
 }
 await bridge.invoke('wimzo_checkpoint',{summary:'Fixture work complete',submissionId:'fixture-complete'});
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'Fixture SDK completed'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:12,cached_input_tokens:0}}));
} finally {await app.close();}
`); chmodSync(codex, 0o755);
  const previousPath = process.env.PATH, previousHome = process.env.CODEX_HOME;
  process.env.PATH = `${bin}:${previousPath}`; process.env.CODEX_HOME = codexHome;
  const app = new App(join(root, '.state'));
  try {
    const project = await app.call('project.register', { id: 'workflow-fixture', name: 'Workflow fixture', root, purpose: 'Isolated automatic handoff test', canonicalPaths: ['spec/PRD.md'] }, owner);
    const captured = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md', requirementIds: ['fixture:calculation'] }, owner);
    let accepted = (await app.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Accept fixture specification', source: 'test' }, owner)).spec;
    const profile = { id: 'codex:fixture-model:low', runtime: 'codex', model: 'fixture-model', thinking: 'low', label: 'Fixture model', source: 'local-metadata', verified: true };
    await app.call('workflow.configure', { projectId: project.id, enabled: true, baselineSpecId: accepted.id, defaultProfile: profile, sourceCandidate: { commit: baseline }, maxRunMs: 120000, preparationBudget: { maxExecutionMs: 30000 }, planningBudget: { maxExecutionMs: 30000 }, implementationBudget: { maxExecutionMs: 100000 }, context: { targetTokens: 150000, checkpointTokens: 120000, reserveTokens: 30000, maxTokens: 180000 }, decision: 'Enable fixture workflow', source: 'test' }, owner);
    app.store.put('idea', { id: 'fixture-idea', projectId: project.id, title: 'Calculate four', description: 'Write the answer', future: false, links: prepare ? [] : [{ specId: accepted.id }], createdBy: owner, createdAt: new Date().toISOString() });
    await app.execution.tickProfiles();
    let feature = (await app.call('workflow.list', { projectId: project.id }, owner))[0];
    if (prepare) {
      const preparationDeadline = Date.now() + 12000;
      while ((feature.phase !== 'prd_review' || app.store.require<any>('task',feature.preparationTaskId).state === 'Running') && Date.now() < preparationDeadline) {
        await app.execution.tickProfiles();
        feature = (await app.call('workflow.list', { projectId: project.id }, owner))[0];
        await new Promise(resolve => setTimeout(resolve,80));
      }
      assert.equal(feature.phase,'prd_review',JSON.stringify({feature,runs:app.store.list('run')}));
      assert.equal(readFileSync(join(root,'spec/PRD.md'),'utf8'),accepted.content);
      const review = await app.call('workflow.review',{featureId:feature.id},owner);
      const approval = await app.call('workflow.acceptRequirements',{featureId:feature.id,documents:review.documents.map((document:any)=>({documentId:document.id,expectedRev:document.rev})),decision:'Accept exact synthetic PRD amendment',source:'test',submissionId:'fixture-prd-accept'},owner);
      accepted = approval.accepted[0].spec;
    }
    const approved = await app.call('workflow.approve', { featureId: feature.id, specId: accepted.id, specHash: accepted.hash, specRev: accepted.rev, profile, directImplementation: !planned, objective: 'Calculate four', scope: planned ? 'Update answer.txt and record the verified answer in checked.txt' : 'Update answer.txt only', criteria: ['The answer is four'], permissions: ['workspace-write'], decision: 'Approve isolated implementation and verification', source: 'test', submissionId: 'fixture-approve' }, owner);
    let pausedRun: any, originalTask: any, originalAuthority: any;
    if (pauseDirect) {
      const marker = join(root, '.state', 'pause-ready');
      const pauseDeadline = Date.now() + 12_000;
      while (!existsSync(marker) && Date.now() < pauseDeadline) { await app.execution.tickProfiles(); await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.ok(existsSync(marker), JSON.stringify({ runs: app.store.list('run'), tasks: app.store.list('task') }));
      originalTask = app.store.require<any>('task', approved.task.id);
      originalAuthority = structuredClone(app.store.require<any>('workflow_owner_approval', originalTask.inheritedAuthorization.ownerApprovalId));
      const requested = await app.call('task.control', { taskId: originalTask.id, expectedRev: originalTask.rev, command: 'pause' }, owner);
      const pauseComplete = Date.now() + 12_000;
      while (Date.now() < pauseComplete) {
        await app.execution.tickProfiles();
        const current = app.store.require<any>('task', originalTask.id);
        const run = current.runId ? app.store.require<any>('run', current.runId) : null;
        if (current.state === 'Paused' && run?.status === 'paused') { pausedRun = run; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(pausedRun, JSON.stringify({ requested, runs: app.store.list('run'), task: app.store.require<any>('task', originalTask.id) }));
      assert.equal(readFileSync(join(pausedRun.cwd, 'answer.txt'), 'utf8'), '4\n');
      assert.equal(git(pausedRun.cwd, 'show', `${pausedRun.checkpointCandidate.materializedCommit}:answer.txt`), '4');
      assert.ok(app.store.list<any>('checkpoint').some(item => item.runId === pausedRun.id && item.data?.candidate?.materializedCommit === pausedRun.checkpointCandidate.materializedCommit));
      const resume = await app.call('task.control', { taskId: originalTask.id, expectedRev: app.store.require<any>('task', originalTask.id).rev, command: 'resume' }, owner);
      assert.equal(resume.requested.command, 'resume');
    }
    let last: any;
    const deadline = Date.now() + 25000;
    do {
      await app.execution.tickProfiles();
      last = (await app.call('workflow.list', { projectId: project.id }, owner))[0];
      if (last.phase === 'result_review') break;
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    assert.equal(last.phase, 'result_review', JSON.stringify({ feature: last, runs: app.store.list('run'), tasks: app.store.list('task') }));
    const implementation = app.store.require<any>('task', last.implementationTaskIds.at(-1));
    assert.equal(implementation.state, 'Needs result review');
    assert.equal(implementation.dimensions.verified, true);
    assert.equal(implementation.candidate.dirty, true);
    assert.equal(git(root, 'show', `${implementation.candidate.materializedCommit}:answer.txt`), '4');
    assert.equal(readFileSync(join(root, 'answer.txt'), 'utf8'), 'TODO\n');
    if (planned) assert.equal(git(root, 'show', `${implementation.candidate.materializedCommit}:checked.txt`), 'four verified');
    const diff = await app.call('review.diff',{taskId:implementation.id},owner);
    assert.deepEqual(diff.warnings,[]);
    assert.deepEqual(diff.files.map((file:any)=>file.path),[planned?'checked.txt':'answer.txt']);
    assert.match(diff.files[0].patch,planned?/four verified/:/\+4/);
    const runs = app.store.list<any>('run'); assert.equal(runs.length, pauseDirect ? 3 : planned ? (prepare ? 6 : 5) : 2);
    if (pauseDirect) {
      const continuation = runs.find(run => run.taskId === implementation.id && run.id !== pausedRun.id);
      assert.ok(continuation, JSON.stringify(runs));
      assert.equal(pausedRun.status, 'paused');
      assert.equal(pausedRun.state, 'Paused');
      assert.notEqual(continuation.id, pausedRun.id);
      assert.notEqual(continuation.sdkSessionId, pausedRun.sdkSessionId);
      assert.equal(git(continuation.cwd, 'show', `${implementation.candidate.materializedCommit}:answer.txt`), '4');
      assert.equal(implementation.deadline, originalTask.deadline);
      assert.deepEqual(app.store.require<any>('workflow_owner_approval', originalAuthority.id), originalAuthority);
      const pausedElapsed = Date.parse(pausedRun.finishedAt) - Date.parse(pausedRun.startedAt);
      const continuationAllowance = Date.parse(continuation.deadline) - Date.parse(continuation.startedAt);
      assert.ok(continuationAllowance <= implementation.budget.maxExecutionMs - pausedElapsed + 250, JSON.stringify({ pausedElapsed, continuationAllowance, budget: implementation.budget }));
    }
    const verification = runs.find(run => run.taskId === last.verificationByTarget[implementation.id]);
    assert.equal(verification.resolvedWorkflowSource.commit, implementation.candidate.materializedCommit);
    assert.notEqual(verification.cwd, runs.find(run => run.taskId === implementation.id).cwd);
    assert.equal(app.store.list<any>('approval').some(value => value.kind === 'result'), false);
    if (rework) {
      const originalImplementations = last.implementationTaskIds.map((id: string) => app.store.require<any>('task', id));
      const rejected = await app.call('workflow.reviewResult', { featureId: last.id, children: originalImplementations.map((item: any) => ({ taskId: item.id, expectedRev: item.rev, candidate: item.candidate })), decision: 'reject', source: 'Rework fixture review', notes: 'Correct the exact rejected snapshot without widening scope.', submissionId: 'fixture-rework-reject' }, owner);
      const rejectedTasks = rejected.children.map((item: any) => item.task);
      const resumed = await app.call('workflow.resumeResult', { featureId: last.id, children: rejectedTasks.map((item: any) => ({ taskId: item.id, expectedRev: item.rev, candidate: item.candidate })), decision: 'Approve exact snapshot correction', source: 'Rework fixture review', submissionId: 'fixture-rework-resume' }, owner);
      const replacements = resumed.replacements.map((item: any) => item.task);
      assert.equal(replacements.length, originalImplementations.length);
      for (const replacement of replacements) {
        const original = originalImplementations.find((item: any) => item.id === replacement.workflow.reworkOf)!;
        assert.equal(replacement.sourceCandidate.commit, original.candidate.materializedCommit); assert.equal(replacement.worktree, true); assert.match(replacement.scope, /Correct the exact rejected snapshot/);
      }
      const reworkDeadline = Date.now() + 25000;
      do { await app.execution.tickProfiles(); last = (await app.call('workflow.list', { projectId: project.id }, owner))[0]; if (last.phase === 'result_review') break; await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < reworkDeadline);
      assert.equal(last.phase, 'result_review', JSON.stringify({ feature: last, runs: app.store.list('run'), tasks: app.store.list('task') }));
      for (const replacement of replacements) {
        const reworkRun = app.store.list<any>('run').find(run => run.taskId === replacement.id);
        const original = originalImplementations.find((item: any) => item.id === replacement.workflow.reworkOf)!;
        const originalRun = runs.find(run => run.taskId === original.id)!;
        assert.ok(reworkRun, JSON.stringify({ replacement, runs: app.store.list('run') }));
        assert.notEqual(reworkRun.cwd, originalRun.cwd);
        if ((replacement.dependencies ?? []).length === 0) {
          assert.equal(reworkRun.sourceCandidate, original.candidate.materializedCommit);
          assert.equal(git(reworkRun.cwd, 'rev-parse', 'HEAD'), original.candidate.materializedCommit);
        } else {
          assert.notEqual(reworkRun.sourceCandidate, original.candidate.materializedCommit);
          assert.equal(git(reworkRun.cwd, 'rev-parse', 'HEAD'), reworkRun.sourceCandidate);
          assert.equal(git(root, 'show', `${reworkRun.sourceCandidate}:answer.txt`), '5');
          assert.equal(git(root, 'show', `${reworkRun.sourceCandidate}:checked.txt`), 'four verified');
        }
      }
      if (planned) {
        const dependent = app.store.require<any>('task', replacements.find((item: any) => item.objective === 'Record the verified calculation')!.id);
        assert.equal(git(root, 'show', `${dependent.candidate.materializedCommit}:answer.txt`), '5');
        assert.equal(git(root, 'show', `${dependent.candidate.materializedCommit}:checked.txt`), 'five verified');
      }
    }
  } finally {
    await app.close(); process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});
