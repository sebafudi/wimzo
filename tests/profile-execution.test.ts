import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';

const owner = { role: 'owner' as const, id: 'profile-owner' };

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

function fixture(ignoreState = false) {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-profile-execution-'));
  mkdirSync(join(root, 'spec'));
  if (ignoreState) writeFileSync(join(root, '.gitignore'), '.state/\nbin/\ncodex-home/\nfake-codex/\n');
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-044 Worker profiles.** Selected worker profiles remain part of approved work.\n');
  git(root, 'init'); git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  const candidate = git(root, 'rev-parse', 'HEAD');
  const store = new Store(join(root, '.state', 'state.sqlite')); const domain = Domain(store);
  const project: any = domain.call('project.register', { id: 'profile_project', name: 'Profile fixture', root, purpose: 'Profile test', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured: any = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted: any = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Fixture acceptance', source: 'test' }, owner).spec;
  return { root, store, domain, project, accepted, candidate, stateDir: join(root, '.state') };
}

async function waitFor(read: () => Promise<any>, predicate: (value: any) => boolean) {
  const until = Date.now() + 8_000;
  let value = await read();
  while (!predicate(value) && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 40)); value = await read(); }
  assert.ok(predicate(value), JSON.stringify(value));
  return value;
}

test('profile runtime is candidate-scoped and passes only the approved model and effort', async () => {
  const f = fixture(); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const codexHome = join(f.root, 'codex-home'); mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }));
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!${process.execPath}\nif(process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); } if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); } const fs=await import('node:fs'); fs.writeFileSync(${JSON.stringify(join(f.root,'sdk-args.json'))},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'})); console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'Fixture SDK completed'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:12,cached_input_tokens:0}}));\n`); chmodSync(codex, 0o755);
  const previousPath = process.env.PATH; const previousCodexHome = process.env.CODEX_HOME; process.env.PATH = `${bin}:${previousPath}`; process.env.CODEX_HOME = codexHome;
  try {
    const task: any = f.domain.call('task.create', { projectId: f.project.id, specId: f.accepted.id, specHash: f.accepted.hash, requirements: ['H-044'], objective: 'Implement profile fixture', criteria: ['Fixture'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 10_000, workerProfile: { id: 'codex:fixture-model:high', runtime: 'codex', model: 'fixture-model', thinking: 'high', label: 'Fixture model', source: 'local-metadata', verified: true } }, runtime: 'codex-profile', sourceCandidate: { id: f.candidate, specHash: f.accepted.hash }, deadline: new Date(Date.now() + 60_000).toISOString(), resources: [] }, owner);
    const approved: any = f.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve profile fixture', source: 'test' }, owner).task;
    const legacy: any = f.domain.call('task.create', { projectId: f.project.id, specId: f.accepted.id, specHash: f.accepted.hash, requirements: ['H-044'], objective: 'Do not launch', criteria: ['Fixture'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 10_000 }, runtime: 'script', capability: 'node.test', capabilityInput: { args: ['missing.test.js'] }, sourceCandidate: { id: f.candidate, specHash: f.accepted.hash }, resources: [] }, owner);
    f.domain.call('task.approve', { taskId: legacy.id, expectedRev: legacy.rev, decision: 'Approve legacy fixture', source: 'test' }, owner);
    const execution = Execution(f.store, f.domain, f.stateDir);
    const tick: any = await execution.tickProfiles();
    assert.equal(tick.queue.started.length, 1);
    assert.equal(f.store.require<any>('task', legacy.id).state, 'Approved');
    const run: any = await waitFor(() => execution.call('runtime.inspect', { runId: tick.queue.started[0] }, owner), value => value.status === 'completed');
    assert.equal(run.runtime, 'codex-profile');
    assert.deepEqual(run.workerProfile, approved.budget.workerProfile);
    assert.equal(run.adapter,'codex-sdk');
    const args=JSON.parse(readFileSync(join(f.root,'sdk-args.json'),'utf8'));
    assert.ok(args.includes('--model')); assert.equal(args[args.indexOf('--model')+1],'fixture-model');
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(run.sdkSessionId,'fixture-session');
    assert.equal(run.contextTelemetry.estimated,true);assert.equal(run.sdkUsage.input_tokens,100);
    assert.equal(f.store.list('worker_checkpoint').length,1);
    await execution.tickProfiles();
    assert.equal(f.store.require<any>('task', approved.id).state, 'Verifying');
    assert.equal(f.store.require<any>('run', run.id).resultReported, true);
    await execution.close(); f.store.close();
  } finally { process.env.PATH = previousPath; if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; }
});

test('a profile run paused at its context checkpoint resumes on owner request with the saved handoff and completes', async () => {
  const f = fixture(true); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const codexHome = join(f.root, 'codex-home'); mkdirSync(codexHome);
  const fake = join(f.root, 'fake-codex'); mkdirSync(fake);
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }));
  const counter = join(fake, 'invocations'); const prompts = join(fake, 'prompts.jsonl');
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!${process.execPath}
if(process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); } if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const fs=await import('node:fs'); const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n');
const invocation=(fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0)+1; fs.writeFileSync(${JSON.stringify(counter)},String(invocation));
const emit=value=>console.log(JSON.stringify(value));
emit({type:'thread.started',thread_id:'fixture-session-'+invocation}); emit({type:'turn.started'});
if(invocation===1){ emit({type:'item.completed',item:{id:'command',type:'command_execution',command:'inspect fixture',aggregated_output:'x'.repeat(60000),exit_code:0,status:'completed'}}); setTimeout(()=>process.exit(0),30000); }
else { emit({type:'item.completed',item:{id:'message',type:'agent_message',text:'Continuation completed from the saved handoff'}}); emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:12,cached_input_tokens:0}}); }
`); chmodSync(codex, 0o755);
  const previousPath = process.env.PATH; const previousCodexHome = process.env.CODEX_HOME; process.env.PATH = `${bin}:${previousPath}`; process.env.CODEX_HOME = codexHome;
  const execution = Execution(f.store, f.domain, f.stateDir);
  try {
    const task: any = f.domain.call('task.create', { projectId: f.project.id, specId: f.accepted.id, specHash: f.accepted.hash, requirements: ['H-044'], objective: 'Continue profile fixture', criteria: ['Fixture'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 20_000, context: { targetTokens: 40_000, checkpointTokens: 20_000, reserveTokens: 1_000, exceptionMaxTokens: 50_000 }, workerProfile: { id: 'codex:fixture-model:high', runtime: 'codex', model: 'fixture-model', thinking: 'high', label: 'Fixture model', source: 'local-metadata', verified: true } }, runtime: 'codex-profile', sourceCandidate: { id: f.candidate, specHash: f.accepted.hash }, deadline: new Date(Date.now() + 120_000).toISOString(), resources: [] }, owner);
    const approved: any = f.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve continuation fixture', source: 'test' }, owner).task;
    const first: any = await execution.tickProfiles();
    assert.equal(first.queue.started.length, 1);
    const firstRunId = first.queue.started[0];
    const paused: any = await waitFor(() => execution.call('runtime.inspect', { runId: firstRunId }, owner), value => value.status === 'paused');
    assert.equal(paused.exitCode, 75);
    assert.equal(f.store.require<any>('run', firstRunId).needsContinuation, true);
    const handoff = f.store.list<any>('worker_checkpoint').find(item => item.runId === firstRunId && /context checkpoint threshold/.test(item.summary));
    assert.ok(handoff);
    await waitFor(async () => { await execution.tickProfiles(); return f.store.require<any>('task', approved.id); }, value => value.state === 'Paused');
    assert.equal(f.store.list<any>('run').filter(run => run.taskId === approved.id).length, 1);
    const current = f.store.require<any>('task', approved.id);
    f.domain.call('task.control', { taskId: current.id, expectedRev: current.rev, command: 'resume' }, owner);
    const second: any = await waitFor(async () => { await execution.tickProfiles(); return f.store.list<any>('run').filter(run => run.taskId === approved.id); }, runs => runs.length === 2);
    const secondRunId = second.find((run: any) => run.id !== firstRunId).id;
    const completed: any = await waitFor(() => execution.call('runtime.inspect', { runId: secondRunId }, owner), value => value.status === 'completed');
    assert.equal(completed.exitCode, 0);
    assert.equal(f.store.require<any>('run', secondRunId).needsContinuation, false);
    await waitFor(async () => { await execution.tickProfiles(); return f.store.require<any>('task', approved.id); }, value => value.state === 'Verifying');
    const sent = readFileSync(prompts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[0], /context checkpoint threshold/);
    const packet = JSON.parse(sent[1].split('\nTask context:\n')[1]);
    assert.ok(packet.handoffs.some((item: any) => /context checkpoint threshold/.test(item.summary) && /fresh bounded run/.test(item.next) && item.candidate?.id === f.candidate), JSON.stringify(packet.handoffs));
    assert.ok(f.store.list<any>('worker_checkpoint').some(item => item.runId === secondRunId && item.summary === 'Continuation completed from the saved handoff'));
  } finally { await execution.close(); f.store.close(); process.env.PATH = previousPath; if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; }
});

test('an owner-paused profile run resumes its local SDK session in the fresh run', async () => {
  const f = fixture(true); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const codexHome = join(f.root, 'codex-home'); mkdirSync(codexHome);
  const fake = join(f.root, 'fake-codex'); mkdirSync(fake);
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }));
  const counter = join(fake, 'invocations'); const argsLog = join(fake, 'args.jsonl');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
if(process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); } if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const fs=await import('node:fs'); for await (const _ of process.stdin) {}
fs.appendFileSync(${JSON.stringify(argsLog)},JSON.stringify(process.argv.slice(2))+'\\n');
const invocation=(fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0)+1; fs.writeFileSync(${JSON.stringify(counter)},String(invocation));
const emit=value=>console.log(JSON.stringify(value));
emit({type:'thread.started',thread_id:'fixture-session-1'}); emit({type:'turn.started'});
if(invocation===1) setTimeout(()=>process.exit(0),30000);
else { emit({type:'item.completed',item:{id:'message',type:'agent_message',text:'Resumed session completed'}}); emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:12,cached_input_tokens:0}}); }
`); chmodSync(join(bin, 'codex'), 0o755);
  const previousPath = process.env.PATH; const previousCodexHome = process.env.CODEX_HOME; process.env.PATH = `${bin}:${previousPath}`; process.env.CODEX_HOME = codexHome;
  const execution = Execution(f.store, f.domain, f.stateDir);
  try {
    const task: any = f.domain.call('task.create', { projectId: f.project.id, specId: f.accepted.id, specHash: f.accepted.hash, requirements: ['H-044'], objective: 'Resume session fixture', criteria: ['Fixture'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 20_000, workerProfile: { id: 'codex:fixture-model:high', runtime: 'codex', model: 'fixture-model', thinking: 'high', label: 'Fixture model', source: 'local-metadata', verified: true } }, runtime: 'codex-profile', sourceCandidate: { id: f.candidate, specHash: f.accepted.hash }, deadline: new Date(Date.now() + 120_000).toISOString(), resources: [] }, owner);
    const approved: any = f.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve resume fixture', source: 'test' }, owner).task;
    const firstRunId = (await execution.tickProfiles()).queue.started[0];
    await waitFor(async () => f.store.require<any>('run', firstRunId), value => value.sdkSessionId === 'fixture-session-1');
    const running = f.store.require<any>('task', approved.id);
    f.domain.call('task.control', { taskId: running.id, expectedRev: running.rev, command: 'pause' }, owner);
    await waitFor(async () => { await execution.tickProfiles(); return f.store.require<any>('task', approved.id); }, value => value.state === 'Paused');
    const paused = f.store.require<any>('task', approved.id);
    f.domain.call('task.control', { taskId: paused.id, expectedRev: paused.rev, command: 'resume' }, owner);
    const runs: any = await waitFor(async () => { await execution.tickProfiles(); return f.store.list<any>('run').filter(run => run.taskId === approved.id); }, value => value.length === 2);
    const second = runs.find((run: any) => run.id !== firstRunId);
    assert.deepEqual(second.resumedSession, { runId: firstRunId, sessionId: 'fixture-session-1' });
    await waitFor(() => execution.call('runtime.inspect', { runId: second.id }, owner), value => value.status === 'completed');
    const args = readFileSync(argsLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(args[0].includes('resume'), false);
    assert.equal(args[1][args[1].indexOf('resume') + 1], 'fixture-session-1');
  } finally { await execution.close(); f.store.close(); process.env.PATH = previousPath; if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; }
});
