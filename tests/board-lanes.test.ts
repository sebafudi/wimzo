import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'lanes-owner' };

function lanesFixture(queue: any[] = []) {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-board-lanes-'));
  const root = join(temp, 'project');
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), ['H-001', 'H-002', 'H-003', 'H-004', 'H-005', 'H-006'].map(value => `**${value} Fixture.**\nBoard lane behavior.\n`).join('\n'));
  const store = new Store(':memory:');
  const domain = Domain(store);
  const execution = { call: (action: string) => { assert.equal(action, 'execution.queue'); return queue; } };
  const board = Board(store, domain, execution as any, {} as any);
  const project = domain.call('project.register', { id: 'lanes-project', name: 'Lanes fixture', root, purpose: 'board lane tests', canonicalPaths: ['spec/PRD.md'] }, owner);
  const draft = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const spec = domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, requirementIds: draft.requirementIds, decision: 'Fixture acceptance', source: 'board lanes test' }, owner).spec;
  function taskIn(requirement: string, objective: string, patch: Record<string, unknown>) {
    const created = domain.call('task.create', { projectId: project.id, specId: spec.id, specHash: spec.hash, requirements: [requirement], objective, criteria: ['lane fixture'], scope: `${objective} scope.`, permissions: [], budget: {} }, owner);
    return store.put<any>('task', { ...store.require<any>('task', created.id), ...patch }, created.rev);
  }
  return { store, board, project, taskIn, close: () => { store.close(); rmSync(temp, { recursive: true, force: true }); } };
}

function lanes(value: any): Record<string, any[]> { return Object.fromEntries(value.columns.map((column: any) => [column.id, column.cards])); }
function laneOf(value: any, taskId: string) { return value.columns.find((column: any) => column.cards.some((card: any) => card.taskId === taskId))?.id; }
function cardOf(value: any, taskId: string) { return value.columns.flatMap((column: any) => column.cards).find((card: any) => card.taskId === taskId); }

test('Board places queued, running, verifying, review, blocked and completed work in actual-state lanes', async () => {
  const context = lanesFixture();
  try {
    const queued = context.taskIn('H-001', 'Queued export', { state: 'Approved', waitingReasons: ['worker capacity'] });
    const running = context.taskIn('H-002', 'Running export', { state: 'Running', waitingReasons: [], phase: { name: 'implementing', note: 'Writing the exporter.' } });
    const verifying = context.taskIn('H-003', 'Verifying export', { state: 'Verifying', waitingReasons: [] });
    const review = context.taskIn('H-004', 'Reviewable export', { state: 'Needs result review', waitingReasons: [] });
    const blocked = context.taskIn('H-005', 'Blocked export', { state: 'Blocked', waitingReasons: ['missing fixture credentials'] });
    const done = context.taskIn('H-006', 'Completed export', { state: 'Accepted', waitingReasons: [] });
    const listed = await context.board.call('board.list', { projectId: context.project.id }, owner);
    assert.deepEqual(listed.columns.map((column: any) => column.id), ['ideas', 'prd_review', 'ready', 'running', 'review', 'done', 'blocked']);
    assert.equal(laneOf(listed, queued.id), 'ready');
    assert.equal(laneOf(listed, running.id), 'running');
    assert.equal(laneOf(listed, verifying.id), 'running');
    assert.equal(laneOf(listed, review.id), 'review');
    assert.equal(laneOf(listed, blocked.id), 'blocked');
    assert.equal(laneOf(listed, done.id), 'done');
    assert.deepEqual(cardOf(listed, queued.id).waitingReasons, ['worker capacity']);
    assert.equal(cardOf(listed, running.id).status, 'Running (implementing)');
    assert.match(cardOf(listed, running.id).summary, /Writing the exporter/);
    assert.deepEqual(cardOf(listed, blocked.id).waitingReasons, ['missing fixture credentials']);
    assert.equal(lanes(listed).ready.some((card: any) => card.kind === 'spec'), false);
  } finally { context.close(); }
});

test('queued Board cards show fresh scheduler waiting reasons and failed or paused work stays blocked', async () => {
  const queue: any[] = [];
  const context = lanesFixture(queue);
  try {
    const multi = context.taskIn('H-001', 'Queued behind resources', { state: 'Approved', waitingReasons: ['stale reason'] });
    const single = context.taskIn('H-002', 'Queued behind pause', { state: 'Approved', waitingReasons: [] });
    const failed = context.taskIn('H-003', 'Failed export', { state: 'Failed', waitingReasons: ['verification failed'] });
    const paused = context.taskIn('H-004', 'Paused export', { state: 'Paused', waitingReasons: [] });
    queue.push({ taskId: multi.id, reasons: ['resource busy: export.lock', 'dependency pending'] }, { taskId: single.id, reason: 'dispatch_paused' });
    const listed = await context.board.call('board.list', { projectId: context.project.id }, owner);
    assert.equal(laneOf(listed, multi.id), 'ready');
    assert.deepEqual(cardOf(listed, multi.id).waitingReasons, ['resource busy: export.lock', 'dependency pending']);
    assert.equal(laneOf(listed, single.id), 'ready');
    assert.deepEqual(cardOf(listed, single.id).waitingReasons, ['dispatch_paused']);
    assert.equal(laneOf(listed, failed.id), 'blocked');
    assert.deepEqual(cardOf(listed, failed.id).waitingReasons, ['verification failed']);
    assert.equal(laneOf(listed, paused.id), 'blocked');
  } finally { context.close(); }
});

test('canceled and superseded work closes in the Done lane instead of Blocked', async () => {
  const context = lanesFixture();
  try {
    const canceled = context.taskIn('H-001', 'Canceled export', { state: 'Canceled', waitingReasons: ['owner canceled'] });
    const superseded = context.taskIn('H-002', 'Superseded export', { state: 'Superseded', waitingReasons: [] });
    const failed = context.taskIn('H-003', 'Failed export', { state: 'Failed', waitingReasons: ['tests failed'] });
    const listed = await context.board.call('board.list', { projectId: context.project.id }, owner);
    assert.equal(laneOf(listed, canceled.id), 'done');
    assert.equal(laneOf(listed, superseded.id), 'done');
    assert.equal(laneOf(listed, failed.id), 'blocked');
    assert.equal(cardOf(listed, canceled.id).status, 'Closed: canceled');
    assert.equal(cardOf(listed, superseded.id).status, 'Closed: superseded');
    assert.equal(cardOf(listed, canceled.id).closed, true);
    assert.deepEqual(cardOf(listed, canceled.id).waitingReasons, []);
    assert.equal(lanes(listed).blocked.some((card: any) => card.closed), false);
  } finally { context.close(); }
});
