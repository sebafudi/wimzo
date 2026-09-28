import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, hash } from '../src/store.ts';
import { readWorkerSpecification, workerContext } from '../src/worker-context.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-worker-context-'));
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-001 Context.** Keep this task bounded.\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Use the accepted specification.\n');
  const store = new Store(':memory:');
  store.put('project', { id: 'context-project', name: 'Context', root, purpose: 'test', canonicalPaths: ['spec/PRD.md'] });
  store.put('spec', { id: 'accepted-spec', projectId: 'context-project', path: 'spec/PRD.md', hash: 'accepted-hash', content: '**H-001 Context.** Keep this task bounded.\n', status: 'Accepted' });
  store.put('workflow_feature', { id: 'feature-one', projectId: 'context-project', phase: 'verifying', scope: 'Feature scope', criteria: ['Verify exact candidate'], implementationBudget: { maxExecutionMs: 60000 }, profile: { id: 'codex:fixture:low' }, sourceCandidate: { id: 'feature-commit' }, acceptedSpecs: [{ id: 'accepted-spec', hash: 'accepted-hash', rev: 1, path: 'spec/PRD.md' }] });
  store.put('workflow_document', { id: 'accepted-document', projectId: 'context-project', featureId: 'feature-one', path: 'spec/PRD.md', baseHash: 'base', proposedHash: 'accepted-hash', status: 'Accepted', acceptedSpec: { id: 'accepted-spec', hash: 'accepted-hash', rev: 1 } });
  store.put('task', { id: 'context-task', projectId: 'context-project', specId: 'accepted-spec', specHash: 'accepted-hash', objective: 'Use exact context', scope: 'fixture', criteria: ['bounded'], permissions: ['workspace-read'], budget: { context: { targetTokens: 100000 } }, sourceCandidate: { id: 'owner-commit' }, workflow: { featureId: 'feature-one', purpose: 'verification', targetTaskId: 'implementation-task', targetCandidate: { id: 'verified-commit' }, continuation: { fromTaskId: 'prior-task' } }, state: 'Running', runId: 'context-run' });
  store.put('run', { id: 'context-run', taskId: 'context-task', projectId: 'context-project', status: 'running', sourceCandidate: { id: 'verified-commit' }, resolvedWorkflowSource: { commit: 'verified-commit', kind: 'dependency', candidates: [{ taskId: 'prior-task', candidate: 'verified-commit' }] } });
  store.put('project_worker_policy', { id: 'context-project', projectId: 'context-project', policy: { models: ['gpt-fixture'] } });
  return { store };
}

test('worker context uses the persisted project policy and the same budget context field as execution', () => {
  const context = fixture();
  try {
    const packet = workerContext(context.store, 'context-task', 'context-run');
    assert.deepEqual(packet.policy, { models: ['gpt-fixture'] });
    assert.equal(packet.contextPolicy.targetTokens, 100000);
    assert.deepEqual(packet.task.sourceCandidate, { id: 'owner-commit' });
    assert.deepEqual(packet.task.runSourceCandidate, { id: 'verified-commit' });
    assert.equal(packet.task.resolvedWorkflowSource.commit, 'verified-commit');
    const workflow = packet.task.workflow;
    assert.ok(workflow);
    assert.deepEqual(workflow.continuation, { fromTaskId: 'prior-task' });
    assert.equal(workflow.targetTaskId, 'implementation-task');
    assert.deepEqual(workflow.targetCandidate, { id: 'verified-commit' });
    const feature = workflow.feature;
    assert.ok(feature);
    assert.equal(feature.phase, 'verifying');
    assert.equal(feature.acceptedDocuments[0].id, 'accepted-document');
    assert.equal(packet.instructions.length, 1);
    assert.equal(packet.receipt.estimated, true);
  } finally { context.store.close(); }
});

test('worker context rejects a stale run before exposing task material', () => {
  const context = fixture();
  try {
    assert.throws(() => workerContext(context.store, 'context-task', 'other-run'), /stale/);
  } finally { context.store.close(); }
});

test('isolated workers receive instructions from their actual candidate checkout', () => {
  const context = fixture();
  try {
    const project = context.store.require('project', 'context-project');
    const cwd = join(project.root, '.wimzo', 'worktrees', 'candidate');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'README.md'), 'Build the approved candidate using npm run check.\n');
    const task = context.store.require('task', 'context-task');
    context.store.put('task', { ...task, worktree: true }, task.rev);
    const run = context.store.require('run', 'context-run');
    context.store.put('run', { ...run, cwd }, run.rev);
    const packet = workerContext(context.store, task.id, run.id);
    assert.equal(packet.instructions.find(value => value.origin === 'execution-worktree')?.content, 'Build the approved candidate using npm run check.\n');
    assert.ok(packet.instructions.some(value => value.content === 'Use the accepted specification.\n'));
    const current = context.store.require('run', run.id);
    context.store.put('run', { ...current, cwd: mkdtempSync(join(tmpdir(), 'wimzo-foreign-context-')) }, current.rev);
    assert.throws(() => workerContext(context.store, task.id, run.id), /escapes its project/);
  } finally { context.store.close(); }
});

function specificationFixture() {
  const store = new Store(':memory:');
  const primaryContent = 'Primary accepted requirement.\n';
  const secondaryContent = 'Secondary approved requirement content.\n';
  const foreignContent = 'Foreign project content.\n';
  const primary = { id: 'primary-spec', path: 'spec/PRD.md', hash: hash(primaryContent), content: primaryContent };
  const secondary = { id: 'secondary-spec', path: 'spec/details.md', hash: hash(secondaryContent), content: secondaryContent };
  const foreign = { id: 'foreign-spec', path: 'spec/private.md', hash: hash(foreignContent), content: foreignContent };
  store.put('project', { id: 'spec-project', name: 'Spec', root: '/tmp/spec-project', purpose: 'fixture', canonicalPaths: [] });
  store.put('project', { id: 'foreign-project', name: 'Foreign', root: '/tmp/foreign-project', purpose: 'fixture', canonicalPaths: [] });
  store.put('spec', { ...primary, projectId: 'spec-project', status: 'Accepted' });
  store.put('spec', { ...secondary, projectId: 'spec-project', status: 'Accepted' });
  store.put('spec', { ...foreign, projectId: 'foreign-project', status: 'Accepted' });
  const primaryRecord = store.require<any>('spec', primary.id);
  const secondaryRecord = store.require<any>('spec', secondary.id);
  const foreignRecord = store.require<any>('spec', foreign.id);
  store.put('workflow_owner_approval', { id: 'feature-approval', projectId: 'spec-project', kind: 'feature', actor: { role: 'owner', id: 'owner' }, specId: primary.id, specHash: primary.hash, specRev: primaryRecord.rev, approvedSpecs: [{ id: primary.id, hash: primary.hash, rev: primaryRecord.rev, path: primary.path }, { id: secondary.id, hash: secondary.hash, rev: secondaryRecord.rev, path: secondary.path }, { id: foreign.id, hash: foreign.hash, rev: foreignRecord.rev, path: foreign.path }] });
  store.put('workflow_feature', { id: 'feature-specs', projectId: 'spec-project', approvalId: 'feature-approval' });
  store.put('task', { id: 'spec-task', projectId: 'spec-project', specId: primary.id, specHash: primary.hash, state: 'Running', runId: 'spec-run', inheritedAuthorization: { ownerApprovalId: 'feature-approval' }, workflow: { featureId: 'feature-specs' } });
  store.put('run', { id: 'spec-run', taskId: 'spec-task', projectId: 'spec-project', status: 'running' });
  return { store, primary, secondary, foreign };
}

test('worker specification pages only immutable owner-approved accepted documents', () => {
  const context = specificationFixture();
  try {
    const page = readWorkerSpecification(context.store, 'spec-task', 'spec-run', { specId: context.secondary.id, maxChars: 10 });
    assert.equal(page.content, context.secondary.content.slice(0, 10));
    assert.equal(page.truncated, true);
    assert.equal(page.nextOffset, 10);
    const tail = readWorkerSpecification(context.store, 'spec-task', 'spec-run', { specId: context.secondary.id, offset: page.nextOffset, maxChars: 30_000 });
    assert.equal(tail.content, context.secondary.content.slice(10));
    assert.equal(tail.truncated, false);
    assert.throws(() => readWorkerSpecification(context.store, 'spec-task', 'spec-run', { specId: context.foreign.id }), /stale/);
    const secondary = context.store.require<any>('spec', context.secondary.id);
    context.store.put('spec', { ...secondary, status: 'Draft' }, secondary.rev);
    assert.throws(() => readWorkerSpecification(context.store, 'spec-task', 'spec-run', { specId: context.secondary.id }), /stale/);
  } finally { context.store.close(); }
});

test('requirements preparation reads only its pinned canonical specification index', () => {
  const context = specificationFixture();
  try {
    const configApproval = context.store.put('workflow_owner_approval', { id: 'configuration-approval', projectId: 'spec-project', kind: 'configuration', actor: { role: 'owner', id: 'owner' } });
    context.store.put('workflow_config', { id: 'spec-project', projectId: 'spec-project', enabled: true, approvalId: configApproval.id });
    const feature = context.store.require<any>('workflow_feature', 'feature-specs');
    context.store.put('workflow_feature', { ...feature, approvalId: undefined, preparationTaskId: 'prep-task' }, feature.rev);
    context.store.put('task', {
      id: 'prep-task', projectId: 'spec-project', specId: context.primary.id, specHash: context.primary.hash,
      state: 'Running', runId: 'prep-run', inheritedAuthorization: { ownerApprovalId: configApproval.id },
      workflow: { featureId: 'feature-specs', purpose: 'requirements_preparation', preparationSpecs: [
        { ...context.primary, rev: context.store.require<any>('spec', context.primary.id).rev },
        { ...context.secondary, rev: context.store.require<any>('spec', context.secondary.id).rev },
      ] },
    });
    context.store.put('run', { id: 'prep-run', taskId: 'prep-task', projectId: 'spec-project', status: 'running' });
    const page = readWorkerSpecification(context.store, 'prep-task', 'prep-run', { specId: context.secondary.id });
    assert.equal(page.content, context.secondary.content);
    assert.throws(() => readWorkerSpecification(context.store, 'prep-task', 'prep-run', { specId: context.foreign.id }), /scope/);
    const packet = workerContext(context.store, 'prep-task', 'prep-run');
    assert.deepEqual(packet.task.workflow?.preparationSpecs?.map((value: any) => value.id), [context.primary.id, context.secondary.id]);
  } finally { context.store.close(); }
});

test('requirements revision preparation needs an exact configuration parent approval', () => {
  const context = specificationFixture();
  try {
    const configApproval = context.store.put('workflow_owner_approval', { id: 'configuration-approval', projectId: 'spec-project', kind: 'configuration', actor: { role: 'owner', id: 'owner' } });
    const revisionApproval = context.store.put('workflow_owner_approval', { id: 'revision-approval', projectId: 'spec-project', kind: 'requirements_revision', actor: { role: 'owner', id: 'owner' }, sourceOwnerApprovalId: configApproval.id });
    context.store.put('workflow_config', { id: 'spec-project', projectId: 'spec-project', enabled: true, approvalId: configApproval.id });
    const feature = context.store.require<any>('workflow_feature', 'feature-specs');
    context.store.put('workflow_feature', { ...feature, approvalId: undefined, preparationTaskId: 'revision-prep-task' }, feature.rev);
    context.store.put('task', { id: 'revision-prep-task', projectId: 'spec-project', specId: context.primary.id, specHash: context.primary.hash, state: 'Running', runId: 'revision-prep-run', inheritedAuthorization: { ownerApprovalId: revisionApproval.id }, workflow: { featureId: 'feature-specs', purpose: 'requirements_preparation', preparationSpecs: [{ ...context.primary, rev: context.store.require<any>('spec', context.primary.id).rev }] } });
    context.store.put('run', { id: 'revision-prep-run', taskId: 'revision-prep-task', projectId: 'spec-project', status: 'running' });
    assert.equal(readWorkerSpecification(context.store, 'revision-prep-task', 'revision-prep-run', { specId: context.primary.id }).content, context.primary.content);
    const wrong = context.store.require<any>('workflow_owner_approval', revisionApproval.id);
    context.store.put('workflow_owner_approval', { ...wrong, sourceOwnerApprovalId: 'other-configuration' }, wrong.rev);
    assert.throws(() => readWorkerSpecification(context.store, 'revision-prep-task', 'revision-prep-run', { specId: context.primary.id }), /revision approval/);
  } finally { context.store.close(); }
});


test('worker context bounds UTF-8 bytes before a multibyte packet reaches the runner',()=>{
 const context=fixture();try{
  const spec=context.store.require('spec','accepted-spec');
  context.store.put('spec',{...spec,content:'😀'.repeat(60000)},spec.rev);
  assert.throws(()=>workerContext(context.store,'context-task','context-run'),/too large/);
 }finally{context.store.close();}
});
