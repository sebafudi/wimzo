import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'owner-fixture' };
const system = { role: 'system' as const, id: 'scheduler-fixture' };

function fixture(content = '**H-001 First rule**\nIncludes **H-002 Second rule**.\n\n**H-002 Second rule**\nAn exception applies.') {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-domain-'));
  mkdirSync(join(root, 'spec')); writeFileSync(join(root, 'spec/PRD.md'), content);
  const store = new Store(':memory:'); const domain = Domain(store);
  const project = domain.call('project.register', { id: 'project_fixture', name: 'Fixture', root, purpose: 'test', canonicalPaths: ['spec/PRD.md'] }, owner);
  const draft = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted = domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'Fixture accepts reviewed specification', source: 'fixture review' }, owner).spec;
  const close = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, domain, project, spec: accepted, close };
}

function createTask(ctx: ReturnType<typeof fixture>, suffix = 'one', extraResources: string[] = []) {
  return ctx.domain.call('task.create', {
    projectId: ctx.project.id, specId: ctx.spec.id, specHash: ctx.spec.hash, requirements: ['H-001'],
    objective: `Implement ${suffix}`, criteria: ['check passes'], scope: suffix, permissions: ['workspace'], budget: { turns: 1 }, resources: [`worktree:${suffix}`, ...extraResources], priority: 1, runtime: suffix === 'script' ? 'script' : undefined,
    sourceCandidate: { id: 'a'.repeat(40) }, deadline: new Date(Date.now() + 60_000).toISOString()
  }, owner);
}

test('spec acceptance records the exact snapshot and does not alter its canonical file', () => {
  const ctx = fixture();
  try {
    const content = '**H-001 Changed rule**\nNew behavior.';
    writeFileSync(join(ctx.root, 'spec/PRD.md'), content);
    const candidate = ctx.domain.call('spec.capture', { projectId: ctx.project.id, path: 'spec/PRD.md' }, owner);
    strict.equal(candidate.status, 'Draft');
    strict.throws(() => ctx.domain.call('spec.accept', { specId: candidate.id, hash: candidate.hash, expectedRev: candidate.rev - 1, decision: 'stale', source: 'fixture' }, owner), /Stale spec revision/);
    const accepted = ctx.domain.call('spec.accept', { specId: candidate.id, hash: candidate.hash, expectedRev: candidate.rev, decision: 'Accept changed fixture rule', source: 'fixture review' }, owner);
    strict.equal(accepted.spec.status, 'Accepted');
    const prior = ctx.domain.call('spec.list', { projectId: ctx.project.id }, owner).find((s: any) => s.id === ctx.spec.id);
    strict.equal(prior.status, 'Accepted'); strict.deepEqual(prior.acceptedRequirementIds, ['H-002']);
    strict.equal(readFileSync(join(ctx.root, 'spec/PRD.md'), 'utf8'), content);
    strict.ok(ctx.store.events().some(e => e.type === 'spec.accepted' && e.data.hash === candidate.hash));
  } finally { ctx.close(); }
});

test('task lifecycle requires exact evidence and only owner review accepts', () => {
  const ctx = fixture();
  try {
    let task = createTask(ctx); task = ctx.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve fixture work', source: 'fixture review' }, owner).task;
    const claim = ctx.domain.call('task.claim', { taskId: task.id, expectedRev: task.rev, workerId: 'worker-1', runtime: 'fixture' }, system);
    const worker = { role: 'worker' as const, id: 'worker-1', taskId: task.id };
    const candidate = { id: 'candidate-1', specHash: ctx.spec.hash, hash: 'abc' };
    task = ctx.domain.call('task.workerResult', { taskId: task.id, runId: claim.run.id, expectedTaskRev: claim.task.rev, candidate, summary: 'done' }, worker).task;
    strict.equal(task.state, 'Verifying');
    const verificationInbox = ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'pending' }, owner).find((item: any) => item.kind === 'verification needed');
    strict.throws(() => ctx.domain.call('task.verify', { taskId: task.id, expectedRev: task.rev, candidate, specHash: ctx.spec.hash }, worker), /evidence/);
    const evidence = ctx.domain.call('evidence.record', { taskId: task.id, candidate, specHash: ctx.spec.hash, check: 'check passes', environment: 'fixture', result: 'pass', command: 'npm test', notes: 'Fresh fixture result', artifacts: [{ path: 'logs/test.txt', sha256: 'abc123' }], details: { exitCode: 0 } }, worker);
    strict.deepEqual(evidence.artifacts, [{ path: 'logs/test.txt', sha256: 'abc123' }]); strict.equal(evidence.command, 'npm test'); strict.deepEqual(evidence.details, { exitCode: 0 });
    task = ctx.domain.call('task.verify', { taskId: task.id, expectedRev: task.rev, candidate, specHash: ctx.spec.hash }, worker);
    strict.equal(task.state, 'Needs result review');
    strict.equal(ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'resolved' }, owner).some((item: any) => item.id === verificationInbox.id && item.resolution === 'verification completed'), true);
    const reviewInbox = ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'pending' }, owner).find((item: any) => item.kind === 'result review');
    strict.throws(() => ctx.domain.call('task.review', { taskId: task.id, expectedRev: task.rev, candidate, decision: 'accept' }, worker), /may not call/);
    const reviewed = ctx.domain.call('task.review', { taskId: task.id, expectedRev: task.rev, candidate, decision: 'accept', source: 'fixture result review' }, owner).task;
    strict.equal(reviewed.state, 'Accepted');
    strict.equal(ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'resolved' }, owner).some((item: any) => item.id === reviewInbox.id && item.resolution === 'result accept'), true);
    const release = ctx.domain.call('release.decide', { taskId: reviewed.id, candidate, decision: 'approve', version: 'v0', source: 'fixture release review' }, owner);
    strict.equal(release.decision, 'approve');
  } finally { ctx.close(); }
});

test('claimed verification holds capacity and resources until exact evidence completes it', () => {
  const ctx = fixture();
  try {
    let first = createTask(ctx, 'first'); let second = createTask(ctx, 'second'); let third = createTask(ctx, 'third', ['review-console']);
    first = ctx.domain.call('task.approve', { taskId: first.id, expectedRev: first.rev, decision: 'Approve first', source: 'fixture' }, owner).task;
    second = ctx.domain.call('task.approve', { taskId: second.id, expectedRev: second.rev, decision: 'Approve second', source: 'fixture' }, owner).task;
    third = ctx.domain.call('task.approve', { taskId: third.id, expectedRev: third.rev, decision: 'Approve third', source: 'fixture' }, owner).task;
    const implementation = ctx.domain.call('task.claim', { taskId: first.id, expectedRev: first.rev, workerId: 'implementer', runType: 'technical' }, system);
    const implementer = { role: 'worker' as const, id: 'implementer', taskId: first.id }; const candidate = { id: 'candidate-review', specHash: ctx.spec.hash };
    first = ctx.domain.call('task.workerResult', { taskId: first.id, runId: implementation.run.id, expectedTaskRev: implementation.task.rev, candidate, summary: 'ready for review' }, implementer).task;
    const review = ctx.domain.call('task.claimVerification', { taskId: first.id, expectedRev: first.rev, workerId: 'reviewer', runType: 'technical', resources: ['review-console'] }, system);
    const secondRun = ctx.domain.call('task.claim', { taskId: second.id, expectedRev: second.rev, workerId: 'second', runType: 'technical' }, system);
    const blocked = ctx.domain.call('task.claim', { taskId: third.id, expectedRev: third.rev, workerId: 'third', runType: 'technical', resources: ['review-console'] }, system);
    strict.equal(blocked.claimed, false); strict.match(blocked.reasons.join(' '), /technical worker capacity/); strict.match(blocked.reasons.join(' '), /review-console/);
    const reviewer = { role: 'worker' as const, id: 'reviewer', taskId: first.id };
    ctx.domain.call('evidence.record', { taskId: first.id, candidate, specHash: ctx.spec.hash, check: 'check passes', environment: 'fixture', result: 'pass' }, reviewer);
    const verified = ctx.domain.call('task.verify', { taskId: first.id, expectedRev: review.task.rev, candidate, specHash: ctx.spec.hash }, reviewer);
    strict.equal(verified.state, 'Needs result review'); strict.equal(ctx.store.require<any>('run', review.run.id).state, 'Completed');
    const released = ctx.domain.call('task.claim', { taskId: third.id, expectedRev: blocked.task.rev, workerId: 'third', runType: 'technical', resources: ['review-console'] }, system);
    strict.equal(released.claimed, true); strict.equal(secondRun.run.state, 'Running');
  } finally { ctx.close(); }
});

test('verification run pause resume and cancel acknowledge the run state', () => {
  const ctx = fixture();
  try {
    let value = createTask(ctx, 'controls'); value = ctx.domain.call('task.approve', { taskId: value.id, expectedRev: value.rev, decision: 'Approve controls', source: 'fixture' }, owner).task;
    const implementation = ctx.domain.call('task.claim', { taskId: value.id, expectedRev: value.rev, workerId: 'implementer' }, system);
    const candidate = { id: 'candidate-controls', specHash: ctx.spec.hash };
    value = ctx.domain.call('task.workerResult', { taskId: value.id, runId: implementation.run.id, expectedTaskRev: implementation.task.rev, candidate, summary: 'verify controls' }, { role: 'worker', id: 'implementer', taskId: value.id }).task;
    const review = ctx.domain.call('task.claimVerification', { taskId: value.id, expectedRev: value.rev, workerId: 'reviewer', runType: 'gui' }, system);
    const pausedRequest = ctx.domain.call('task.control', { taskId: value.id, expectedRev: review.task.rev, command: 'pause' }, owner);
    const paused = ctx.domain.call('task.ack', { taskId: value.id, expectedRev: pausedRequest.rev, command: 'pause' }, system);
    strict.equal(paused.state, 'Paused'); strict.equal(ctx.store.require<any>('run', review.run.id).state, 'Paused');
    const resumeRequest = ctx.domain.call('task.control', { taskId: value.id, expectedRev: paused.rev, command: 'resume' }, owner);
    const resumed = ctx.domain.call('task.ack', { taskId: value.id, expectedRev: resumeRequest.rev, command: 'resume' }, system);
    strict.equal(resumed.state, 'Verifying'); strict.equal(ctx.store.require<any>('run', review.run.id).state, 'Paused');
    const fresh = ctx.domain.call('task.claimVerification', { taskId: value.id, expectedRev: resumed.rev, workerId: 'reviewer', runType: 'gui' }, system);
    strict.notEqual(fresh.run.id, review.run.id); strict.equal(fresh.run.state, 'Running');
    const cancelRequest = ctx.domain.call('task.control', { taskId: value.id, expectedRev: fresh.task.rev, command: 'cancel' }, owner);
    const canceled = ctx.domain.call('task.ack', { taskId: value.id, expectedRev: cancelRequest.rev, command: 'cancel' }, system);
    strict.equal(canceled.state, 'Canceled'); strict.equal(ctx.store.require<any>('run', fresh.run.id).state, 'Canceled'); strict.equal(ctx.store.require<any>('run', review.run.id).state, 'Paused');
  } finally { ctx.close(); }
});

test('control acknowledgement resolves only its matching control inbox entry', () => {
  const ctx = fixture();
  try {
    let task = createTask(ctx); task = ctx.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve fixture work', source: 'fixture review' }, owner).task;
    const unrelated = ctx.domain.call('inbox.create', { projectId: ctx.project.id, kind: 'decision', summary: 'Keep this pending' }, owner);
    const requested = ctx.domain.call('task.control', { taskId: task.id, expectedRev: task.rev, command: 'pause' }, owner);
    const controlInbox = ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'pending' }, owner).find((item: any) => item.kind === 'control requested');
    const paused = ctx.domain.call('task.ack', { taskId: task.id, expectedRev: requested.rev, command: 'pause' }, system);
    strict.equal(paused.state, 'Paused');
    const resolved = ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'resolved' }, owner).find((item: any) => item.id === controlInbox.id);
    strict.equal(resolved.resolution, 'control pause acknowledged');
    strict.throws(() => ctx.domain.call('inbox.deliver', { inboxId: resolved.id, expectedRev: resolved.rev, status: 'pending' }, owner), /cannot be reopened/);
    strict.equal(ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'pending' }, owner).some((item: any) => item.id === unrelated.id), true);
  } finally { ctx.close(); }
});

test('task creation requires accepted requirements and named criteria', () => {
  const ctx = fixture();
  try {
    const common = { projectId: ctx.project.id, specId: ctx.spec.id, specHash: ctx.spec.hash, objective: 'Implement', scope: 'fixture', permissions: [], budget: {} };
    strict.throws(() => ctx.domain.call('task.create', { ...common, requirements: [], criteria: ['check'] }, owner), /at least one accepted requirement/);
    strict.throws(() => ctx.domain.call('task.create', { ...common, requirements: ['H-404'], criteria: ['check'] }, owner), /must be accepted/);
    strict.throws(() => ctx.domain.call('task.create', { ...common, requirements: ['H-001'], criteria: [] }, owner), /at least one acceptance criterion/);
  } finally { ctx.close(); }
});

test('owner can append canonical paths but cannot silently replace captured identity', () => {
  const ctx = fixture();
  try {
    writeFileSync(join(ctx.root, 'spec/feature.md'), '## H-003 Added feature\n');
    const current = ctx.domain.call('project.get', { projectId: ctx.project.id }, owner);
    const updated = ctx.domain.call('project.update', { projectId: ctx.project.id, expectedRev: current.rev, canonicalPaths: ['spec/PRD.md', 'spec/feature.md'], purpose: 'expanded fixture' }, owner);
    strict.deepEqual(updated.canonicalPaths, ['spec/PRD.md', 'spec/feature.md']); strict.equal(updated.purpose, 'expanded fixture');
    strict.throws(() => ctx.domain.call('project.update', { projectId: updated.id, expectedRev: updated.rev, canonicalPaths: ['spec/feature.md'] }, owner), /only be appended/);
  } finally { ctx.close(); }
});

test('partial replacement preserves unrelated accepted requirements from the earlier snapshot', () => {
  const ctx = fixture();
  try {
    writeFileSync(join(ctx.root, 'spec/PRD.md'), '**H-001 Replacement rule**\nChanged behavior.\n\n**H-002 Second rule**\nStill accepted.');
    const replacement = ctx.domain.call('spec.capture', { projectId: ctx.project.id, path: 'spec/PRD.md' }, owner);
    const accepted = ctx.domain.call('spec.accept', { specId: replacement.id, hash: replacement.hash, expectedRev: replacement.rev, requirementIds: ['H-001'], decision: 'Accept only the changed rule', source: 'fixture review' }, owner).spec;
    const prior = ctx.domain.call('spec.list', { projectId: ctx.project.id }, owner).find((entry: any) => entry.id === ctx.spec.id);
    strict.equal(prior.status, 'Accepted'); strict.deepEqual(prior.acceptedRequirementIds, ['H-002']);
    const common = { projectId: ctx.project.id, specHash: accepted.hash, objective: 'partial', criteria: ['check'], scope: 'fixture', permissions: [], budget: {} };
    strict.throws(() => ctx.domain.call('task.create', { ...common, specId: accepted.id, requirements: ['H-002'] }, owner), /must be accepted/);
    const retained = ctx.domain.call('task.create', { ...common, specId: prior.id, specHash: prior.hash, requirements: ['H-002'] }, owner);
    strict.deepEqual(retained.requirements, ['H-002']);
  } finally { ctx.close(); }
});

test('claims are atomic, limited, and scripts do not consume technical slots', () => {
  const ctx = fixture();
  try {
    const tasks = ['a', 'b', 'c', 'script'].map(name => createTask(ctx, name));
    const approved = tasks.map(value => ctx.domain.call('task.approve', { taskId: value.id, expectedRev: value.rev, decision: 'Approve fixture work', source: 'fixture review' }, owner).task);
    const a = ctx.domain.call('task.claim', { taskId: approved[0].id, expectedRev: approved[0].rev, workerId: 'a' }, system);
    const b = ctx.domain.call('task.claim', { taskId: approved[1].id, expectedRev: approved[1].rev, workerId: 'b' }, system);
    strict.equal(a.claimed && b.claimed, true);
    const blocked = ctx.domain.call('task.claim', { taskId: approved[2].id, expectedRev: approved[2].rev, workerId: 'c' }, system);
    strict.equal(blocked.claimed, false); strict.match(blocked.reasons.join(' '), /capacity/);
    const script = ctx.domain.call('task.claim', { taskId: approved[3].id, expectedRev: approved[3].rev, workerId: 'script', runType: 'script' }, system);
    strict.equal(script.claimed, true);
    strict.throws(() => ctx.domain.call('task.claim', { taskId: approved[2].id, expectedRev: approved[2].rev, workerId: 'c' }, system), /Stale task revision/);
  } finally { ctx.close(); }
});

test('stale specifications and role boundaries block worker writes', () => {
  const ctx = fixture();
  try {
    let task = createTask(ctx); task = ctx.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve fixture work', source: 'fixture review' }, owner).task;
    const claim = ctx.domain.call('task.claim', { taskId: task.id, expectedRev: task.rev, workerId: 'one' }, system);
    const worker = { role: 'worker' as const, id: 'one', taskId: task.id };
    strict.throws(() => ctx.domain.call('task.create', { projectId: ctx.project.id }, worker), /may not call/);
    writeFileSync(join(ctx.root, 'spec/PRD.md'), '**H-001 Replacement**\nChanged.');
    const draft = ctx.domain.call('spec.capture', { projectId: ctx.project.id, path: 'spec/PRD.md' }, owner);
    ctx.domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'Accept replacement', source: 'fixture review' }, owner);
    strict.throws(() => ctx.domain.call('task.workerResult', { taskId: task.id, runId: claim.run.id, expectedTaskRev: claim.task.rev, candidate: { id: 'old', specHash: ctx.spec.hash }, summary: 'old' }, worker), /stale/);
  } finally { ctx.close(); }
});

test('context receipts include linked accepted rules, isolate projects, and inbox delivery persists', () => {
  const ctx = fixture();
  try {
    const brief = ctx.domain.call('context.build', { projectId: ctx.project.id, requirementIds: ['H-001'] }, owner);
    strict.deepEqual(brief.rules.map((r: any) => r.requirementId), ['H-001', 'H-002']);
    strict.equal(brief.receipt.sources.length, 2); strict.equal(typeof brief.receipt.stateWatermark, 'number');
    const inbox = ctx.domain.call('inbox.create', { projectId: ctx.project.id, kind: 'decision', summary: 'Choose a behavior' }, owner);
    const delivered = ctx.domain.call('inbox.deliver', { inboxId: inbox.id, expectedRev: inbox.rev }, owner);
    strict.equal(delivered.status, 'delivered');
    strict.equal(ctx.domain.call('inbox.list', { projectId: ctx.project.id, status: 'pending' }, owner).some((i: any) => i.id === inbox.id), false);
    strict.throws(() => ctx.domain.call('spec.capture', { projectId: ctx.project.id, path: '../outside.md' }, owner), /Canonical path/);
  } finally { ctx.close(); }
});

test('outside observations deduplicate revisions and create review work without changing a specification', () => {
  const ctx = fixture();
  try {
    const first = ctx.domain.call('outside.observe', { projectId: ctx.project.id, revision: 'abc123', summary: 'New observable behavior', behavior: 'changed', affectedRequirements: ['H-001'] }, system);
    const duplicate = ctx.domain.call('outside.observe', { projectId: ctx.project.id, revision: 'abc123', summary: 'repeat', behavior: 'changed' }, system);
    strict.equal(first.duplicate, false); strict.equal(duplicate.duplicate, true);
    strict.equal(ctx.domain.call('triage.list', { projectId: ctx.project.id }, owner)[0].classification, 'change request');
    strict.equal(ctx.domain.call('spec.list', { projectId: ctx.project.id }, owner).find((s: any) => s.id === ctx.spec.id).status, 'Accepted');
  } finally { ctx.close(); }
});

test('DS requirement headings are captured and an edited canonical file cannot be accepted from an old review', () => {
  const ctx = fixture('## DS-007 Native archive\nNeeds **DS-013** support.\n\n## DS-013 Pilot exception\nApplies to the pilot.');
  try {
    writeFileSync(join(ctx.root, 'spec/PRD.md'), '## DS-007 Native archive revised\nNeeds **DS-013** support.\n\n## DS-013 Pilot exception\nApplies to the pilot.');
    const draft = ctx.domain.call('spec.capture', { projectId: ctx.project.id, path: 'spec/PRD.md' }, owner);
    strict.deepEqual(draft.requirementIds, ['DS-007', 'DS-013']);
    writeFileSync(join(ctx.root, 'spec/PRD.md'), '## DS-007 Changed after review');
    strict.throws(() => ctx.domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'accept old snapshot', source: 'fixture review' }, owner), /changed after review/);
    const brief = ctx.domain.call('context.build', { projectId: ctx.project.id, requirementIds: ['DS-007'] }, owner);
    strict.equal(brief.rules[0].requirementId, 'DS-007');
    strict.equal(brief.rules[0].specHash, ctx.spec.hash);
  } finally { ctx.close(); }
});

test('candidate equality includes all fields and release authorization is separate from observed release', () => {
  const ctx = fixture();
  try {
    let value = createTask(ctx); value = ctx.domain.call('task.approve', { taskId: value.id, expectedRev: value.rev, decision: 'Approve', source: 'fixture' }, owner).task;
    const claim = ctx.domain.call('task.claim', { taskId: value.id, expectedRev: value.rev, workerId: 'worker' }, system);
    const worker = { role: 'worker' as const, id: 'worker', taskId: value.id }; const candidate = { id: 'candidate', specHash: ctx.spec.hash, commit: 'one' };
    value = ctx.domain.call('task.workerResult', { taskId: value.id, runId: claim.run.id, expectedTaskRev: claim.task.rev, candidate, summary: 'done' }, worker).task;
    strict.throws(() => ctx.domain.call('evidence.record', { taskId: value.id, candidate: { ...candidate, commit: 'two' }, specHash: ctx.spec.hash, check: 'check passes', environment: 'fixture', result: 'pass' }, worker), /does not match/);
    ctx.domain.call('evidence.record', { taskId: value.id, candidate, specHash: ctx.spec.hash, check: 'check passes', environment: 'fixture', result: 'pass' }, worker);
    value = ctx.domain.call('task.verify', { taskId: value.id, expectedRev: value.rev, candidate, specHash: ctx.spec.hash }, worker);
    value = ctx.domain.call('task.review', { taskId: value.id, expectedRev: value.rev, candidate, decision: 'accept', source: 'fixture' }, owner).task;
    ctx.domain.call('release.decide', { taskId: value.id, candidate, decision: 'approve', source: 'fixture' }, owner);
    strict.equal(ctx.domain.call('task.get', { taskId: value.id }, owner).dimensions.released, false);
    ctx.domain.call('release.decide', { taskId: value.id, candidate, decision: 'reject', source: 'newer fixture decision' }, owner);
    strict.throws(() => ctx.domain.call('release.record', { taskId: value.id, candidate, operation: 'deployed', evidence: { check: 'fixture deploy' }, version: 'v1' }, system), /not been authorized/);
    ctx.domain.call('release.decide', { taskId: value.id, candidate, decision: 'approve', source: 'newer fixture approval' }, owner);
    const merged = ctx.domain.call('release.record', { taskId: value.id, candidate, operation: 'merged', evidence: { check: 'fixture merge' }, version: 'v1' }, system);
    const observed = ctx.domain.call('release.record', { taskId: value.id, candidate, operation: 'deployed', evidence: { check: 'fixture deploy' }, version: 'v1' }, system);
    strict.equal(observed.task.dimensions.released, true);
    const observations = ctx.domain.call('release.observations', { projectId: ctx.project.id }, owner);
    strict.deepEqual(observations.map((record: any) => record.operation), ['merged', 'deployed']); strict.equal(observations[1].version, 'v1');
    strict.equal(ctx.domain.call('release.observations', { projectId: ctx.project.id }, worker).length, 2);
    const feature = ctx.domain.call('feature.map', { projectId: ctx.project.id }, owner).find((entry: any) => entry.requirement === 'H-001');
    strict.deepEqual(feature.releases.map((record: any) => record.id), [merged.record.id, observed.record.id]); strict.equal(feature.deployedVersion, 'v1'); strict.equal(feature.activatedVersion, undefined);
    const foreign = ctx.domain.call('project.register', { id: 'foreign_release_fixture', name: 'Foreign', root: ctx.root, purpose: 'foreign', canonicalPaths: ['spec/PRD.md'] }, owner);
    strict.throws(() => ctx.domain.call('release.list', { projectId: foreign.id }, worker), /Worker may access only its project/);
  } finally { ctx.close(); }
});
