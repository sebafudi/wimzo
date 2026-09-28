import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.ts';
import { scopedWorkerTools } from '../src/worker-bridge.ts';

test('worker phase input cannot override its bound task or current revision', async () => {
  const store = new Store(':memory:');
  store.put('task', { id: 'bound-task', projectId: 'bridge-project', state: 'Running', runId: 'bound-run', workerId: 'bridge-worker' });
  const task = store.require<any>('task', 'bound-task');
  let call: any;
  const app = {
    store,
    async call(action: string, input: any, actor: any) { call = { action, input, actor }; return { phase: input.phase }; },
  };
  try {
    const tools = scopedWorkerTools(app as any, 'bound-task', 'bound-run');
    await tools.invoke('wimzo_phase', { taskId: 'other-task', expectedRev: 0, phase: 'planning', note: 'Read the accepted scope.' });
    assert.equal(call.action, 'board.phase');
    assert.equal(call.input.taskId, 'bound-task');
    assert.equal(call.input.expectedRev, task.rev);
    assert.equal(call.actor.taskId, 'bound-task');
  } finally { store.close(); }
});

test('scoped worker tools expose no owner approval or acceptance operation', () => {
  const store = new Store(':memory:');
  store.put('task', { id: 'bound-task', projectId: 'bridge-project', state: 'Running', runId: 'bound-run' });
  const app = { store, call: async () => ({}) };
  try {
    const definitions = scopedWorkerTools(app as any, 'bound-task', 'bound-run').definitions;
    assert.deepEqual(definitions.map(tool => tool.name), ['wimzo_context', 'wimzo_specification', 'wimzo_checkpoint', 'wimzo_phase']);
    assert.equal(definitions.find(tool => tool.name === 'wimzo_context')!.annotations.readOnlyHint, true);
    assert.equal(definitions.find(tool => tool.name === 'wimzo_specification')!.annotations.readOnlyHint, true);
    assert(definitions.every(tool => !/approve|accept|owner|publish|release/i.test(tool.name)));
    assert(definitions.every(tool => tool.annotations.destructiveHint === false));
  } finally { store.close(); }
});

test('workflow bridge tools bind feature, task and current revision from the active task', async () => {
  const store = new Store(':memory:');
  store.put('task', { id: 'workflow-task', projectId: 'bridge-project', state: 'Running', runId: 'workflow-run', workerId: 'workflow-worker', workflow: { featureId: 'feature-one' } });
  const task = store.require<any>('task', 'workflow-task');
  let call: any;
  const app = { store, async call(action: string, input: any, actor: any) { call = { action, input, actor }; return {}; } };
  try {
    const tools = scopedWorkerTools(app as any, 'workflow-task', 'workflow-run');
    assert.deepEqual(tools.definitions.slice(-5).map((tool: any) => tool.name), ['wimzo_workflow_draft_context', 'wimzo_workflow_propose_requirements', 'wimzo_workflow_submit_plan', 'wimzo_workflow_progress', 'wimzo_workflow_continuation']);
    await tools.invoke('wimzo_workflow_progress', { featureId: 'other', taskId: 'other-task', expectedTaskRev: 0, summary: 'Completed the bounded reading.' });
    assert.equal(call.action, 'workflow.progress');
    assert.deepEqual(call.input, { featureId: 'feature-one', taskId: 'workflow-task', expectedTaskRev: task.rev, summary: 'Completed the bounded reading.' });
    assert.equal(call.actor.taskId, 'workflow-task');
  } finally { store.close(); }
});

test('verification bridge binds its assigned target and refuses caller target overrides', async () => {
  const store = new Store(':memory:');
  store.put('task', { id: 'verification-task', projectId: 'bridge-project', state: 'Running', runId: 'verification-run', workflow: { featureId: 'feature-one', purpose: 'verification', targetTaskId: 'implementation-task' } });
  const task = store.require<any>('task', 'verification-task');
  let call: any;
  const app = { store, async call(action: string, input: any, actor: any) { call = { action, input, actor }; return {}; } };
  try {
    const tools = scopedWorkerTools(app as any, 'verification-task', 'verification-run');
    assert(tools.definitions.some((tool: any) => tool.name === 'wimzo_workflow_submit_verification'));
    await tools.invoke('wimzo_workflow_submit_verification', { targetTaskId: 'foreign-task', expectedTaskRev: 0, candidate: { id: 'candidate' }, checks: [{ check: 'One check', result: 'pass' }], summary: 'Verified exact candidate.', submissionId: 'verify-1' });
    assert.equal(call.action, 'workflow.submitVerification');
    assert.equal(call.input.featureId, 'feature-one');
    assert.equal(call.input.taskId, 'verification-task');
    assert.equal(call.input.targetTaskId, 'implementation-task');
    assert.equal(call.input.expectedTaskRev, task.rev);
  } finally { store.close(); }
});
