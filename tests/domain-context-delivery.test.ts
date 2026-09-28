import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';
import { contextBudget, contextDecision } from '../src/worker-context.ts';
import { piContextDecision } from '../src/pi-sdk.ts';

const owner = { role: 'owner' as const, id: 'context-owner' };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-context-delivery-'));
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-024 Delivery fixture.** Work is verified against exact evidence.\n');
  writeFileSync(join(root, 'spec', 'DRAFT.md'), '**H-030 Draft fixture.** Draft prose stays out of authoritative context.\n');
  const app = new App(join(root, 'state.sqlite'));
  const project = await app.call('project.register', { id: 'delivery', name: 'Delivery', root, purpose: 'context and delivery fixture', canonicalPaths: ['spec/PRD.md', 'spec/DRAFT.md'] }, owner);
  const draft = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const spec = (await app.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'Accept fixture', source: 'fixture' }, owner)).spec;
  const withheld = await app.call('spec.capture', { projectId: project.id, path: 'spec/DRAFT.md' }, owner);
  return { app, root, project, spec, withheld, close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function verifyingTask(app: App, project: any, spec: any, criteria: string[]) {
  let task = await app.call('task.create', { id: 'delivery-task', projectId: project.id, specId: spec.id, specHash: spec.hash, requirements: ['H-024'], objective: 'Deliver fixture', criteria, scope: 'fixture only', permissions: [], budget: {}, sourceCandidate: { id: 'a'.repeat(40) }, deadline: new Date(Date.now() + 60_000).toISOString() }, owner);
  task = (await app.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve fixture', source: 'fixture' }, owner)).task;
  const worker = { role: 'worker' as const, id: 'delivery-worker', taskId: task.id };
  const claim = await app.call('task.claim', { taskId: task.id, expectedRev: task.rev }, worker);
  const candidate = { id: 'delivery-candidate', specHash: spec.hash };
  task = (await app.call('task.workerResult', { taskId: task.id, runId: claim.run.id, expectedTaskRev: claim.task.rev, candidate, summary: 'done' }, worker)).task;
  return { task, worker, candidate };
}

test('context freshness re-reads the canonical file hash', async () => {
  const f = await fixture();
  try {
    const context = await f.app.call('context.build', { projectId: f.project.id, requirementIds: ['H-024'] }, owner);
    assert.equal((await f.app.call('context.freshness', { receiptId: context.receipt.id }, owner)).sourcesFresh, true);
    writeFileSync(join(f.root, 'spec', 'PRD.md'), '**H-024 Delivery fixture.** Edited on disk without a new capture.\n');
    const stale = await f.app.call('context.freshness', { receiptId: context.receipt.id }, owner);
    assert.equal(stale.fresh, false);
    assert.deepEqual(stale.changedSources.map((item: any) => item.reason), ['canonical file changed']);
    rmSync(join(f.root, 'spec', 'PRD.md'));
    assert.deepEqual((await f.app.call('context.freshness', { receiptId: context.receipt.id }, owner)).changedSources.map((item: any) => item.reason), ['canonical file unavailable']);
  } finally { await f.close(); }
});

test('context receipts include relevant outside observations and disclose withheld drafts', async () => {
  const f = await fixture();
  try {
    await f.app.call('outside.observe', { projectId: f.project.id, revision: 'outside-1', summary: 'Delivery changed outside Wimzo', behavior: 'changed', affectedRequirements: ['H-024'], evidence: [{ ref: 'commit:outside-1' }] }, owner);
    await f.app.call('outside.observe', { projectId: f.project.id, revision: 'outside-2', summary: 'Unrelated change', behavior: 'matching', affectedRequirements: ['H-099'] }, owner);
    const context = await f.app.call('context.build', { projectId: f.project.id, requirementIds: ['H-024'] }, owner);
    assert.deepEqual(context.observations.map((item: any) => [item.revision, item.behavior, item.evidence]), [['outside-1', 'changed', [{ ref: 'commit:outside-1' }]]]);
    assert.deepEqual(context.receipt.observations.map((item: any) => item.revision), ['outside-1']);
    assert.deepEqual(context.receipt.withheldDrafts, [{ specId: f.withheld.id, path: 'spec/DRAFT.md', specHash: f.withheld.hash, status: 'Draft', reason: 'Draft, not selected for authoritative context' }]);
    assert.doesNotMatch(JSON.stringify(context.rules), /Draft prose/);
  } finally { await f.close(); }
});

test('feature map links exact-candidate evidence and labels stale specification bindings', async () => {
  const f = await fixture();
  try {
    const { task, worker, candidate } = await verifyingTask(f.app, f.project, f.spec, ['unit tests', 'iPhone demo summary']);
    await f.app.call('evidence.record', { taskId: task.id, candidate, specHash: f.spec.hash, check: 'unit tests', environment: 'fixture', result: 'pass', artifacts: [{ path: 'logs/unit.txt', sha256: 'abc' }] }, worker);
    await f.app.call('evidence.record', { taskId: task.id, candidate, specHash: f.spec.hash, check: 'iPhone demo summary', environment: 'fixture', result: 'blocked' }, worker);
    const [row] = await f.app.call('feature.map', { projectId: f.project.id }, owner);
    assert.equal(row.verified, false);
    assert.equal(row.implemented, true);
    assert.deepEqual(row.tasks[0].evidence.map((item: any) => [item.check, item.result, item.candidateId]), [['unit tests', 'pass', 'delivery-candidate'], ['iPhone demo summary', 'blocked', 'delivery-candidate']]);
    assert.deepEqual(row.tasks[0].evidence[0].artifacts, [{ path: 'logs/unit.txt', hash: 'abc' }]);
    assert.equal(row.tasks[0].specificationFresh, true);
    writeFileSync(join(f.root, 'spec', 'PRD.md'), '**H-024 Delivery fixture.** A revised accepted requirement replaces the old binding.\n');
    const next = await f.app.call('spec.capture', { projectId: f.project.id, path: 'spec/PRD.md' }, owner);
    await f.app.call('spec.accept', { specId: next.id, hash: next.hash, expectedRev: next.rev, decision: 'Revise requirement', source: 'fixture' }, owner);
    const stale = (await f.app.call('feature.map', { projectId: f.project.id }, owner)).find((item: any) => item.requirement === 'H-024');
    assert.equal(stale.tasks[0].specificationFresh, false);
    assert.equal(stale.tasks[0].current, false);
    assert.equal(stale.intended, true);
    assert.equal(stale.implemented, false);
    assert.equal(stale.historical.implemented, true);
  } finally { await f.close(); }
});

test('context targets above the default need an exception reason and stop at 180K tokens', async () => {
  assert.throws(() => contextBudget({ targetTokens: 170_000 }), /exceptionReason/);
  assert.throws(() => contextBudget({ targetTokens: 190_000, exceptionReason: 'large migration' }), /180000|context/i);
  assert.throws(() => contextBudget({ targetTokens: 170_000, exceptionReason: ' ' }), /exceptionReason/);
  assert.deepEqual(contextBudget({ targetTokens: 170_000, exceptionReason: 'large migration' }), { targetTokens: 170_000, exceptionReason: 'large migration' });
  assert.equal(contextBudget(undefined), undefined);
  assert.throws(() => contextDecision(0, null, { targetTokens: 170_000 }), /exception reason/);
  const decision = contextDecision(0, null, { targetTokens: 170_000, exceptionReason: 'large migration' });
  assert.deepEqual({ limit: decision.limit, exceptionReason: decision.exceptionReason }, { limit: 180_000, exceptionReason: 'large migration' });
  assert.equal(piContextDecision(0, 400_000, { targetTokens: 170_000, exceptionReason: 'large migration' }).exceptionReason, 'large migration');
  const f = await fixture();
  try {
    const base = { projectId: f.project.id, specId: f.spec.id, specHash: f.spec.hash, requirements: ['H-024'], objective: 'Large context fixture', criteria: ['unit tests'], scope: 'fixture only', permissions: [] };
    await assert.rejects(f.app.call('task.create', { ...base, budget: { context: { targetTokens: 170_000 } } }, owner), /exceptionReason/);
    const task = await f.app.call('task.create', { ...base, budget: { context: { targetTokens: 170_000, exceptionReason: 'Cross-module migration needs the full schema in context' } } }, owner);
    const created = f.app.store.events().find((event: any) => event.type === 'task.created' && event.data.taskId === task.id);
    assert.deepEqual(created?.data.contextException, { reason: 'Cross-module migration needs the full schema in context', targetTokens: 170_000, exceptionMaxTokens: 180_000 });
  } finally { await f.close(); }
});
