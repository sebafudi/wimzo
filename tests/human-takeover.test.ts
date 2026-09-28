import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';
import { Board } from '../src/board.ts';

const owner = { role: 'owner' as const, id: 'takeover-owner' };

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let value = await read();
  while (!done(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); value = await read(); }
  assert.ok(done(value), `Condition was not met before timeout: ${JSON.stringify(value)}`);
  return value;
}

function fixture(overrides: Record<string, any> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wimzo-takeover-')));
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-024 Capacity queue.** Approved work waits for capacity.\n');
  writeFileSync(join(root, 'slow.test.js'), "import test from 'node:test'; test('slow',async()=>{await new Promise(resolve=>setTimeout(resolve,30000))});\n");
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const candidate = git(root, 'rev-parse', 'HEAD');
  const stateDir = join(root, '.state');
  const store = new Store(join(stateDir, 'state.sqlite')); const domain = Domain(store);
  const project: any = domain.call('project.register', { id: 'takeover', name: 'Takeover', root, purpose: 'Takeover fixture', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured: any = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted: any = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Fixture acceptance', source: 'test' }, owner).spec;
  const worktree = join(stateDir, 'takeover-worktree'); git(root, 'worktree', 'add', '--detach', worktree, candidate);
  const created: any = domain.call('task.create', { projectId: project.id, specId: accepted.id, specHash: accepted.hash, requirements: ['H-024'], objective: 'Takeover fixture', criteria: ['Human can take over'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 60_000 }, sourceCandidate: { id: candidate, specHash: accepted.hash }, runtime: 'script', capability: 'node.test', capabilityInput: { args: ['slow.test.js'] }, worktree, resources: [], ...overrides }, owner);
  const task: any = domain.call('task.approve', { taskId: created.id, expectedRev: created.rev, decision: 'Approve fixture', source: 'test' }, owner).task;
  const execution = Execution(store, domain, stateDir);
  const board = Board(store, domain, execution as any, {} as any);
  const worker = { role: 'worker' as const, id: `execution:${task.id}`, taskId: task.id };
  const current = () => store.require<any>('task', task.id);
  const control = (command: string) => domain.call('task.control', { taskId: task.id, expectedRev: current().rev, command }, owner);
  return { root, worktree, store, domain, execution, board, worker, project, taskId: task.id, current, control, close: async () => { await execution.close(); store.close(); } };
}

function alive(group: number) { try { process.kill(-group, 0); return true; } catch { return false; } }
function types(store: Store, taskId: string) { return store.events().filter(event => event.data?.taskId === taskId).map(event => event.type); }

async function takeOverRunningProcess(f: ReturnType<typeof fixture>) {
  const run: any = await f.execution.call('runtime.start', { taskId: f.taskId }, owner);
  const running: any = await waitFor(() => f.execution.call('runtime.inspect', { runId: run.id }, owner), (value: any) => value.status === 'running' && value.processGroupId);
  f.control('takeover');
  assert.equal(f.current().controller, undefined);
  await waitFor(async () => { await f.execution.tick(); return f.current(); }, value => value.controller?.kind === 'human');
  return { runId: run.id, group: running.processGroupId as number };
}

test('takeover of a running process stops agent input before transferring control', async () => {
  const f = fixture();
  try {
    const { runId, group } = await takeOverRunningProcess(f);
    const task = f.current(); const run = f.store.require<any>('run', runId);
    assert.equal(alive(group), false);
    assert.equal(task.state, 'Paused'); assert.equal(run.status, 'paused'); assert.equal(run.state, 'Paused');
    assert.deepEqual({ kind: task.controller.kind, id: task.controller.id, runId: task.controller.runId, worktree: task.controller.worktree }, { kind: 'human', id: owner.id, runId, worktree: f.worktree });
    assert.equal(run.controller.id, owner.id);
    const order = types(f.store, f.taskId);
    const stopped = order.indexOf('task.takeover.input_stopped'); const transferred = order.indexOf('task.takeover.transferred');
    assert.ok(order.indexOf('task.control.acknowledged') < stopped && stopped < transferred, order.join(','));
    const events = f.store.events();
    assert.ok(events.findIndex(event => event.type === 'checkpoint.saved' && event.data?.checkpointId === `checkpoint:${runId}:takeover`) < events.findIndex(event => event.type === 'task.takeover.input_stopped'));
    assert.equal(f.store.get<any>('checkpoint', `checkpoint:${runId}:takeover`)?.data.reason, 'takeover');
  } finally { await f.close(); }
});

test('a human-controlled task is never relaunched, refuses worker calls and shows on the Board', async () => {
  const f = fixture();
  try {
    const { runId } = await takeOverRunningProcess(f);
    for (let index = 0; index < 3; index++) { const tick = await f.execution.tick(); assert.equal(tick.queue.started.length, 0); }
    assert.equal(f.store.list<any>('run').filter(run => run.taskId === f.taskId).length, 1);
    assert.throws(() => f.control('resume'), /under human control/);
    assert.throws(() => f.control('pause'), /under human control/);
    assert.throws(() => f.control('takeover'), /under human control/);
    const task = f.current();
    assert.throws(() => f.domain.call('task.workerResult', { taskId: task.id, runId, candidate: { id: 'x' }, summary: 'late result', expectedTaskRev: task.rev }, f.worker), /under human control/);
    assert.throws(() => f.domain.call('task.ack', { taskId: task.id, expectedRev: task.rev, command: 'pause' }, f.worker), /under human control/);
    assert.throws(() => f.domain.call('evidence.record', { taskId: task.id, candidate: { id: 'x' }, specHash: task.specHash, check: 'late', environment: 'fixture', result: 'pass' }, f.worker), /under human control/);
    assert.deepEqual(f.domain.call('task.waiting', { taskId: task.id }, owner).reasons.filter((reason: string) => reason.startsWith('human_control')), [`human_control:${owner.id}`]);
    const board: any = await f.board.call('board.list', { projectId: f.project.id }, owner);
    const lane = board.columns.find((column: any) => column.cards.some((card: any) => card.taskId === task.id));
    const card = lane.cards.find((item: any) => item.taskId === task.id);
    assert.equal(lane.id, 'blocked'); assert.equal(card.status, 'Paused (human control)');
    assert.deepEqual(card.waitingReasons, [`Human control by ${owner.id}; release it to return the task to agents`]);
    assert.equal(card.controller.worktree, f.worktree);
  } finally { await f.close(); }
});

test('release checkpoints the human worktree so an owner resume starts a fresh run', async () => {
  const f = fixture();
  try {
    const { runId } = await takeOverRunningProcess(f);
    writeFileSync(join(f.worktree, 'human.txt'), 'human change\n');
    f.control('release');
    await f.execution.tick();
    let task = f.current(); const run = f.store.require<any>('run', runId);
    assert.equal(task.state, 'Paused'); assert.equal(task.controller, undefined); assert.equal(task.lastController.id, owner.id);
    assert.equal(run.controller, undefined); assert.equal(run.checkpointCandidate.dirty, true);
    assert.match(git(f.worktree, 'show', `${run.checkpointCandidate.materializedCommit}:human.txt`), /human change/);
    assert.ok(f.store.list<any>('checkpoint').some(value => value.runId === runId && value.data.reason.startsWith('human-release') && value.data.candidate.materializedCommit === run.checkpointCandidate.materializedCommit));
    assert.ok(types(f.store, f.taskId).includes('task.takeover.released'));
    f.control('resume');
    const tick = await f.execution.tick();
    task = f.current();
    assert.equal(task.state, 'Running'); assert.notEqual(task.runId, runId); assert.deepEqual(tick.queue.started, [task.runId]);
    await f.execution.call('runtime.cancel', { runId: task.runId }, owner);
  } finally { await f.close(); }
});

test('native session takeover waits for the bound worker to stop, or for the session to be gone', async () => {
  const f = fixture({ runtime: 'codex-app', capability: undefined, capabilityInput: undefined });
  try {
    const run: any = await f.execution.call('runtime.start', { taskId: f.taskId, runtime: 'codex-app', runType: 'gui' }, owner);
    f.control('takeover');
    const tick = await f.execution.tick();
    let task = f.current();
    assert.ok(!tick.controls.includes(task.id)); assert.equal(task.state, 'Running'); assert.equal(task.requested.command, 'takeover'); assert.equal(task.controller, undefined);
    assert.throws(() => f.domain.call('task.workerResult', { taskId: task.id, runId: run.id, candidate: { id: 'x' }, summary: 'late', expectedTaskRev: task.rev }, f.worker), /stopping agent input/);
    task = f.domain.call('task.ack', { taskId: task.id, expectedRev: task.rev, command: 'takeover', checkpoint: { summary: 'native session stopped' } }, f.worker);
    assert.equal(task.state, 'Paused'); assert.equal(task.controller.kind, 'human');
    const order = types(f.store, f.taskId);
    assert.ok(order.indexOf('task.takeover.input_stopped') < order.indexOf('task.takeover.transferred'));
    await f.execution.tick();
    assert.equal(f.store.require<any>('run', run.id).status, 'paused');
    f.control('release'); await f.execution.tick();
    assert.equal(f.current().controller, undefined); assert.equal(f.current().state, 'Paused');

    const gone = fixture({ runtime: 'codex-app', capability: undefined, capabilityInput: undefined });
    try {
      const session: any = await gone.execution.call('runtime.start', { taskId: gone.taskId, runtime: 'codex-app', runType: 'gui' }, owner);
      gone.control('takeover');
      await gone.execution.tick(); assert.equal(gone.current().controller, undefined);
      const stale = gone.store.require<any>('run', session.id); gone.store.put('run', { ...stale, status: 'failed' }, stale.rev);
      await gone.execution.tick();
      assert.equal(gone.current().controller.kind, 'human'); assert.equal(gone.current().acknowledged.by, 'execution-control');
    } finally { await gone.close(); }
  } finally { await f.close(); }
});
