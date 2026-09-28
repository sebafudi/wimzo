import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'fixture-owner' };

function pilot(acceptedRequirementIds?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-adversarial-'));
  mkdirSync(join(root, 'spec/features'), { recursive: true });
  writeFileSync(join(root, 'spec/features/native-archive-preview.md'), 'Native archive preview is limited to DS-007 and DS-013. This feature source deliberately has no requirement headings.');
  const store = new Store(':memory:'); const domain = Domain(store);
  const project = domain.call('project.register', { id: 'daystride', name: 'Daystride', root, purpose: 'fixture', canonicalPaths: ['spec/features/native-archive-preview.md'] }, owner);
  const draft = domain.call('spec.capture', { projectId: project.id, path: 'spec/features/native-archive-preview.md' }, owner);
  const spec = domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, requirementIds: acceptedRequirementIds, decision: 'Fixture pilot review', source: 'isolated fixture' }, owner).spec;
  return { root, store, domain, project, spec, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('accepted feature prose remains available as exact context when no rule heading exists', () => {
  const ctx = pilot();
  try {
    const planned = ctx.domain.call('feature.map', { projectId: ctx.project.id }, owner);
    assert.deepEqual(planned.map((entry: any) => entry.requirement), ['DS-007', 'DS-013']);
    assert.ok(planned.every((entry: any) => entry.intended && !entry.implemented && !entry.verified && !entry.accepted && !entry.released && entry.tasks.length === 0));
    const task = ctx.domain.call('task.create', { projectId: ctx.project.id, specId: ctx.spec.id, specHash: ctx.spec.hash, requirements: ['DS-007', 'DS-013'], objective: 'pilot', criteria: ['fixture'], scope: 'pilot', permissions: [], budget: {}, sourceCandidate: { id: 'a'.repeat(40) }, deadline: new Date(Date.now() + 60_000).toISOString() }, owner);
    const brief = ctx.domain.call('context.build', { projectId: ctx.project.id, taskId: task.id }, owner);
    assert.deepEqual(brief.rules.map((rule: any) => rule.requirementId), ['DS-007', 'DS-013']);
    assert.ok(brief.rules.every((rule: any) => rule.content.includes('Native archive preview')));
    assert.equal(brief.receipt.fallbackSources.length, 2);
    assert.deepEqual(brief.receipt.omitted, []);
    assert.ok(brief.rules.every((rule: any) => rule.sourceStatus === 'Accepted'));
  } finally { ctx.close(); }
});

test('partial specification acceptance does not authorize an unaccepted feature requirement', () => {
  const ctx = pilot(['DS-007']);
  try {
    assert.deepEqual(ctx.spec.acceptedRequirementIds, ['DS-007']);
    assert.throws(() => ctx.domain.call('task.create', { projectId: ctx.project.id, specId: ctx.spec.id, specHash: ctx.spec.hash, requirements: ['DS-013'], objective: 'outside approved scope', criteria: ['fixture'], scope: 'pilot', permissions: [], budget: {}, sourceCandidate: { id: 'a'.repeat(40) }, deadline: new Date(Date.now() + 60_000).toISOString() }, owner), /must be accepted/);
    assert.deepEqual(ctx.domain.call('feature.map', { projectId: ctx.project.id }, owner).map((entry: any) => entry.requirement), ['DS-007']);
    const brief = ctx.domain.call('context.build', { projectId: ctx.project.id, requirementIds: ['DS-007'] }, owner);
    assert.equal(brief.rules[0].sourceStatus, 'Accepted subset');
    const descriptor = ctx.domain.actions().find((action: any) => action.name === 'project.update');
    assert.ok(descriptor);
    assert.equal(descriptor.inputSchema.properties.expectedRev.type, 'integer');
    assert.equal(descriptor.inputSchema.properties.canonicalPaths.type, 'array');
    const triage = ctx.domain.actions().find((action: any) => action.name === 'triage.classify');
    const release = ctx.domain.actions().find((action: any) => action.name === 'release.record');
    const claim = ctx.domain.actions().find((action: any) => action.name === 'task.claim');
    assert.ok(triage && release && claim);
    assert.equal(triage.inputSchema.properties.evidence.type, 'array');
    assert.equal(release.inputSchema.properties.evidence.type, 'object');
    assert.equal(claim.inputSchema.properties.worktree.oneOf[1].type, 'boolean');
  } finally { ctx.close(); }
});

test('role and revision fences prevent a worker from creating approval or claiming twice', () => {
  const ctx = pilot();
  try {
    let task = ctx.domain.call('task.create', { projectId: ctx.project.id, specId: ctx.spec.id, specHash: ctx.spec.hash, requirements: ['DS-007'], objective: 'pilot', criteria: ['fixture'], scope: 'pilot', permissions: [], budget: {}, sourceCandidate: { id: 'a'.repeat(40) }, deadline: new Date(Date.now() + 60_000).toISOString() }, owner);
    assert.throws(() => ctx.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'spoof', source: 'fixture' }, { role: 'guide', id: 'guide' }), /may not call/);
    task = ctx.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'approve', source: 'fixture' }, owner).task;
    const worker = { role: 'worker' as const, id: 'worker', taskId: task.id };
    const claim = ctx.domain.call('task.claim', { taskId: task.id, expectedRev: task.rev, workerId: worker.id }, worker);
    assert.equal(claim.claimed, true);
    assert.throws(() => ctx.domain.call('task.claim', { taskId: task.id, expectedRev: task.rev, workerId: worker.id }, worker), /Stale task revision/);
    assert.throws(() => ctx.domain.call('task.review', { taskId: task.id, expectedRev: claim.task.rev, candidate: { id: 'x', specHash: ctx.spec.hash }, decision: 'accept', source: 'spoof' }, worker), /may not call/);
  } finally { ctx.close(); }
});
