import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';
import { Workflow } from '../src/workflow.ts';

const owner = { role: 'owner' as const, id: 'workflow-owner' };
const guide = { role: 'guide' as const, id: 'workflow-guide' };
const profile = { id: 'codex:gpt-6-astra:high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', label: 'Codex Astra', source: 'local-metadata', verified: true };

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-workflow-')); const root = join(temp, 'project'); mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), '# Fixture\n\n**H-001 Fixture behavior.** The initial behavior.\n'); writeFileSync(join(root, 'spec/VISION.md'), '# Fixture vision\n\nA whole document without requirement headings.\n');
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture base');
  const store = new Store(':memory:'); const domain = Domain(store); const project = domain.call('project.register', { id: 'workflow-project', name: 'Workflow fixture', root, purpose: 'workflow tests', canonicalPaths: ['spec/PRD.md', 'spec/VISION.md'] }, owner); const captured = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner); const accepted = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, requirementIds: captured.requirementIds, decision: 'Accept base', source: 'workflow test' }, owner).spec; const visionCaptured = domain.call('spec.capture', { projectId: project.id, path: 'spec/VISION.md' }, owner); const vision = domain.call('spec.accept', { specId: visionCaptured.id, hash: visionCaptured.hash, expectedRev: visionCaptured.rev, requirementIds: [], decision: 'Accept base vision', source: 'workflow test' }, owner).spec;
  const workflow = Workflow(store, domain, { async validateProfile(value: any) { assert.equal(value.id, profile.id); return structuredClone(profile); } });
  const sourceCandidate = { commit: git(root, 'rev-parse', 'HEAD') };
  const config = { projectId: project.id, enabled: true, baselineSpecId: accepted.id, defaultProfile: profile, sourceCandidate, maxRunMs: 120_000, preparationBudget: { maxExecutionMs: 30_000 }, planningBudget: { maxExecutionMs: 30_000 }, implementationBudget: { maxExecutionMs: 100_000 }, context: { targetTokens: 150000, checkpointTokens: 120000, reserveTokens: 30000, maxTokens: 180000 }, decision: 'Enable the bounded fixture workflow', source: 'workflow test' };
  return { temp, root, store, domain, project, accepted, vision, workflow, sourceCandidate, config, close: () => { store.close(); rmSync(temp, { recursive: true, force: true }); } };
}

test('workflow remains disabled by default, ignores future ideas, and creates one inherited authorized preparation task after owner configuration', async () => {
  const context = fixture();
  try {
    context.store.put('idea', { id: 'future-idea', projectId: context.project.id, title: 'Later', description: 'Keep it for later', future: true, inboxId: 'i1', links: [], createdBy: owner, createdAt: new Date().toISOString() });
    context.store.put('idea', { id: 'active-idea', projectId: context.project.id, title: 'Now', description: 'Prepare requirements', future: false, inboxId: 'i2', links: [], createdBy: owner, createdAt: new Date().toISOString() });
    assert.deepEqual(context.workflow.tick({ projectId: context.project.id }).created, []);
    await context.workflow.call('workflow.configure', context.config, owner);
    const first = context.workflow.tick({ projectId: context.project.id }); const second = context.workflow.tick({ projectId: context.project.id });
    assert.equal(first.created.length, 1); assert.deepEqual(second.created, []);
    const feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0];
    assert.equal(feature.phase, 'preparing_prd'); assert.equal(feature.ideaId, 'active-idea');
    const preparation = context.store.require<any>('task', feature.preparationTaskId); assert.equal(preparation.state, 'Approved'); assert.equal(preparation.runtime, 'codex-profile'); assert.deepEqual(preparation.workflow.preparationSpecs.map((item: any) => item.path), ['spec/PRD.md', 'spec/VISION.md']);
    const approval = context.store.list<any>('approval').find(value => value.subjectId === preparation.id); assert.equal(approval.kind, 'task-inherited'); assert.equal(approval.actor.role, 'system');
    assert.equal((await context.workflow.call('workflow.list', { projectId: context.project.id }, owner)).length, 1);
  } finally { context.close(); }
});

test('an already linked accepted specification enrolls without creating a duplicate requirements preparation task', async () => {
  const context = fixture();
  try {
    context.store.put('idea', { id: 'linked-idea', projectId: context.project.id, title: 'Existing approved idea', description: 'Use the accepted requirement', future: false, inboxId: 'i3', links: [{ specId: context.accepted.id }], createdBy: owner, createdAt: new Date().toISOString() });
    await context.workflow.call('workflow.configure', context.config, owner); const tick = context.workflow.tick({ projectId: context.project.id });
    assert.deepEqual(tick.created, []); const feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0]; assert.equal(feature.phase, 'prd_review'); assert.equal(feature.preparationTaskId, undefined);
    const review = await context.workflow.call('workflow.review', { featureId: feature.id }, owner); assert.deepEqual(review.specs.map((value: any) => ({ id: value.id, path: value.path, hash: value.hash, rev: value.rev, status: value.status })), [{ id: context.accepted.id, path: context.accepted.path, hash: context.accepted.hash, rev: context.accepted.rev, status: 'Accepted' }]); assert.equal(review.specs[0].content, context.accepted.content);
    const approved = await context.workflow.call('workflow.approve', { featureId: feature.id, specId: context.accepted.id, specHash: context.accepted.hash, specRev: context.accepted.rev, profile, directImplementation: true, objective: 'Implement the accepted requirement', scope: 'Fixture only.', criteria: ['Fixture passes'], permissions: ['workspace-write'], decision: 'Approve direct work', source: 'workflow test', submissionId: 'bind-existing' }, owner);
    assert.equal(approved.task.state, 'Approved'); assert.equal(approved.feature.phase, 'ready'); assert.equal(approved.feature.waitingFor, 'implementation'); assert(Date.parse(approved.feature.deadline) - Date.now() >= context.config.implementationBudget.maxExecutionMs - 1_000);
    const implementationActor = { role: 'worker' as const, id: 'direct-implementer', taskId: approved.task.id }; const running = context.domain.call('task.claim', { taskId: approved.task.id, expectedRev: approved.task.rev, workerId: implementationActor.id }, implementationActor).task;
    context.workflow.tick({ projectId: context.project.id }); assert.equal(context.store.require<any>('workflow_feature', feature.id).phase, 'implementing');
    const verifying = context.domain.call('task.workerResult', { taskId: running.id, runId: running.runId, expectedTaskRev: running.rev, candidate: { id: context.sourceCandidate.commit, specHash: running.specHash }, summary: 'Direct feature result', checks: [], artifacts: [], unresolved: [] }, implementationActor).task;
    context.workflow.tick({ projectId: context.project.id }); const verificationTaskId = context.store.require<any>('workflow_feature', feature.id).verificationByTarget[verifying.id]; const verifierActor = { role: 'worker' as const, id: 'direct-verifier', taskId: verificationTaskId }; const verification = context.domain.call('task.claim', { taskId: verificationTaskId, expectedRev: context.store.require<any>('task', verificationTaskId).rev, workerId: verifierActor.id }, verifierActor).task;
    const checks = verifying.criteria.map((check: string) => ({ check, result: 'pass', details: {} })); const verified = await context.workflow.call('workflow.submitVerification', { featureId: feature.id, taskId: verification.id, expectedTaskRev: verification.rev, targetTaskId: verifying.id, candidate: verifying.candidate, checks, summary: 'Every direct-work criterion passed', submissionId: 'direct-verify' }, verifierActor);
    context.domain.call('task.workerResult', { taskId: verification.id, runId: verification.runId, expectedTaskRev: verification.rev, candidate: { id: context.sourceCandidate.commit, specHash: verification.specHash }, summary: 'Read-only verification run completed', checks: [], artifacts: [], unresolved: [] }, verifierActor); context.workflow.tick({ projectId: context.project.id }); assert(context.store.get<any>('workflow_internal_completion', `workflow_internal_completion:${verification.id}`));
    await assert.rejects(context.workflow.call('workflow.reviewResult', { featureId: feature.id, children: [{ taskId: verified.target.id, expectedRev: verified.target.rev, candidate: { ...verified.target.candidate, id: 'stale' } }], decision: 'accept', source: 'workflow test', submissionId: 'stale-result' }, owner), /stale/);
    const result = await context.workflow.call('workflow.reviewResult', { featureId: feature.id, children: [{ taskId: verified.target.id, expectedRev: verified.target.rev, candidate: verified.target.candidate }], decision: 'accept', source: 'workflow test', notes: 'Review exact verified candidate', submissionId: 'accept-result' }, owner);
    assert.equal(result.feature.phase, 'done'); assert.equal(result.children[0].task.state, 'Accepted'); assert.equal(result.receipt.children[0].taskId, verified.target.id);
  } finally { context.close(); }
});

test('a bound requirements worker persists exact draft content and feedback queues one revision task without accepting the draft', async () => {
  const context = fixture();
  try {
    context.store.put('idea', { id: 'active-idea', projectId: context.project.id, title: 'Now', description: 'Prepare requirements', future: false, inboxId: 'i2', links: [], createdBy: owner, createdAt: new Date().toISOString() });
    await context.workflow.call('workflow.configure', context.config, owner); context.workflow.tick({ projectId: context.project.id });
    let feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0]; let preparation = context.store.require<any>('task', feature.preparationTaskId);
    const worker = { role: 'worker' as const, id: 'requirements-worker', taskId: preparation.id }; const claim = context.domain.call('task.claim', { taskId: preparation.id, expectedRev: preparation.rev, workerId: worker.id }, worker); preparation = claim.task;
    const content = '# Fixture\n\n**H-001 Fixture behavior.** The amended behavior.\n';
    const proposal = await context.workflow.call('workflow.proposeRequirements', { featureId: feature.id, taskId: preparation.id, expectedTaskRev: preparation.rev, changes: [{ path: 'spec/PRD.md', baseSpecId: context.accepted.id, baseHash: context.accepted.hash, content }], revisionNote: 'Amend the fixture behavior', summary: 'One narrow amendment', submissionId: 'draft-1' }, worker);
    assert.equal(proposal.documents[0].status, 'Draft'); assert.equal(context.store.require<any>('spec', context.accepted.id).status, 'Accepted');
    await assert.rejects(context.workflow.call('workflow.acceptRequirements', { featureId: proposal.feature.id, documents: [{ documentId: proposal.documents[0].id, expectedRev: proposal.documents[0].rev }], decision: 'Invalid incomplete acceptance', source: '', submissionId: 'invalid-acceptance' }, owner), /source is required/);
    assert.equal(context.store.require<any>('spec', context.accepted.id).status, 'Accepted'); assert.equal(context.store.require<any>('workflow_document', proposal.documents[0].id).status, 'Draft');
    feature = proposal.feature; const revision = await context.workflow.call('workflow.requestChanges', { featureId: feature.id, documentId: proposal.documents[0].id, expectedRev: proposal.documents[0].rev, note: 'Clarify the wording', submissionId: 'request-1' }, guide);
    assert.equal(revision.task.state, 'Approved'); assert.notEqual(revision.task.id, preparation.id); assert.equal(revision.document.status, 'Changes requested');
    context.workflow.tick({ projectId: context.project.id }); assert.equal(context.store.require<any>('workflow_feature', feature.id).phase, 'preparing_prd');
    const paused = context.store.require<any>('task', revision.task.id); context.store.put('task', { ...paused, state: 'Paused' }, paused.rev);
    context.workflow.tick({ projectId: context.project.id }); assert.equal(context.store.require<any>('workflow_feature', feature.id).phase, 'blocked');
    const draftContext = await context.workflow.call('workflow.draftContext', { featureId: feature.id, taskId: revision.task.id }, { role: 'worker', id: 'revision-worker', taskId: revision.task.id });
    assert.equal(draftContext.documents[0].content, content); assert.equal(draftContext.documents[0].requestNote, 'Clarify the wording');
    const replay = await context.workflow.call('workflow.requestChanges', { featureId: feature.id, documentId: proposal.documents[0].id, expectedRev: proposal.documents[0].rev, note: 'Clarify the wording', submissionId: 'request-1' }, guide);
    assert.equal(replay.task.id, revision.task.id);
  } finally { context.close(); }
});

test('owner binds an exactly accepted proposed revision, then a plan creates inherited dependency-bound implementation slices within the total budget', async () => {
  const context = fixture();
  try {
    context.store.put('idea', { id: 'active-idea', projectId: context.project.id, title: 'Now', description: 'Prepare requirements', future: false, inboxId: 'i2', links: [], createdBy: owner, createdAt: new Date().toISOString() });
    await context.workflow.call('workflow.configure', context.config, owner); context.workflow.tick({ projectId: context.project.id }); let feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0]; let prep = context.store.require<any>('task', feature.preparationTaskId); const worker = { role: 'worker' as const, id: 'requirements-worker', taskId: prep.id }; prep = context.domain.call('task.claim', { taskId: prep.id, expectedRev: prep.rev, workerId: worker.id }, worker).task;
    const content = '# Fixture\n\n**H-001 Fixture behavior.** The amended behavior.\n'; const visionContent = '# Fixture vision\n\nA revised whole document without requirement headings.\n'; const draft = await context.workflow.call('workflow.proposeRequirements', { featureId: feature.id, taskId: prep.id, expectedTaskRev: prep.rev, changes: [{ path: 'spec/PRD.md', baseSpecId: context.accepted.id, baseHash: context.accepted.hash, content }, { path: 'spec/VISION.md', baseSpecId: context.vision.id, baseHash: context.vision.hash, content: visionContent }], revisionNote: 'Amend behavior and whole-document vision', submissionId: 'draft-1' }, worker);
    context.domain.call('task.workerResult', { taskId: prep.id, runId: prep.runId, expectedTaskRev: prep.rev, candidate: { id: context.sourceCandidate.commit, specHash: prep.specHash }, summary: 'Requirements draft persisted for review', checks: [], artifacts: [], unresolved: [] }, worker);
    const acceptanceInput = { featureId: draft.feature.id, documents: draft.documents.map((document: any) => ({ documentId: document.id, expectedRev: document.rev })), decision: 'Accept exact amendment', source: 'workflow test', submissionId: 'accept-draft-1' };
    const requirementApproval = await context.workflow.call('workflow.acceptRequirements', acceptanceInput, owner);
    const persistedSubmission = context.store.list<any>('workflow_submission').find(value => value.result?.accepted?.some((item: any) => item.spec.path === 'spec/VISION.md')); assert(persistedSubmission); context.store.remove('workflow_submission', persistedSubmission.id);
    const partialFeature = context.store.require<any>('workflow_feature', draft.feature.id); context.store.put('workflow_feature', { ...partialFeature, linkedSpecIds: [], acceptedSpecs: [] }, partialFeature.rev);
    const replayedAcceptance = await context.workflow.call('workflow.acceptRequirements', acceptanceInput, owner); assert.equal(replayedAcceptance.feature.linkedSpecIds.length, 2); assert.equal(context.store.list<any>('workflow_submission').some(value => value.id === persistedSubmission.id), true);
    const reviewed = replayedAcceptance.accepted.find((value: any) => value.spec.path === 'spec/VISION.md').spec;
    assert.deepEqual(reviewed.requirementIds, [`workflow:${draft.feature.id}:spec/VISION.md`]);
    const approved = await context.workflow.call('workflow.approve', { featureId: draft.feature.id, specId: reviewed.id, specHash: reviewed.hash, specRev: reviewed.rev, profile, directImplementation: false, objective: 'Implement the amended behavior', scope: 'Change the fixture behavior only.', criteria: ['Fixture behavior passes'], permissions: ['workspace-write'], decision: 'Approve planning', source: 'workflow test', submissionId: 'approve-1' }, owner);
    assert.equal(approved.task.state, 'Approved'); assert.equal(approved.feature.phase, 'ready'); assert.equal(approved.feature.waitingFor, 'planner');
    const planner = { role: 'worker' as const, id: 'planner', taskId: approved.task.id }; const planTask = context.domain.call('task.claim', { taskId: approved.task.id, expectedRev: approved.task.rev, workerId: planner.id }, planner).task;
    context.workflow.tick({ projectId: context.project.id }); assert.equal(context.store.require<any>('workflow_feature', approved.feature.id).phase, 'planning');
    const plan = await context.workflow.call('workflow.submitPlan', { featureId: approved.feature.id, taskId: planTask.id, expectedTaskRev: planTask.rev, submissionId: 'plan-1', slices: [{ id: 'second', objective: 'Verify fixture', scope: 'Verify the fixture only.', criteria: ['Fixture verification passes'], requirements: reviewed.acceptedRequirementIds, permissions: ['workspace-write'], budget: { maxExecutionMs: 35_000 }, dependencies: ['first'] }, { id: 'first', objective: 'Implement fixture', scope: 'Edit the fixture only.', criteria: ['Fixture behavior passes'], requirements: reviewed.acceptedRequirementIds, permissions: ['workspace-write'], budget: { maxExecutionMs: 45_000 }, dependencies: [] }] }, planner);
    assert.equal(plan.feature.phase, 'ready'); assert.equal(plan.feature.waitingFor, 'implementation'); assert.equal(plan.tasks.length, 2); assert(plan.tasks.every((value: any) => value.state === 'Approved')); assert.deepEqual(plan.tasks[1].dependencies, [plan.tasks[0].id]);
    assert(plan.tasks.every((value: any) => JSON.stringify(value.budget.context) === JSON.stringify(approved.feature.context)));
    assert.equal(context.store.list<any>('approval').filter(value => value.kind === 'task-inherited' && plan.tasks.some((task: any) => task.id === value.subjectId)).length, 2);

    const implementationActor = { role: 'worker' as const, id: 'implementer', taskId: plan.tasks[0].id };
    const implementationClaim = context.domain.call('task.claim', { taskId: plan.tasks[0].id, expectedRev: plan.tasks[0].rev, workerId: implementationActor.id }, implementationActor); assert.equal(implementationClaim.claimed, true, JSON.stringify(implementationClaim.reasons)); let implementation = implementationClaim.task;
    implementation = context.domain.call('task.workerResult', { taskId: implementation.id, runId: implementation.runId, expectedTaskRev: implementation.rev, candidate: { id: context.sourceCandidate.commit, specHash: implementation.specHash }, summary: 'Fixture implementation is ready for verification', checks: [], artifacts: [], unresolved: [] }, implementationActor).task;
    assert.equal(implementation.state, 'Verifying');
    context.workflow.tick({ projectId: context.project.id }); feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0];
    const verificationTaskId = feature.verificationByTarget[implementation.id]; const verifierActor = { role: 'worker' as const, id: 'verifier', taskId: verificationTaskId };
    let verification = context.domain.call('task.claim', { taskId: verificationTaskId, expectedRev: context.store.require<any>('task', verificationTaskId).rev, workerId: verifierActor.id }, verifierActor).task;
    assert.deepEqual(verification.permissions, []); assert.equal(verification.worktree, true); assert.equal(verification.budget.maxExecutionMs, 10_000);
    const verified = await context.workflow.call('workflow.submitVerification', { featureId: feature.id, taskId: verification.id, expectedTaskRev: verification.rev, targetTaskId: implementation.id, candidate: implementation.candidate, checks: [{ check: 'Fixture behavior passes', result: 'pass', details: { fixture: true } }], summary: 'Exact candidate passed the requested check', submissionId: 'verify-1' }, verifierActor);
    assert.equal(verified.target.state, 'Needs result review');
    await assert.rejects(context.workflow.call('workflow.reviewResult', { featureId: feature.id, children: [{ taskId: verified.target.id, expectedRev: verified.target.rev, candidate: verified.target.candidate }], decision: 'accept', source: 'workflow test', submissionId: 'incomplete-result-review' }, owner), /Every feature implementation child/);
    assert.equal(context.store.require<any>('task', verified.target.id).state, 'Needs result review');
    const queuedSuccessor = context.store.require<any>('task', plan.tasks[1].id);
    const waiting = context.domain.call('task.waiting', { taskId: queuedSuccessor.id }, owner);
    assert.equal(waiting.reasons.some((reason: string) => reason.includes('dependency')), false);
    const continuation = await context.workflow.call('workflow.continuation', { featureId: feature.id, taskId: queuedSuccessor.id }, { role: 'worker', id: 'successor', taskId: queuedSuccessor.id });
    assert.deepEqual(continuation.dependencies[0].candidate, implementation.candidate);
    const continuationRecord = context.store.require<any>('workflow_continuation', `workflow_continuation:${implementation.id}:${queuedSuccessor.id}`);
    context.store.put('workflow_continuation', { ...continuationRecord, targetTaskRev: continuationRecord.targetTaskRev - 1 }, continuationRecord.rev);
    assert.equal(context.domain.call('task.waiting', { taskId: queuedSuccessor.id }, owner).reasons.some((reason: string) => reason.includes('dependency')), true);
  } finally { context.close(); }
});

test('a bound requirements worker can propose a new canonical feature document that only owner review registers and accepts', async () => {
  const context = fixture();
  try {
    context.store.put('idea', { id: 'new-document-idea', projectId: context.project.id, title: 'New feature document', description: 'Create a scoped feature PRD', future: false, inboxId: 'i-new-document', links: [], createdBy: owner, createdAt: new Date().toISOString() });
    await context.workflow.call('workflow.configure', context.config, owner); context.workflow.tick({ projectId: context.project.id });
    const feature = (await context.workflow.call('workflow.list', { projectId: context.project.id }, owner))[0]; let preparation = context.store.require<any>('task', feature.preparationTaskId);
    const worker = { role: 'worker' as const, id: 'new-document-worker', taskId: preparation.id }; preparation = context.domain.call('task.claim', { taskId: preparation.id, expectedRev: preparation.rev, workerId: worker.id }, worker).task;
    const content = '# New feature\n\nA bounded feature document proposed for owner review.\n';
    mkdirSync(join(context.root, 'spec/features'), { recursive: true }); writeFileSync(join(context.root, 'spec/features/existing.md'), 'Do not overwrite.\n');
    await assert.rejects(context.workflow.call('workflow.proposeRequirements', { featureId: feature.id, taskId: preparation.id, expectedTaskRev: preparation.rev, changes: [{ path: 'spec/features/existing.md', content }], revisionNote: 'Attempt existing path', submissionId: 'existing-document-draft' }, worker), /already exists/);
    assert.equal(readFileSync(join(context.root, 'spec/features/existing.md'), 'utf8'), 'Do not overwrite.\n');
    const proposal = await context.workflow.call('workflow.proposeRequirements', { featureId: feature.id, taskId: preparation.id, expectedTaskRev: preparation.rev, changes: [{ path: 'spec/features/new-feature.md', content }], revisionNote: 'Create the feature PRD', submissionId: 'new-document-draft' }, worker);
    assert.equal(proposal.documents[0].newDocument, true); assert.equal(proposal.documents[0].baseSpecId, null); assert.equal(context.project.canonicalPaths.includes('spec/features/new-feature.md'), false);
    const beforeReview = await context.workflow.call('workflow.review', { featureId: feature.id }, owner); assert.equal(beforeReview.documents[0].base, null);
    const accepted = await context.workflow.call('workflow.acceptRequirements', { featureId: feature.id, documents: [{ documentId: proposal.documents[0].id, expectedRev: proposal.documents[0].rev }], decision: 'Accept the exact new feature PRD', source: 'workflow test', submissionId: 'new-document-accept' }, owner);
    assert.equal(context.store.require<any>('project', context.project.id).canonicalPaths.includes('spec/features/new-feature.md'), true);
    assert.equal(readFileSync(join(context.root, 'spec/features/new-feature.md'), 'utf8'), content);
    assert.deepEqual(accepted.accepted[0].spec.acceptedRequirementIds, [`workflow:${feature.id}:spec/features/new-feature.md`]);
    const approval = await context.workflow.call('workflow.approve', { featureId: feature.id, specId: accepted.accepted[0].spec.id, specHash: accepted.accepted[0].spec.hash, specRev: accepted.accepted[0].spec.rev, profile, directImplementation: true, objective: 'Implement the new feature', scope: 'Only the new feature document.', criteria: ['Feature document intent is implemented'], permissions: ['workspace-write'], decision: 'Approve bounded work', source: 'workflow test', submissionId: 'new-document-approve' }, owner);
    assert.equal(approval.task.state, 'Approved'); assert.equal(approval.feature.phase, 'ready');
  } finally { context.close(); }
});
