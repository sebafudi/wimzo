import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.ts';
import { Workers } from '../src/workers.ts';

const owner = { role: 'owner' as const, id: 'status-owner' };
const guide = { role: 'guide' as const, id: 'status-guide' };

function fixture() {
  const store = new Store(':memory:');
  store.put('project', { id: 'alpha', name: 'Alpha', root: '/tmp/alpha', purpose: 'fixture', canonicalPaths: [] });
  store.put('project', { id: 'beta', name: 'Beta', root: '/tmp/beta', purpose: 'fixture', canonicalPaths: [] });
  store.put('task', {
    id: 'profiled', projectId: 'alpha', objective: 'Use the selected profile', state: 'Running', runtime: 'codex-profile',
    deadline: '2035-01-01T00:00:00.000Z', worktree: '/tmp/alpha-worktree', permissions: ['workspace-write'], budget: { workerProfile: { id: 'codex:gpt-6-astra:high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', source: 'local-metadata' } },
    phase: { name: 'implementing', note: 'Editing the approved files', at: '2030-01-01T00:02:00.000Z' },
  });
  store.put('run', {
    id: 'domain-claim', taskId: 'profiled', projectId: 'alpha', runtime: 'codex-profile', runType: 'technical', state: 'Running', startedAt: '2030-01-01T00:00:00.000Z', resources: [],
  });
  store.put('run', {
    id: 'runtime-run', taskId: 'profiled', projectId: 'alpha', runtime: 'codex-profile', runType: 'technical', adapterVersion: 1, status: 'running', startedAt: '2030-01-01T00:01:00.000Z',
    workerProfile: { id: 'codex:gpt-6-astra:high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', contextWindow: 200000, authRoute: 'subscription', source: 'local-metadata' }, usage: { contextCapacity: 'unknown' },
    sdkSessionId: 'sdk-session-safe', sdkUsage: { context: { used: 999 } }, contextTelemetry: { used: 4321, capacity: 200000, estimated: false, source: 'Codex SDK telemetry', observedAt: '2030-01-01T00:03:00.000Z' }, lastProgress: { summary: 'Running the selected verification.', at: '2030-01-01T00:03:00.000Z' },
    paths: { stdout: '/private/output', result: '/private/result' }, command: 'must not be returned', args: ['secret'],
  });
  store.put('task', { id: 'finished', projectId: 'beta', objective: 'Verify only', state: 'Verifying', runtime: 'codex-app', permissions: [], budget: {} });
  store.put('run', {
    id: 'finished-run', taskId: 'finished', projectId: 'beta', runtime: 'codex-app', runType: 'gui', adapterVersion: 1, status: 'completed', startedAt: '2030-01-01T00:00:00.000Z', finishedAt: '2030-01-01T00:05:00.000Z',
  });
  store.put('result', { id: 'result-1', projectId: 'beta', taskId: 'finished', summary: 'Safe result summary', candidate: {} });
  store.put('task', { id: 'waiting', projectId: 'alpha', objective: 'Queued bounded work', state: 'Approved', runtime: 'codex-profile', permissions: ['read-only'], budget: { workerProfile: { runtime: 'codex', model: 'gpt-6-luna', thinking: 'low', source: 'local-metadata' } } });
  const execution = {
    async call(action: string, input: any) {
      if (action === 'runtime.capabilities') return [
        { name: 'codex', version: 1, available: true, eligible: true, access: 'ChatGPT login', limits: { provider: { status: 'unknown' }, context: { status: 'unknown' }, task: { status: 'unknown' }, source: 'fixture', observedAt: '2030-01-01T00:00:00.000Z' } },
        { name: 'codex-profile', version: 1, available: true, eligible: true, access: 'ChatGPT login', limits: { provider: { status: 'unknown' }, context: { status: 'unknown' }, task: { status: 'unknown' }, source: 'fixture', observedAt: '2030-01-01T00:00:00.000Z' } },
        { name: 'codex-app', version: 1, available: true, eligible: false, access: 'app-driven session required', reason: 'session claim required', limits: {} },
      ];
      assert.equal(action, 'execution.queue');
      return [{ id: 'queue:waiting', taskId: 'waiting', projectId: 'alpha', reasons: ['technical_worker_capacity'], checkedAt: '2030-01-01T00:03:00.000Z' }].filter(row => !input.projectId || row.projectId === input.projectId);
    },
  };
  return { store, workers: Workers(store, execution), close: () => store.close() };
}

test('worker status uses the actual execution profile, hides raw launch data, and keeps unknown usage explicit', async () => {
  const context = fixture();
  try {
    const value = await context.workers.call('worker.status', { projectId: 'alpha' }, owner);
    assert.deepEqual(value.capacity, { activeTechnical: 1, maxTechnical: 2, activeGui: 0, maxGui: 1 });
    assert.equal(value.active.length, 1);
    assert.equal(value.runtimes.find((runtime: any) => runtime.id === 'codex')?.label, 'Codex CLI');
    assert.equal(value.runtimes.find((runtime: any) => runtime.id === 'codex-profile')?.label, 'Codex SDK');
    const run = value.active[0];
    assert.equal(run.id, 'runtime-run');
    assert.equal(run.model, 'gpt-6-astra');
    assert.equal(run.thinking, 'high');
    assert.equal(run.profileSource, 'local-metadata');
    assert.equal(run.contextWindow, 200000);
    assert.equal(run.authRoute, 'subscription');
    assert.deepEqual(run.context, { used: 4321, capacity: 200000, estimated: false, source: 'Codex SDK telemetry', observedAt: '2030-01-01T00:03:00.000Z' });
    assert.deepEqual(run.lastProgress, { at: '2030-01-01T00:03:00.000Z', summary: 'Running the selected verification.' });
    assert.equal(run.sessionId, 'sdk-session-safe');
    assert.equal(run.outputAvailable, true);
    assert.equal(JSON.stringify(value).includes('must not be returned'), false);
    assert.equal(JSON.stringify(value).includes('/private/output'), false);
    assert.deepEqual(value.queued[0]!.waitingReasons, ['technical_worker_capacity']);
  } finally { context.close(); }
});

test('worker status separates terminal runs from active work and filters every projection by project', async () => {
  const context = fixture();
  try {
    const alpha = await context.workers.status({ projectId: 'alpha' }, guide);
    assert.equal(alpha.recent.length, 0);
    assert.equal(alpha.active[0].phase, 'implementing');
    assert.equal(alpha.queued.length, 1);
    const all = await context.workers.status({}, owner);
    assert.equal(all.active.length, 1);
    assert.equal(all.recent.length, 1);
    assert.equal(all.recent[0].taskId, 'finished');
    assert.equal(all.recent[0].status, 'completed');
    assert.equal(all.recent[0].phase, null);
    assert.equal(all.recent[0].model, null);
    assert.equal(all.recent[0].profileSource, 'native app unknown');
    assert.equal(all.recent[0].resultSummary, 'Safe result summary');
  } finally { context.close(); }
});

test('worker status is available only to shared read roles and does not mutate durable state', async () => {
  const context = fixture();
  try {
    const before = { watermark: context.store.watermark(), records: JSON.stringify(context.store.list<any>('run')) };
    await context.workers.status({}, owner);
    assert.equal(context.store.watermark(), before.watermark);
    assert.equal(JSON.stringify(context.store.list<any>('run')), before.records);
    await assert.rejects(context.workers.call('worker.status', {}, { role: 'worker', id: 'bound-worker', taskId: 'profiled' }), /cannot call/);
  } finally { context.close(); }
});

test('paused workers explain why their saved checkpoint cannot resume', async () => {
  const context = fixture();
  try {
    const run = context.store.require<any>('run', 'runtime-run');
    context.store.put('run', { ...run, status: 'paused', resumeBlockedReason: 'Saved worktree is missing; restore the exact checkpoint before resuming.' }, run.rev);
    const status = await context.workers.status({ projectId: 'alpha' }, owner);
    assert.deepEqual(status.recent.find((value: any) => value.id === run.id).waitingReasons, ['Saved worktree is missing; restore the exact checkpoint before resuming.']);
  } finally { context.close(); }
});
