import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';
import { Workflow } from '../src/workflow.ts';

const owner = { role: 'owner' as const, id: 'workflow-regression-owner' };
const profile = { id: 'codex:gpt-6-astra:high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', label: 'Codex Astra', source: 'local-metadata', verified: true };

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-workflow-regression-'));
  const root = join(temp, 'project'); mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), '# Fixture\n\n**H-001 Fixture behavior.** The accepted behavior.\n');
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture base');
  const store = new Store(':memory:'); const domain = Domain(store);
  const project = domain.call('project.register', { id: 'workflow-regression-project', name: 'Workflow regression fixture', root, purpose: 'workflow regression tests', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, requirementIds: captured.requirementIds, decision: 'Accept fixture', source: 'workflow regression test' }, owner).spec;
  const workflow = Workflow(store, domain, { async validateProfile(value: any) { assert.equal(value.id, profile.id); return structuredClone(profile); } });
  const sourceCandidate = { commit: git(root, 'rev-parse', 'HEAD') };
  const config = { projectId: project.id, enabled: true, baselineSpecId: accepted.id, defaultProfile: profile, sourceCandidate, maxRunMs: 120_000, worktree: true, preparationBudget: { maxExecutionMs: 30_000 }, planningBudget: { maxExecutionMs: 30_000 }, implementationBudget: { maxExecutionMs: 100_000 }, context: { targetTokens: 150000, checkpointTokens: 120000, reserveTokens: 30000, maxTokens: 180000 }, decision: 'Enable regression workflow', source: 'workflow regression test' };
  return { temp, store, domain, project, accepted, workflow, sourceCandidate, config, close: () => { store.close(); rmSync(temp, { recursive: true, force: true }); } };
}

async function reachVerification(context: ReturnType<typeof fixture>) {
  context.store.put('idea', { id: 'linked-idea', projectId: context.project.id, title: 'Linked feature', description: 'Implement the accepted behavior.', future: false, links: [{ specId: context.accepted.id }], createdBy: owner, createdAt: new Date().toISOString() });
  await context.workflow.call('workflow.configure', context.config, owner); context.workflow.tick({ projectId: context.project.id });
  const feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0];
  const approved = await context.workflow.call('workflow.approve', { featureId: feature.id, specId: context.accepted.id, specHash: context.accepted.hash, specRev: context.accepted.rev, profile, directImplementation: true, objective: 'Implement fixture behavior', scope: 'Change only the fixture behavior.', criteria: ['Fixture behavior passes'], permissions: ['workspace-write'], decision: 'Approve direct fixture work', source: 'workflow regression test', submissionId: 'approve-direct' }, owner);
  const implementer = { role: 'worker' as const, id: 'regression-implementer', taskId: approved.task.id };
  const running = context.domain.call('task.claim', { taskId: approved.task.id, expectedRev: approved.task.rev, workerId: implementer.id }, implementer).task;
  const target = context.domain.call('task.workerResult', { taskId: running.id, runId: running.runId, expectedTaskRev: running.rev, candidate: { id: context.sourceCandidate.commit, specHash: running.specHash, materializedCommit: context.sourceCandidate.commit }, summary: 'Fixture implementation candidate', checks: [], artifacts: [], unresolved: [] }, implementer).task;
  context.workflow.tick({ projectId: context.project.id });
  const currentFeature = context.store.require<any>('workflow_feature', feature.id); const verificationTaskId = currentFeature.verificationByTarget[target.id];
  const verifier = { role: 'worker' as const, id: 'regression-verifier', taskId: verificationTaskId };
  const verification = context.domain.call('task.claim', { taskId: verificationTaskId, expectedRev: context.store.require<any>('task', verificationTaskId).rev, workerId: verifier.id }, verifier).task;
  return { feature: currentFeature, target, verifier, verification };
}

test('a failed exact verification remains Blocked after the verifier finishes and workflow ticks again', async () => {
  const context = fixture();
  try {
    const { feature, target, verifier, verification } = await reachVerification(context);
    const failed = await context.workflow.call('workflow.submitVerification', { featureId: feature.id, taskId: verification.id, expectedTaskRev: verification.rev, targetTaskId: target.id, candidate: target.candidate, checks: target.criteria.map((check: string) => ({ check, result: 'fail', details: { reason: 'fixture failure' } })), summary: 'The exact candidate failed verification.', submissionId: 'failed-verification' }, verifier);
    assert.equal(failed.feature.phase, 'blocked');
    context.domain.call('task.workerResult', { taskId: verification.id, runId: verification.runId, expectedTaskRev: verification.rev, candidate: { id: context.sourceCandidate.commit, specHash: verification.specHash }, summary: 'Verifier recorded the failed result.', checks: [], artifacts: [], unresolved: [] }, verifier);
    context.workflow.tick({ projectId: context.project.id });
    const projected = context.store.require<any>('workflow_feature', feature.id);
    assert.equal(projected.phase, 'blocked');
    assert.equal(projected.verificationFailure.targetTaskId, target.id);
  } finally { context.close(); }
});

test('aggregate rejection gates child review and exact owner rework preserves every bound', async () => {
  const context = fixture();
  try {
    const { feature, target, verifier, verification } = await reachVerification(context);
    const verified = await context.workflow.call('workflow.submitVerification', {
      featureId: feature.id,
      taskId: verification.id,
      expectedTaskRev: verification.rev,
      targetTaskId: target.id,
      candidate: target.candidate,
      checks: target.criteria.map((check: string) => ({ check, result: 'pass', details: {} })),
      summary: 'The exact candidate passed every approved criterion.',
      submissionId: 'passed-verification',
    }, verifier);
    const child = verified.target;

    assert.equal(child.state, 'Needs result review');
    assert.throws(() => context.domain.call('task.review', {
      taskId: child.id,
      expectedRev: child.rev,
      candidate: child.candidate,
      decision: 'accept',
      source: 'attempted individual review',
    }, owner), /aggregate feature review/);

    const rejected = await context.workflow.call('workflow.reviewResult', {
      featureId: feature.id,
      children: [{ taskId: child.id, expectedRev: child.rev, candidate: child.candidate }],
      decision: 'reject',
      source: 'workflow regression test',
      notes: 'The complete feature result needs one bounded correction.',
      submissionId: 'reject-result',
    }, owner);
    const rejectedChild = rejected.children[0].task;
    assert.equal(rejected.feature.phase, 'blocked');
    assert.equal(rejectedChild.state, 'Blocked');

    const exactChildren = [{ taskId: rejectedChild.id, expectedRev: rejectedChild.rev, candidate: rejectedChild.candidate }];
    await assert.rejects(context.workflow.call('workflow.resumeResult', {
      featureId: feature.id,
      children: [{ ...exactChildren[0], expectedRev: rejectedChild.rev - 1 }],
      decision: 'Approve the bounded correction.',
      source: 'workflow regression test',
      submissionId: 'stale-rework',
    }, owner), /stale or not eligible/);

    const originalFeatureApproval = context.store.require<any>('workflow_owner_approval', feature.approvalId);
    const expiredFeature = context.store.require<any>('workflow_feature', feature.id);
    context.store.put('workflow_feature', { ...expiredFeature, deadline: '2000-01-01T00:00:00.000Z' }, expiredFeature.rev);

    const resumed = await context.workflow.call('workflow.resumeResult', {
      featureId: feature.id,
      children: exactChildren,
      decision: 'Approve the bounded correction.',
      source: 'workflow regression test',
      submissionId: 'resume-rework',
    }, owner);
    assert.equal(resumed.feature.phase, 'ready');
    assert.equal(resumed.feature.waitingFor, 'implementation');
    assert.equal(resumed.replacements.length, 1);
    assert.equal(resumed.replacements[0].rejectedTaskId, rejectedChild.id);
    const replacement = resumed.replacements[0].task;
    assert.equal(replacement.state, 'Approved');
    for (const key of ['projectId', 'specId', 'specHash', 'requirements', 'objective', 'criteria', 'permissions', 'budget', 'runtime', 'resources'] as const) {
      assert.deepEqual(replacement[key], rejectedChild[key], `replacement changed ${key}`);
    }
    assert(Date.parse(replacement.deadline) > Date.now());
    assert.equal(replacement.deadline, resumed.feature.deadline);
    assert.match(replacement.scope, new RegExp('^'+rejectedChild.scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(replacement.scope, /Owner result review feedback: The complete feature result needs one bounded correction\./);
    assert.deepEqual(replacement.sourceCandidate, { commit: rejectedChild.candidate.materializedCommit, rejectedCandidate: rejectedChild.candidate.id });
    assert.equal(replacement.worktree, true);
    assert.equal(replacement.workflow.reworkOf, rejectedChild.id);
    assert.equal(resumed.receipt.sourceOwnerApprovalId, feature.approvalId);
    const approval = context.store.require<any>('workflow_owner_approval', resumed.receipt.reworkApprovalId);
    assert.equal(approval.kind, 'result_rework');
    assert.equal(approval.sourceOwnerApprovalId, feature.approvalId);
    assert.equal(approval.originalDeadline, '2000-01-01T00:00:00.000Z');
    assert.equal(approval.deadline, replacement.deadline);
    assert.equal(context.store.require<any>('workflow_owner_approval', feature.approvalId).deadline, originalFeatureApproval.deadline);

    const replay = await context.workflow.call('workflow.resumeResult', {
      featureId: feature.id,
      children: exactChildren,
      decision: 'Approve the bounded correction.',
      source: 'workflow regression test',
      submissionId: 'resume-rework',
    }, owner);
    assert.deepEqual(replay, resumed);
    assert.equal(context.store.list<any>('task').filter(value => value.workflow?.reworkOf === rejectedChild.id).length, 1);
  } finally { context.close(); }
});

test('owner can resume a paused inherited verification only from its exact checkpoint and authority', async () => {
  const context = fixture();
  try {
    const { feature, target, verification } = await reachVerification(context);
    const preserved = { id: context.sourceCandidate.commit, specHash: verification.specHash, materializedCommit: context.sourceCandidate.commit };
    const pause = context.domain.call('task.control', { taskId: verification.id, expectedRev: verification.rev, command: 'pause' }, owner);
    const paused = context.domain.call('task.ack', { taskId: verification.id, expectedRev: pause.rev, command: 'pause', checkpoint: { summary: 'Stopped for bounded recovery.' } }, { role: 'system', id: 'workflow-regression-execution' });
    const stoppedRun = context.store.require<any>('run', paused.runId);
    const savedRun = context.store.put<any>('run', { ...stoppedRun, checkpointCandidate: preserved, status: 'paused', finishedAt: new Date().toISOString() }, stoppedRun.rev);

    assert.throws(() => context.domain.call('task.control', { taskId: paused.id, expectedRev: paused.rev, command: 'resume' }, owner), /exact saved checkpoint/);
    context.store.put('checkpoint', { id: `checkpoint:${savedRun.id}:paused`, projectId: paused.projectId, taskId: paused.id, runId: savedRun.id, data: { candidate: preserved }, at: new Date().toISOString(), actor: 'workflow-regression-execution' });

    const authorization = context.store.require<any>('workflow_authorization', paused.inheritedAuthorization.id);
    const forgedAuthorization = context.store.put('workflow_authorization', { ...authorization, ownerApprovalId: 'forged-owner-approval' }, authorization.rev);
    assert.throws(() => context.domain.call('task.control', { taskId: paused.id, expectedRev: paused.rev, command: 'resume' }, owner), /Inherited workflow authorization is stale/);
    context.store.put('workflow_authorization', { ...authorization }, forgedAuthorization.rev);

    const blocked = context.store.put<any>('task', { ...paused, state: 'Blocked' }, paused.rev);
    assert.throws(() => context.domain.call('task.control', { taskId: blocked.id, expectedRev: blocked.rev, command: 'resume' }, owner), /only from a paused checkpoint/);
    context.store.put('task', { ...blocked, state: 'Paused' }, blocked.rev);

    const before = context.store.require<any>('task', paused.id);
    const resumed = context.domain.call('task.control', { taskId: before.id, expectedRev: before.rev, command: 'resume' }, owner);
    assert.equal(resumed.state, 'Paused');
    assert.equal(resumed.requested.command, 'resume');
    for (const key of ['scope', 'criteria', 'permissions', 'budget', 'deadline', 'runtime', 'sourceCandidate', 'worktree', 'dependencies', 'workflow'] as const) assert.deepEqual(resumed[key], before[key], `resume changed ${key}`);

    assert.equal(context.store.require<any>('workflow_feature', feature.id).phase, 'verifying');
    assert.equal(context.store.require<any>('task', target.id).candidate.id, target.candidate.id);
  } finally { context.close(); }
});
