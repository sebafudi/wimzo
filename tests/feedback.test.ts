import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'fixture-owner' };
const guide = { role: 'guide' as const, id: 'fixture-guide' };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(content = '**H-001 Review actions.**\nThe owner can review an exact version.\n') {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-feedback-'));
  const root = join(temp, 'project');
  const state = join(temp, 'state');
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), content);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Initial requirements');
  const initialCommit = git(root, 'rev-parse', 'HEAD');
  const app = new App(state);
  const project = await app.call('project.register', {
    id: 'feedback-project', name: 'Feedback fixture', root, purpose: 'Review feedback tests', canonicalPaths: ['spec/PRD.md'],
  }, owner);
  const draft = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const close = async () => { await app.close(); rmSync(temp, { recursive: true, force: true }); };
  return { temp, root, state, app, project, draft, initialCommit, close };
}

function documentTarget(projectId: string, afterVersion: string, beforeVersion: string | null = null) {
  return { kind: 'document' as const, projectId, path: 'spec/PRD.md', beforeVersion, afterVersion };
}

async function acceptedFixture() {
  const context = await fixture();
  const accepted = (await context.app.call('spec.accept', {
    specId: context.draft.id,
    hash: context.draft.hash,
    expectedRev: context.draft.rev,
    decision: 'Accept fixture requirements',
    source: 'isolated test',
  }, owner)).spec;
  return { ...context, accepted };
}

async function reviewTask(context: Awaited<ReturnType<typeof acceptedFixture>>, taskId: string, candidateId: string) {
  const task = await context.app.call('task.create', {
    id: taskId,
    projectId: context.project.id,
    specId: context.accepted.id,
    specHash: context.accepted.hash,
    requirements: ['H-001'],
    objective: `Review ${taskId}`,
    criteria: ['candidate is exact'],
    scope: 'fixture only',
    permissions: [],
    budget: {},
  }, owner);
  const candidate = { id: candidateId, commit: candidateId, specHash: context.accepted.hash };
  return context.app.store.put('task', { ...task, state: 'Needs result review', candidate, dimensions: { ...task.dimensions, implemented: true, verified: true } }, task.rev);
}

test('document snapshot acceptance is bound to the selected version and canonical bytes', async () => {
  const context = await fixture();
  try {
    const target = documentTarget(context.project.id, `spec:${context.draft.id}`);
    const prepared = await context.app.call('review.prepare', { target }, owner);
    assert.equal(prepared.canAccept, true);
    assert.equal(prepared.canRequest, true);
    assert.equal(prepared.acceptLabel, 'Accept changes');
    const readOnly = await context.app.call('review.prepare', { target }, guide);
    assert.equal(readOnly.canAccept, false);
    assert.equal(readOnly.canRequest, false);
    const submitted = await context.app.call('review.submit', {
      target, fingerprint: prepared.fingerprint, decision: 'accept', note: '', submissionId: 'accept-document',
    }, owner);
    assert.match(submitted.message, /accepted/);
    assert.equal(context.app.store.require<any>('spec', context.draft.id).status, 'Accepted');
    assert.equal(submitted.feedback.target.afterHash, context.draft.hash);

    const again = await context.app.call('review.prepare', { target }, owner);
    assert.equal(again.accepted, true);
    assert.equal(again.canAccept, false);
    assert.equal(again.acceptLabel, 'Accepted');
    assert.equal(again.feedback.length, 1);
  } finally { await context.close(); }
});

test('document review completes an Accepted subset using the same canonical snapshot', async () => {
  const context = await fixture('**H-001 First review rule.**\nFirst behavior.\n\n**H-002 Second review rule.**\nSecond behavior.\n');
  try {
    const partial = (await context.app.call('spec.accept', {
      specId: context.draft.id, hash: context.draft.hash, expectedRev: context.draft.rev, requirementIds: ['H-001'], decision: 'Accept only the first rule', source: 'feedback test',
    }, owner)).spec;
    const target = documentTarget(context.project.id, `spec:${partial.id}`);
    const prepared = await context.app.call('review.prepare', { target }, owner);
    assert.equal(prepared.accepted, false);
    assert.equal(prepared.canAccept, true);
    assert.equal(prepared.reason, null);
    await context.app.call('review.submit', { target, fingerprint: prepared.fingerprint, decision: 'accept', note: '', submissionId: 'expand-subset' }, owner);
    assert.deepEqual(context.app.store.require<any>('spec', partial.id).acceptedRequirementIds, ['H-001', 'H-002']);
  } finally { await context.close(); }
});

test('document review accepts an ID-less whole document and then reports the exact snapshot as accepted', async () => {
  const context = await fixture('# Working agreement\n\nReview this whole document without requirement IDs.\n');
  try {
    const target = documentTarget(context.project.id, `spec:${context.draft.id}`);
    const prepared = await context.app.call('review.prepare', { target }, owner);
    assert.equal(prepared.canAccept, true);
    await context.app.call('review.submit', { target, fingerprint: prepared.fingerprint, decision: 'accept', note: '', submissionId: 'accept-idless-document' }, owner);
    const again = await context.app.call('review.prepare', { target }, owner);
    assert.equal(again.accepted, true);
    assert.equal(again.canAccept, false);
    assert.equal(again.reason, 'This exact specification is already accepted.');
  } finally { await context.close(); }
});

test('change request notes survive restart and remain available through the existing inbox', async () => {
  const context = await fixture();
  let restarted: App | undefined;
  try {
    const target = documentTarget(context.project.id, `spec:${context.draft.id}`);
    const prepared = await context.app.call('review.prepare', { target }, owner);
    await context.app.call('review.submit', {
      target,
      fingerprint: prepared.fingerprint,
      decision: 'request_changes',
      note: 'Explain the offline behavior before acceptance.',
      submissionId: 'document-note',
    }, owner);
    await context.app.close();
    restarted = new App(context.state);
    const afterRestart = await restarted.call('review.prepare', { target }, owner);
    assert.equal(afterRestart.feedback[0].note, 'Explain the offline behavior before acceptance.');
    const inbox = await restarted.call('inbox.list', { projectId: context.project.id, status: 'pending' }, guide);
    const request = inbox.find((item: any) => item.kind === 'review change request');
    assert.equal(request.data.note, 'Explain the offline behavior before acceptance.');
    assert.equal(request.data.feedbackId, afterRestart.feedback[0].id);
    assert.match(request.summary, /Feedback fixture: spec\/PRD\.md/);
  } finally {
    if (restarted) await restarted.close();
    rmSync(context.temp, { recursive: true, force: true });
  }
});

test('task decisions use the domain review transition and retain notes without dispatch', async () => {
  const accepted = await acceptedFixture();
  try {
    const acceptTask = await reviewTask(accepted, 'accept-task', 'candidate-a');
    const acceptTarget = { kind: 'task' as const, projectId: accepted.project.id, taskId: acceptTask.id };
    const acceptPrepared = await accepted.app.call('review.prepare', { target: acceptTarget }, owner);
    assert.equal(acceptPrepared.target.candidate.id, 'candidate-a');
    assert.equal(acceptPrepared.target.sourceCandidate, null);
    await accepted.app.call('review.submit', {
      target: acceptTarget, fingerprint: acceptPrepared.fingerprint, decision: 'accept', note: 'Looks good.', submissionId: 'accept-task',
    }, owner);
    assert.equal(accepted.app.store.require<any>('task', acceptTask.id).state, 'Accepted');

    const rejectTask = await reviewTask(accepted, 'reject-task', 'candidate-b');
    const rejectTarget = { kind: 'task' as const, projectId: accepted.project.id, taskId: rejectTask.id };
    const rejectPrepared = await accepted.app.call('review.prepare', { target: rejectTarget }, owner);
    await accepted.app.call('review.submit', {
      target: rejectTarget,
      fingerprint: rejectPrepared.fingerprint,
      decision: 'request_changes',
      note: 'Keep the exact version, but add the missing error state.',
      submissionId: 'reject-task',
    }, owner);
    const rejected = accepted.app.store.require<any>('task', rejectTask.id);
    assert.equal(rejected.state, 'Blocked');
    assert.equal(rejected.resultReview.notes, 'Keep the exact version, but add the missing error state.');
    assert.equal(accepted.app.store.list<any>('run').length, 0);
    const request = accepted.app.store.list<any>('inbox').find(item => item.kind === 'review change request' && item.data.taskId === rejectTask.id);
    assert.equal(request.data.target.candidate.id, 'candidate-b');
  } finally { await accepted.close(); }
});

test('stale, cross-project, and worker writes are rejected while read access remains isolated', async () => {
  const context = await fixture();
  try {
    const target = documentTarget(context.project.id, `spec:${context.draft.id}`);
    const prepared = await context.app.call('review.prepare', { target }, owner);
    writeFileSync(join(context.root, 'spec/PRD.md'), '**H-001 Changed after review.**\nDifferent bytes.\n');
    await assert.rejects(context.app.call('review.submit', {
      target, fingerprint: prepared.fingerprint, decision: 'accept', note: '', submissionId: 'stale-document',
    }, owner), /changed.*Prepare/i);

    const foreignRoot = join(context.temp, 'foreign');
    mkdirSync(join(foreignRoot, 'spec'), { recursive: true });
    writeFileSync(join(foreignRoot, 'spec/PRD.md'), '**H-001 Foreign.**\n');
    git(foreignRoot, 'init', '-q');
    git(foreignRoot, 'config', 'user.email', 'fixture@example.invalid');
    git(foreignRoot, 'config', 'user.name', 'Fixture');
    git(foreignRoot, 'config', 'commit.gpgsign', 'false');
    git(foreignRoot, 'add', '.');
    git(foreignRoot, 'commit', '-q', '-m', 'Foreign');
    const foreign = await context.app.call('project.register', { id: 'foreign', name: 'Foreign', root: foreignRoot, purpose: 'foreign' }, owner);
    const foreignDraft = await context.app.call('spec.capture', { projectId: foreign.id, path: 'spec/PRD.md' }, owner);
    const foreignAccepted = (await context.app.call('spec.accept', {
      specId: foreignDraft.id, hash: foreignDraft.hash, expectedRev: foreignDraft.rev, decision: 'fixture', source: 'fixture',
    }, owner)).spec;
    const task = await context.app.call('task.create', {
      id: 'worker-task', projectId: foreign.id, specId: foreignAccepted.id, specHash: foreignAccepted.hash,
      requirements: ['H-001'], objective: 'foreign worker task', criteria: ['check'], scope: 'fixture', permissions: [], budget: {},
    }, owner);
    const worker = { role: 'worker' as const, id: 'worker', taskId: task.id };
    await assert.rejects(context.app.call('review.prepare', { target }, worker), /only its project/);
    await assert.rejects(context.app.call('review.submit', {
      target, fingerprint: prepared.fingerprint, decision: 'request_changes', note: 'worker note', submissionId: 'worker-write',
    }, worker), /unavailable/);
    await assert.rejects(context.app.call('review.prepare', {
      target: { kind: 'task', projectId: context.project.id, taskId: task.id },
    }, owner), /supplied project/);
  } finally { await context.close(); }
});

test('submission retry is idempotent after state changes and changed reuse is rejected', async () => {
  const context = await acceptedFixture();
  try {
    const task = await reviewTask(context, 'retry-task', 'candidate-retry');
    const target = { kind: 'task' as const, projectId: context.project.id, taskId: task.id };
    const prepared = await context.app.call('review.prepare', { target }, owner);
    const input = {
      target, fingerprint: prepared.fingerprint, decision: 'request_changes' as const,
      note: 'Please revise this result.', submissionId: 'retry-once',
    };
    const first = await context.app.call('review.submit', input, owner);
    const replay = await context.app.call('review.submit', input, owner);
    assert.deepEqual(replay, first);
    assert.equal(context.app.store.list<any>('feedback').length, 1);
    assert.equal(context.app.store.list<any>('inbox').filter(item => item.kind === 'review change request').length, 1);
    await assert.rejects(context.app.call('review.submit', { ...input, note: 'Changed retry content.' }, owner), /reused with different/);
  } finally { await context.close(); }
});

test('a change request survives a stale task specification without changing task state', async () => {
  const context = await acceptedFixture();
  try {
    const task = await reviewTask(context, 'stale-spec-task', 'candidate-stale-spec');
    writeFileSync(join(context.root, 'spec/PRD.md'), '**H-001 Revised review actions.**\nThe revised behavior is canonical.\n');
    const replacement = await context.app.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    await context.app.call('spec.accept', {
      specId: replacement.id, hash: replacement.hash, expectedRev: replacement.rev, decision: 'Replace fixture requirements', source: 'isolated test',
    }, owner);
    const target = { kind: 'task' as const, projectId: context.project.id, taskId: task.id };
    const prepared = await context.app.call('review.prepare', { target }, owner);
    assert.equal(prepared.canAccept, false);
    const result = await context.app.call('review.submit', {
      target,
      fingerprint: prepared.fingerprint,
      decision: 'request_changes',
      note: 'Rebase the candidate on the revised requirements.',
      submissionId: 'stale-spec-note',
    }, owner);
    assert.match(result.message, /saved in the project inbox/);
    assert.equal(context.app.store.require<any>('task', task.id).state, 'Needs result review');
    assert.equal(context.app.store.list<any>('feedback').at(-1).note, 'Rebase the candidate on the revised requirements.');
  } finally { await context.close(); }
});

test('fingerprints bind alternate document versions and unsupported Git history stays read-only', async () => {
  const context = await fixture();
  try {
    writeFileSync(join(context.root, 'spec/PRD.md'), '**H-001 Second version.**\nNew behavior.\n');
    git(context.root, 'add', '.');
    git(context.root, 'commit', '-q', '-m', 'Second requirements');
    const secondCommit = git(context.root, 'rev-parse', 'HEAD');
    const secondDraft = await context.app.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    const firstTarget = documentTarget(context.project.id, `spec:${context.draft.id}`);
    const secondTarget = documentTarget(context.project.id, `spec:${secondDraft.id}`, `spec:${context.draft.id}`);
    const first = await context.app.call('review.prepare', { target: firstTarget }, owner);
    await assert.rejects(context.app.call('review.submit', {
      target: secondTarget, fingerprint: first.fingerprint, decision: 'accept', note: '', submissionId: 'alternate-version',
    }, owner), /changed.*Prepare/i);

    const historicalGit = documentTarget(context.project.id, `git:${context.initialCommit}`);
    const history = await context.app.call('review.prepare', { target: historicalGit }, owner);
    assert.equal(history.canAccept, false);
    assert.match(history.reason, /captured specification snapshot/);
    const currentGit = documentTarget(context.project.id, `git:${secondCommit}`, `git:${context.initialCommit}`);
    const current = await context.app.call('review.prepare', { target: currentGit }, owner);
    assert.equal(current.canAccept, true);
  } finally { await context.close(); }
});
