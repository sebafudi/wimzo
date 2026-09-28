import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';

const owner = { role: 'owner' as const, id: 'pause-owner' };

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let value = await read();
  while (!done(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); value = await read(); }
  assert.ok(done(value), `Condition was not met before timeout: ${JSON.stringify(value)}`);
  return value;
}

test('a pause request on a slow-exiting process ends paused and resume still verifies the saved checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-slow-pause-'));
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-024 Capacity queue.** Approved work waits for capacity.\n');
  writeFileSync(join(root, 'slow-exit.test.js'), "import test from 'node:test'; process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),4000)); test('slow exit',async()=>{await new Promise(resolve=>setTimeout(resolve,60000))});\n");
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const candidate = git(root, 'rev-parse', 'HEAD');
  const stateDir = join(root, '.state');
  const store = new Store(join(stateDir, 'state.sqlite')); const domain = Domain(store);
  const project: any = domain.call('project.register', { id: 'slow_pause', name: 'Slow pause', root, purpose: 'Pause fixture', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured: any = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted: any = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Fixture acceptance', source: 'test' }, owner).spec;
  const worktree = join(stateDir, 'slow-worktree'); git(root, 'worktree', 'add', '--detach', worktree, candidate);
  const created: any = domain.call('task.create', { projectId: project.id, specId: accepted.id, specHash: accepted.hash, requirements: ['H-024'], objective: 'Slow exit fixture', criteria: ['Stops as paused'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 60_000 }, sourceCandidate: { id: candidate, specHash: accepted.hash }, runtime: 'script', capability: 'node.test', capabilityInput: { args: ['slow-exit.test.js'] }, worktree, resources: [] }, owner);
  const approved: any = domain.call('task.approve', { taskId: created.id, expectedRev: created.rev, decision: 'Approve fixture', source: 'test' }, owner).task;
  const execution = Execution(store, domain, stateDir);
  try {
    const run: any = await execution.call('runtime.start', { taskId: approved.id }, owner);
    await waitFor(() => execution.call('runtime.inspect', { runId: run.id }, owner), (value: any) => value.status === 'running');
    await new Promise(resolve => setTimeout(resolve, 500));
    let task = store.require<any>('task', approved.id);
    domain.call('task.control', { taskId: task.id, expectedRev: task.rev, command: 'pause' }, owner);
    await execution.tick();
    assert.ok(['pause_requested', 'paused'].includes(store.require<any>('run', run.id).status));
    assert.equal(store.require<any>('task', approved.id).requested?.command, 'pause');
    await waitFor(async () => { await execution.tick(); return store.require<any>('task', approved.id); }, value => value.state === 'Paused');
    const stopped = store.require<any>('run', run.id);
    assert.equal(stopped.status, 'paused');
    assert.equal(typeof stopped.checkpointCandidate, 'object');
    writeFileSync(join(worktree, 'tampered.txt'), 'changed after checkpoint\n');
    task = store.require<any>('task', approved.id);
    domain.call('task.control', { taskId: task.id, expectedRev: task.rev, command: 'resume' }, owner);
    await execution.tick();
    assert.equal(store.require<any>('task', approved.id).state, 'Paused');
    assert.match(store.require<any>('run', run.id).resumeBlockedReason, /changed after its checkpoint/);
  } finally { await execution.close(); store.close(); }
});
