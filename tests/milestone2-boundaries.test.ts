import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'milestone-2-owner' };

async function acceptedProject(app: App, root: string, id: string) {
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-024 Queue fixture.** Work waits for a project dispatch pause.\n');
  const project = await app.call('project.register', {
    id,
    name: id,
    root,
    purpose: 'isolated milestone 2 boundary fixture',
    canonicalPaths: ['spec/PRD.md'],
  }, owner);
  const draft = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted = (await app.call('spec.accept', {
    specId: draft.id,
    hash: draft.hash,
    expectedRev: draft.rev,
    decision: 'Accept isolated queue fixture',
    source: 'milestone 2 isolated test fixture',
  }, owner)).spec;
  return { project, spec: accepted };
}

async function approvedTask(app: App, project: any, spec: any, id: string, overrides: Record<string, any> = {}) {
  const task = await app.call('task.create', {
    id,
    projectId: project.id,
    specId: spec.id,
    specHash: spec.hash,
    requirements: ['H-024'],
    objective: 'Prove dispatch pause is authoritative',
    criteria: ['fixture boundary check'],
    scope: 'isolated fixture only',
    permissions: [],
    budget: {},
    sourceCandidate: { id: 'a'.repeat(40) },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }, owner);
  return (await app.call('task.approve', {
    taskId: task.id,
    expectedRev: task.rev,
    decision: 'Approve isolated queue fixture',
    source: 'milestone 2 isolated test fixture',
  }, owner)).task;
}

async function verifyingTask(app: App, project: any, spec: any, id: string) {
  const task = await approvedTask(app, project, spec, id);
  const worker = { role: 'worker' as const, id: `${id}-worker`, taskId: task.id };
  const claim = await app.call('task.claim', { taskId: task.id, expectedRev: task.rev }, worker);
  const candidate = { id: `${id}-candidate`, specHash: spec.hash };
  const verifying = (await app.call('task.workerResult', {
    taskId: task.id,
    runId: claim.run.id,
    expectedTaskRev: claim.task.rev,
    candidate,
    summary: 'Fixture implementation complete',
  }, worker)).task;
  return { task: verifying, worker, candidate };
}

test('a task-bound worker cannot claim an approved task while its project dispatch is paused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-pause-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'pause_project');
    const task = await approvedTask(app, project, spec, 'pause_task');
    const worker = { role: 'worker' as const, id: 'pause-worker', taskId: task.id };
    await app.call('dispatch.pause', { projectId: project.id, decision: 'Fixture maintenance window' }, owner);

    const waiting = await app.call('task.waiting', { taskId: task.id }, worker);
    assert.deepEqual(waiting.reasons, [`dispatch_paused:${project.id}`]);

    const claim = await app.call('task.claim', { taskId: task.id, expectedRev: task.rev }, worker);
    assert.equal(claim.claimed, false);
    assert.deepEqual(claim.reasons, [`dispatch_paused:${project.id}`]);
    assert.equal((await app.call('task.get', { taskId: task.id }, owner)).state, 'Approved');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task-bound worker cannot read foreign triage, dispatch, specifications or watches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-isolation-'));
  const app = new App(join(root, 'state'));
  try {
    const own = await acceptedProject(app, join(root, 'own'), 'own_project');
    const task = await approvedTask(app, own.project, own.spec, 'own_task');
    const foreign = await acceptedProject(app, join(root, 'foreign'), 'foreign_project');
    await app.call('triage.classify', {
      projectId: foreign.project.id,
      classification: 'gap',
      summary: 'Foreign project boundary fixture',
    }, owner);
    await app.call('dispatch.pause', { projectId: foreign.project.id, decision: 'Foreign maintenance window' }, owner);
    const worker = { role: 'worker' as const, id: 'own-worker', taskId: task.id };

    await assert.rejects(
      app.call('triage.list', { projectId: foreign.project.id }, worker),
      /Worker may access only its project/,
    );
    await assert.rejects(
      app.call('dispatch.status', { projectId: foreign.project.id }, worker),
      /Worker may access only its project/,
    );
    await assert.rejects(app.call('spec.capture', { projectId: foreign.project.id, path: 'spec/PRD.md' }, worker), /Action unavailable for worker/);
    const ownWatch = await app.call('watch.create', { projectId: own.project.id, repository: own.project.root, kind: 'git-ref' }, owner);
    await app.call('watch.create', { projectId: foreign.project.id, repository: foreign.project.root, kind: 'git-ref' }, owner);
    await assert.rejects(app.call('watch.list', { projectId: foreign.project.id }, worker), /Worker may access only its project/);
    assert.deepEqual((await app.call('watch.list', {}, worker)).map((watch: any) => watch.id), [ownWatch.id]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App rejects an object worktree before task creation persists ownership state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'schema_project');
    await assert.rejects(
      app.call('task.create', {
        id: 'invalid_worktree_task',
        projectId: project.id,
        specId: spec.id,
        specHash: spec.hash,
        requirements: ['H-024'],
        objective: 'Reject invalid worktree shape',
        criteria: ['schema rejects object worktree'],
        scope: 'isolated fixture only',
        permissions: [],
        budget: {},
        worktree: { path: 'not-a-worktree-string' },
      }, owner),
      /worktree/,
    );
    await assert.rejects(app.call('task.get', { taskId: 'invalid_worktree_task' }, owner), /Unknown task/);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts structured task results and preserves arrays and usage metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-result-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'result_schema_project');
    const task = await approvedTask(app, project, spec, 'result_schema_task');
    const worker = { role: 'worker' as const, id: 'result-schema-worker', taskId: task.id };
    const claim = await app.call('task.claim', { taskId: task.id, expectedRev: task.rev }, worker);
    const candidate = { id: 'result-schema-candidate', specHash: spec.hash };
    const result = await app.call('task.workerResult', {
      taskId: task.id,
      runId: claim.run.id,
      expectedTaskRev: claim.task.rev,
      candidate,
      summary: 'Fixture implementation complete',
      checks: ['npm run check', 'node --test tests/milestone2-boundaries.test.ts'],
      unresolved: ['No external validation in this fixture'],
      usage: { turns: 3, providerAllowance: 'fixture' },
      exitReason: 'completed',
    }, worker);
    assert.deepEqual(result.result.checks, ['npm run check', 'node --test tests/milestone2-boundaries.test.ts']);
    assert.deepEqual(result.result.unresolved, ['No external validation in this fixture']);
    assert.deepEqual(result.result.usage, { turns: 3, providerAllowance: 'fixture' });
    assert.equal(result.result.exitReason, 'completed');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts exact evidence command, notes, and observation time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-evidence-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'evidence_schema_project');
    const { task, worker, candidate } = await verifyingTask(app, project, spec, 'evidence_schema_task');
    const at = '2026-09-15T12:00:00.000Z';
    const evidence = await app.call('evidence.record', {
      taskId: task.id,
      candidate,
      specHash: spec.hash,
      check: 'fixture boundary check',
      environment: 'isolated App fixture',
      result: 'pass',
      command: 'npm run check',
      notes: 'Structured evidence field coverage',
      at,
    }, worker);
    assert.equal(evidence.command, 'npm run check');
    assert.equal(evidence.notes, 'Structured evidence field coverage');
    assert.equal(evidence.at, at);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts release notes after exact owner review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-release-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'release_schema_project');
    let { task, worker, candidate } = await verifyingTask(app, project, spec, 'release_schema_task');
    await app.call('evidence.record', {
      taskId: task.id,
      candidate,
      specHash: spec.hash,
      check: 'fixture boundary check',
      environment: 'isolated App fixture',
      result: 'pass',
    }, worker);
    task = await app.call('task.verify', {
      taskId: task.id,
      expectedRev: task.rev,
      candidate,
      specHash: spec.hash,
    }, worker);
    task = (await app.call('task.review', {
      taskId: task.id,
      expectedRev: task.rev,
      candidate,
      decision: 'accept',
      source: 'milestone 2 isolated test fixture',
    }, owner)).task;
    const release = await app.call('release.decide', {
      taskId: task.id,
      candidate,
      decision: 'defer',
      source: 'milestone 2 isolated test fixture',
      notes: 'Awaiting a separate activation decision',
    }, owner);
    assert.equal(release.notes, 'Awaiting a separate activation decision');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts triage requirements and status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-triage-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project } = await acceptedProject(app, join(root, 'project'), 'triage_schema_project');
    const triage = await app.call('triage.classify', {
      projectId: project.id,
      classification: 'gap',
      summary: 'Fixture requirement gap',
      requirements: ['H-024'],
      status: 'needs requirement review',
    }, owner);
    assert.deepEqual(triage.requirements, ['H-024']);
    assert.equal(triage.status, 'needs requirement review');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts outside observation behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-outside-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project } = await acceptedProject(app, join(root, 'project'), 'outside_schema_project');
    const observed = await app.call('outside.observe', {
      projectId: project.id,
      revision: 'fixture-observation-1',
      summary: 'Fixture behavior changed',
      behavior: 'changed',
      affectedRequirements: ['H-024'],
    }, { role: 'system', id: 'observation-fixture' });
    assert.equal(observed.observation.behavior, 'changed');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts string and object conversation handoffs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-context-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project } = await acceptedProject(app, join(root, 'project'), 'context_schema_project');
    let conversation = await app.call('conversation.focus', {
      conversationId: 'context-schema-conversation',
      projectId: project.id,
      focus: { requirement: 'H-024' },
      handoff: 'Resume from the queue inspection result.',
    }, owner);
    assert.equal(conversation.handoff, 'Resume from the queue inspection result.');
    conversation = await app.call('conversation.focus', {
      conversationId: conversation.id,
      projectId: project.id,
      expectedRev: conversation.rev,
      handoff: { taskId: 'context-schema-task', next: 'Inspect waiting reasons' },
    }, owner);
    assert.deepEqual(conversation.handoff, { taskId: 'context-schema-task', next: 'Inspect waiting reasons' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('App accepts context requirement IDs and omission arrays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-context-input-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const { project } = await acceptedProject(app, join(root, 'project'), 'context_input_schema_project');
    const context = await app.call('context.build', {
      projectId: project.id,
      requirementIds: ['H-024'],
      omittedCategories: ['unselected fixture requirements', 'foreign fixture projects'],
    }, owner);
    assert.deepEqual(context.rules.map((rule: any) => rule.requirementId), ['H-024']);
    assert.deepEqual(context.receipt.omittedCategories, ['unselected fixture requirements', 'foreign fixture projects']);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('action catalog is concise, complete for context selection and rejects unrelated inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-catalog-'));
  const app = new App(join(root, 'state'));
  try {
    const actions = app.actions(owner);
    assert.ok(Buffer.byteLength(JSON.stringify(actions)) < 43500);
    assert.deepEqual(Object.keys(actions.find(action => action.name === 'project.list')!.inputSchema.properties), []);
    assert.equal(actions.find(action => action.name === 'context.build')!.inputSchema.properties.requirementIds.type, 'array');
    await assert.rejects(app.call('project.list', { candidate: { id: 'irrelevant' } }, owner), /Unknown input.candidate/);
    assert.ok(!app.actions({ role: 'guide', id: 'guide' }).some(action => action.name === 'task.approve'));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('queue reads include fresh approvals, exclude terminal history and derive current pause and limit reasons without dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-queue-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'queue_project');
    const first = await approvedTask(app, project, spec, 'fresh', { runtime: 'script', capability: 'node.test', priority: 20 });
    const second = await approvedTask(app, project, spec, 'canceled', { runtime: 'script', capability: 'node.test' });
    const control = await app.call('task.control', { taskId: second.id, expectedRev: second.rev, command: 'cancel' }, owner);
    await app.call('task.ack', { taskId: second.id, expectedRev: control.rev, command: 'cancel' }, { role: 'system', id: 'fixture' });
    app.store.put('execution_queue', { id: `queue:${second.id}`, taskId: second.id, projectId: project.id, reason: 'old stale reason' });
    const watermark = app.store.watermark();
    const runs = app.store.list('run').length;
    const queue = await app.call('execution.queue', { projectId: project.id }, owner);
    assert.deepEqual(queue.map((row: any) => row.taskId), [first.id]);
    assert.deepEqual(queue[0].reasons, []);
    assert.equal(app.store.watermark(), watermark);
    assert.equal(app.store.list('run').length, runs);
    await app.call('dispatch.pause', { projectId: project.id, decision: 'maintenance fixture' }, owner);
    assert.match((await app.call('execution.queue', {}, owner))[0].reason, /dispatch_paused:queue_project/);
    await app.call('dispatch.resume', { projectId: project.id, decision: 'resume fixture' }, owner);
    app.store.put('execution_limits', { id: 'global', stopNewWork: true, reason: 'fixture allowance' });
    const paused = await app.call('execution.tick', {}, { role: 'system', id: 'fixture' });
    assert.deepEqual(paused.queue.started, []);
    assert.equal(paused.queue.waiting[0].taskId, first.id);
    assert.match(paused.queue.waiting[0].reason, /dispatch_paused:fixture allowance/);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('equal-priority queue display and dispatch use the same creation order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-order-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'order_project');
    const first = await approvedTask(app, project, spec, 'z_created_first', { runtime: 'script', capability: 'node.test' });
    const second = await approvedTask(app, project, spec, 'a_created_second', { runtime: 'script', capability: 'node.test' });
    app.store.put('task', { ...first, createdBy: { ...first.createdBy, at: '2026-09-15T10:00:00.000Z' } }, first.rev);
    app.store.put('task', { ...second, createdBy: { ...second.createdBy, at: '2026-09-15T10:01:00.000Z' } }, second.rev);
    await app.call('dispatch.pause', { projectId: project.id, decision: 'Inspect ordering without launching work' }, owner);
    const queue = await app.call('execution.queue', {}, owner);
    const tick = await app.call('execution.tick', {}, { role: 'system', id: 'fixture' });
    assert.deepEqual(queue.map((row: any) => row.taskId), [first.id, second.id]);
    assert.deepEqual(tick.queue.waiting.map((row: any) => row.taskId), queue.map((row: any) => row.taskId));
    assert.deepEqual(tick.queue.started, []);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('execution schemas support explicit limit pauses and typed unknown telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-execution-schema-'));
  const app = new App(join(root, 'state'));
  try {
    const limit = await app.call('runtime.limit_set', { runtime: 'claude', source: 'isolated schema fixture', stopNewWork: true, providerRemaining: null, contextUsed: 20, contextCapacity: 100, taskTimeoutMs: 60000, warningThreshold: { providerRemaining: 10, contextRatio: 0.9 } }, owner);
    assert.equal(limit.stopNewWork, true);
    assert.equal(limit.provider.status, 'unknown');
    assert.equal(limit.context.used, 20);
    await assert.rejects(app.call('runtime.limit_set', { runtime: 'claude', source: 'fixture', providerRemaining: '20' }, owner), /providerRemaining/);
    await assert.rejects(app.call('runtime.limit_set', { runtime: 'claude', source: 'fixture', stopNewWork: 'false' }, owner), /stopNewWork/);
    await assert.rejects(app.call('runtime.start', {}, owner), /taskId is required/);
    await assert.rejects(app.call('runtime.start', { taskId: 'unused', worktree: {} }, owner), /worktree/);
    assert.equal(app.store.list('run').length, 0);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('exact setup review acceptance preserves mismatched and foreign decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-inbox-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'inbox_project');
    writeFileSync(join(project.root, 'spec/PRD.md'), '**H-024 Queue fixture.** A reviewed second revision.\n');
    const draft = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
    const exact = await app.call('inbox.create', { projectId: project.id, kind: 'PRD review', summary: 'Review', data: { specId: draft.id, hash: draft.hash } }, owner);
    const wrong = await app.call('inbox.create', { projectId: project.id, kind: 'PRD review', summary: 'Review', data: { specId: draft.id, hash: 'different' } }, owner);
    const hashless = await app.call('inbox.create', { projectId: project.id, kind: 'PRD review', summary: 'Review', data: { specId: draft.id } }, owner);
    const older = await app.call('inbox.create', { projectId: project.id, kind: 'PRD review', summary: 'Review', data: { specId: spec.id, hash: spec.hash } }, owner);
    await app.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'Fixture accepts revision', source: 'isolated test' }, owner);
    const all = await app.call('inbox.list', { projectId: project.id }, owner);
    assert.equal(all.find((item: any) => item.id === exact.id).status, 'resolved');
    assert.equal(all.find((item: any) => item.id === wrong.id).status, 'pending');
    assert.equal(all.find((item: any) => item.id === older.id).status, 'pending');
    assert.equal(all.find((item: any) => item.id === hashless.id).status, 'pending');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cancel acknowledgement resolves obsolete prompts only for the canceled task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-m2-cancel-inbox-'));
  const app = new App(join(root, 'state'));
  try {
    const { project, spec } = await acceptedProject(app, join(root, 'project'), 'cancel_project');
    const one = await approvedTask(app, project, spec, 'cancel_one');
    const two = await approvedTask(app, project, spec, 'keep_two');
    const obsolete = await app.call('inbox.create', { projectId: project.id, kind: 'verification needed', summary: 'Review', data: { taskId: one.id } }, owner);
    const unrelated = await app.call('inbox.create', { projectId: project.id, kind: 'verification needed', summary: 'Review', data: { taskId: two.id } }, owner);
    const control = await app.call('task.control', { taskId: one.id, expectedRev: one.rev, command: 'cancel' }, owner);
    await app.call('task.ack', { taskId: one.id, expectedRev: control.rev, command: 'cancel' }, { role: 'system', id: 'fixture' });
    const inbox = await app.call('inbox.list', { projectId: project.id }, owner);
    assert.equal(inbox.find((item: any) => item.id === obsolete.id).status, 'resolved');
    assert.equal(inbox.find((item: any) => item.id === unrelated.id).status, 'pending');
    assert.equal((await app.call('task.get', { taskId: two.id }, owner)).state, 'Approved');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
