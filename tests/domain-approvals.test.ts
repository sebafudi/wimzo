import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'approval-owner' };
const guide = { role: 'guide' as const, id: 'approval-guide' };

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-domain-approvals-'));
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), content);
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture requirements');
  const store = new Store(':memory:');
  const domain = Domain(store);
  const project = domain.call('project.register', { id: 'approval-project', name: 'Approval fixture', root, purpose: 'approval tests', canonicalPaths: ['spec/PRD.md'] }, owner);
  const draft = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  return { root, store, domain, project, draft, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function accept(context: ReturnType<typeof fixture>, spec = context.draft, requirementIds?: string[]) {
  return context.domain.call('spec.accept', {
    specId: spec.id, hash: spec.hash, expectedRev: spec.rev, ...(requirementIds === undefined ? {} : { requirementIds }),
    decision: 'Review exact fixture bytes', source: 'domain approvals test',
  }, owner);
}

test('owner can accept an ID-less document as a whole document without manufacturing requirements', () => {
  const context = fixture('# Working agreement\n\nThis document intentionally has no machine-readable requirement IDs.\n');
  try {
    const accepted = accept(context);
    assert.equal(accepted.spec.status, 'Accepted');
    assert.deepEqual(accepted.spec.requirementIds, []);
    assert.deepEqual(accepted.spec.acceptedRequirementIds, []);
    assert.deepEqual(accepted.approval.requirements, []);
    assert.equal(readFileSync(join(context.root, 'spec/PRD.md'), 'utf8'), '# Working agreement\n\nThis document intentionally has no machine-readable requirement IDs.\n');
    assert.throws(() => accept(context, accepted.spec, []), /No new requirement IDs/);
    assert.throws(() => context.domain.call('spec.accept', { specId: accepted.spec.id, hash: accepted.spec.hash, expectedRev: accepted.spec.rev, decision: 'guide cannot accept', source: 'test' }, guide), /may not call/);
  } finally { context.close(); }
});

test('a later ID-less whole document supersedes the earlier ID-less revision on the same canonical path', () => {
  const context = fixture('# Working agreement\n\nFirst complete ID-less document.\n');
  try {
    const first = accept(context).spec;
    writeFileSync(join(context.root, 'spec/PRD.md'), '# Working agreement\n\nSecond complete ID-less document.\n');
    const secondDraft = context.domain.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    const second = accept(context, secondDraft).spec;
    assert.equal(context.store.require<any>('spec', first.id).status, 'Superseded');
    assert.equal(second.status, 'Accepted');
    assert.equal(context.store.list<any>('approval').filter(value => value.kind === 'specification').length, 2);
  } finally { context.close(); }
});

test('an accepted subset can expand only on the same exact bytes and never self-supersedes or drops accepted IDs', () => {
  const context = fixture('**H-001 First rule.**\nFirst behavior.\n\n**H-002 Second rule.**\nSecond behavior.\n');
  try {
    const partial = accept(context, context.draft, ['H-001']);
    const firstApproval = partial.approval;
    assert.deepEqual(partial.spec.acceptedRequirementIds, ['H-001']);

    assert.throws(() => context.domain.call('spec.accept', {
      specId: partial.spec.id, hash: partial.spec.hash, expectedRev: partial.spec.rev - 1, requirementIds: ['H-001', 'H-002'], decision: 'stale expansion', source: 'test',
    }, owner), /Stale spec revision/);
    assert.throws(() => context.domain.call('spec.accept', {
      specId: partial.spec.id, hash: partial.spec.hash, expectedRev: partial.spec.rev, requirementIds: ['H-002'], decision: 'drop a previously accepted ID', source: 'test',
    }, owner), /may not be dropped/);

    const expanded = accept(context, partial.spec, ['H-001', 'H-002']);
    assert.deepEqual(expanded.spec.acceptedRequirementIds, ['H-001', 'H-002']);
    assert.equal(expanded.spec.status, 'Accepted');
    assert.deepEqual(expanded.approval.requirements, ['H-002']);
    assert.equal(context.store.require<any>('approval', firstApproval.id).requirements[0], 'H-001');
    assert.equal(context.store.require<any>('spec', expanded.spec.id).status, 'Accepted');
    assert.equal(context.store.list<any>('spec').filter(value => value.id === expanded.spec.id && value.status === 'Superseded').length, 0);
    assert.throws(() => accept(context, expanded.spec, ['H-001', 'H-002']), /No new requirement IDs/);
  } finally { context.close(); }
});

test('specification approval rejects changed canonical bytes even when its captured hash and revision are otherwise exact', () => {
  const context = fixture('**H-001 Exact rule.**\nOriginal behavior.\n');
  try {
    writeFileSync(join(context.root, 'spec/PRD.md'), '**H-001 Exact rule.**\nChanged after preparation.\n');
    assert.throws(() => accept(context), /changed after review/);
    assert.equal(context.store.require<any>('spec', context.draft.id).status, 'Draft');
    assert.equal(context.store.list<any>('approval').length, 0);
  } finally { context.close(); }
});

test('only an owner can repair a missing deadline on a Needs approval task, and approval remains bounded', () => {
  const context = fixture('**H-001 Task deadline.**\nA bounded task must have a deadline.\n');
  try {
    const spec = accept(context).spec;
    const task = context.domain.call('task.create', {
      projectId: context.project.id, specId: spec.id, specHash: spec.hash, requirements: ['H-001'], objective: 'Repair legacy deadline', criteria: ['approval succeeds only after repair'], scope: 'fixture only', permissions: [], budget: {}, sourceCandidate: { id: 'a'.repeat(40) },
    }, owner);
    assert.throws(() => context.domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'must remain blocked', source: 'test' }, owner), /deadline/);
    assert.throws(() => context.domain.call('task.setDeadline', { taskId: task.id, expectedRev: task.rev, deadline: new Date(Date.now() + 60_000).toISOString(), decision: 'guide cannot update scope bounds', source: 'test' }, guide), /may not call/);
    assert.throws(() => context.domain.call('task.setDeadline', { taskId: task.id, expectedRev: task.rev, deadline: 'yesterday', decision: 'invalid deadline', source: 'test' }, owner), /valid future/);
    assert.equal(context.store.require<any>('task', task.id).rev, task.rev);

    const deadline = new Date(Date.now() + 120_000).toISOString();
    assert.throws(() => context.domain.call('task.setDeadline', { taskId: task.id, expectedRev: task.rev - 1, deadline, decision: 'stale deadline repair', source: 'test' }, owner), /Stale task revision/);
    const repaired = context.domain.call('task.setDeadline', { taskId: task.id, expectedRev: task.rev, deadline, decision: 'Set a deadline before approving this existing scope', source: 'domain approvals test' }, owner);
    assert.equal(repaired.deadline, deadline);
    assert.equal(repaired.objective, task.objective);
    assert.deepEqual(repaired.criteria, task.criteria);
    assert.deepEqual(repaired.permissions, task.permissions);
    assert.ok(context.store.events().some(event => event.type === 'task.deadline.set' && event.data.taskId === task.id));
    assert.throws(() => context.domain.call('task.setDeadline', { taskId: task.id, expectedRev: repaired.rev, deadline: new Date(Date.now() + 240_000).toISOString(), decision: 'must not alter a valid deadline', source: 'test' }, owner), /already valid/);
    const approved = context.domain.call('task.approve', { taskId: repaired.id, expectedRev: repaired.rev, decision: 'Approve unchanged bounded work', source: 'domain approvals test' }, owner).task;
    assert.equal(approved.state, 'Approved');

    const expired = context.domain.call('task.create', {
      projectId: context.project.id, specId: spec.id, specHash: spec.hash, requirements: ['H-001'], objective: 'Repair expired legacy deadline', criteria: ['expired deadline is replaceable'], scope: 'fixture only', permissions: [], budget: {}, sourceCandidate: { id: 'b'.repeat(40) }, deadline: new Date(Date.now() - 60_000).toISOString(),
    }, owner);
    const renewed = context.domain.call('task.setDeadline', { taskId: expired.id, expectedRev: expired.rev, deadline: new Date(Date.now() + 180_000).toISOString(), decision: 'Renew expired task deadline without changing scope', source: 'domain approvals test' }, owner);
    assert.ok(Date.parse(renewed.deadline) > Date.now());
  } finally { context.close(); }
});
