import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'board-owner' };
const guide = { role: 'guide' as const, id: 'board-guide' };
const profile = { id: 'codex-astra', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', label: 'Codex Astra', source: 'local-metadata', verified: true };
const piProfile = { id: 'pi-fixture', runtime: 'pi', provider: 'openai', authRoute: 'subscription', model: 'pi-fixture-model', thinking: 'low', contextWindow: 32_000, label: 'Pi fixture', source: 'pi-sdk', verified: true };
const candidate = { commit: 'a'.repeat(40) };

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function boardFixture(requirements = ['H-001', 'H-002'], recommendationsOverride?: any) {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-board-'));
  const root = join(temp, 'project');
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), requirements.map(value => `**${value} Fixture.**\nBoard fixture behavior.\n`).join('\n'));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture requirements');
  const store = new Store(':memory:');
  const domain = Domain(store);
  const recommendations = recommendationsOverride ?? { async validateProfile(value: any) { assert.deepEqual(value, profile); return structuredClone(profile); } };
  const board = Board(store, domain, {} as any, {} as any, recommendations);
  const project = domain.call('project.register', { id: 'board-project', name: 'Board fixture', root, purpose: 'board tests', canonicalPaths: ['spec/PRD.md'] }, owner);
  const draft = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  return { temp, root, store, domain, board, project, draft, close: () => { store.close(); rmSync(temp, { recursive: true, force: true }); } };
}

async function accepted(context: ReturnType<typeof boardFixture>, requirements = context.draft.requirementIds) {
  return domainAccept(context, requirements);
}
function domainAccept(context: ReturnType<typeof boardFixture>, requirements: string[]) {
  return context.domain.call('spec.accept', { specId: context.draft.id, hash: context.draft.hash, expectedRev: context.draft.rev, requirementIds: requirements, decision: 'Fixture acceptance', source: 'board test' }, owner).spec;
}
function work(spec: any, requirements: string[]) {
  return { projectId: spec.projectId, specId: spec.id, objective: 'Bounded fixture work', scope: 'Change the isolated fixture only.', criteria: ['board fixture passes'], requirements, permissions: ['workspace-write'], budget: { turns: 4 }, sourceCandidate: candidate, deadline: new Date(Date.now() + 120_000).toISOString(), worktree: '/tmp/wimzo-board-worktree' };
}
function cards(value: any) { return Object.fromEntries(value.columns.map((column: any) => [column.id, column.cards])); }

test('a draft proposal exposes exact approval fields and atomically accepts the draft with bounded profiled work', async () => {
  const context = boardFixture();
  try {
    const proposed = await context.board.call('board.propose', { ...work(context.draft, ['H-001']), submissionId: 'draft-proposal' }, guide);
    const before = await context.board.call('board.list', { projectId: context.project.id }, owner);
    const listed = cards(before);
    assert.equal(listed.prd_review.filter((card: any) => card.kind === 'proposal').length, 1);
    assert.equal(listed.prd_review.filter((card: any) => card.kind === 'spec').length, 0);

    const incomplete = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId }, owner);
    assert.equal(incomplete.canApprove, false);
    assert.match(incomplete.reason, /profile/i);
    const prepared = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId, profile }, owner);
    assert.equal(prepared.canApprove, true);
    assert.deepEqual(prepared.criteria, ['board fixture passes']);
    assert.deepEqual(prepared.permissions, ['workspace-write']);
    assert.equal(prepared.spec.hash, context.draft.hash);

    const approved = await context.board.call('board.approve', { projectId: context.project.id, cardId: proposed.cardId, fingerprint: prepared.fingerprint, profile, submissionId: 'approve-draft-proposal' }, owner);
    assert.equal(approved.spec.status, 'Accepted');
    assert.equal(approved.task.state, 'Approved');
    assert.equal(approved.task.runtime, 'codex-profile');
    assert.deepEqual(approved.task.budget.workerProfile, profile);
    assert.equal(context.store.require<any>('board_proposal', proposed.proposal.id).taskId, approved.task.id);
  } finally { context.close(); }
});

test('accepted requirements remain Ready until each accepted requirement has bounded work', async () => {
  const context = boardFixture();
  try {
    const spec = await accepted(context);
    const proposed = await context.board.call('board.propose', { ...work(spec, ['H-001']), submissionId: 'accepted-proposal' }, guide);
    assert.equal(proposed.task.state, 'Needs approval');
    const listed = cards(await context.board.call('board.list', { projectId: context.project.id }, owner));
    const ready = listed.ready.find((card: any) => card.id === `spec-ready:${spec.id}`);
    assert.ok(ready);
    assert.deepEqual(ready.requirements, ['H-002']);

    const prepared = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId, profile }, owner);
    const approved = await context.board.call('board.approve', { projectId: context.project.id, cardId: proposed.cardId, fingerprint: prepared.fingerprint, profile, submissionId: 'approve-accepted-task' }, owner);
    assert.equal(approved.task.state, 'Approved');

    const invalid = context.domain.call('task.create', {
      projectId: context.project.id, specId: spec.id, specHash: spec.hash, requirements: ['H-002'], objective: 'Legacy incomplete task',
      criteria: ['cannot be approved'], scope: 'fixture only', permissions: [], budget: {}, deadline: new Date(Date.now() + 120_000).toISOString(),
    }, owner);
    const unsafe = await context.board.call('board.prepare', { projectId: context.project.id, cardId: `task:${invalid.id}`, profile }, owner);
    assert.equal(unsafe.canApprove, false);
    assert.match(unsafe.reason, /sourceCandidate/);
    await assert.rejects(context.board.call('board.approve', { projectId: context.project.id, cardId: `task:${invalid.id}`, fingerprint: unsafe.fingerprint, profile, submissionId: 'unsafe-legacy-task' }, owner), /sourceCandidate/);
    const unchanged = context.store.require<any>('task', invalid.id);
    assert.equal(unchanged.rev, invalid.rev);
    assert.equal(unchanged.runtime, undefined);
  } finally { context.close(); }
});

test('Board rejects a project-disallowed profile before accepting or approving work', async () => {
  const calls: any[] = [];
  const context = boardFixture(['H-001'], { async validateProfile(value: any, permissions: string[], projectId: string) { calls.push({ value, permissions, projectId }); throw new Error(`Profile is not allowed for ${projectId}`); } });
  try {
    const proposed = await context.board.call('board.propose', { ...work(context.draft, ['H-001']), submissionId: 'policy-proposal' }, guide);
    const unprofiled = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId }, owner);
    await assert.rejects(context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId, profile }, owner), /not allowed/);
    await assert.rejects(context.board.call('board.approve', { projectId: context.project.id, cardId: proposed.cardId, fingerprint: unprofiled.fingerprint, profile, submissionId: 'policy-approval' }, owner), /not allowed/);
    assert.equal(calls.length, 2);
    assert(calls.every(call => call.projectId === context.project.id));
    assert(calls.every(call => JSON.stringify(call.permissions) === JSON.stringify(['workspace-write'])));
    assert.equal(context.store.require<any>('board_proposal', proposed.proposal.id).state, 'Needs approval');
    assert.equal(context.store.require<any>('spec', context.draft.id).status, 'Draft');
    assert.equal(context.store.list('task').length, 0);
    assert.equal(context.store.list('approval').length, 0);
  } finally { context.close(); }
});

test('Board maps the selected Pi profile to pi-profile for proposals and existing tasks', async () => {
  const calls: any[] = [];
  const context = boardFixture(['H-001'], { async validateProfile(value: any, permissions: string[], projectId: string) { calls.push({ value, permissions, projectId }); assert.equal(projectId, 'board-project'); assert.deepEqual(value, piProfile); return structuredClone(piProfile); } });
  try {
    const proposed = await context.board.call('board.propose', { ...work(context.draft, ['H-001']), submissionId: 'pi-proposal' }, guide);
    const preparedProposal = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposed.cardId, profile: piProfile }, owner);
    const approvedProposal = await context.board.call('board.approve', { projectId: context.project.id, cardId: proposed.cardId, fingerprint: preparedProposal.fingerprint, profile: piProfile, submissionId: 'pi-proposal-approval' }, owner);
    assert.equal(approvedProposal.task.runtime, 'pi-profile');
    assert.deepEqual(approvedProposal.task.budget.workerProfile, piProfile);

    const acceptedSpec = context.store.require<any>('spec', approvedProposal.task.specId);
    const legacy = context.domain.call('task.create', { ...work(acceptedSpec, ['H-001']), specHash: acceptedSpec.hash }, owner);
    const preparedTask = await context.board.call('board.prepare', { projectId: context.project.id, cardId: `task:${legacy.id}`, profile: piProfile }, owner);
    const approvedTask = await context.board.call('board.approve', { projectId: context.project.id, cardId: `task:${legacy.id}`, fingerprint: preparedTask.fingerprint, profile: piProfile, submissionId: 'pi-task-approval' }, owner);
    assert.equal(approvedTask.task.runtime, 'pi-profile');
    assert.deepEqual(approvedTask.task.budget.workerProfile, piProfile);
    assert.equal(calls.length, 4);
  } finally { context.close(); }
});

test('ideas are durable and idempotent, links are project-exact, and worker phases require a running bound task', async () => {
  const context = boardFixture();
  try {
    const first = await context.board.call('board.idea', { projectId: context.project.id, title: 'Offline export', description: 'Let the owner export the durable board.', submissionId: 'idea-1' }, guide);
    const replay = await context.board.call('board.idea', { projectId: context.project.id, title: 'Offline export', description: 'Let the owner export the durable board.', submissionId: 'idea-1' }, guide);
    assert.equal(replay.idea.id, first.idea.id);
    await assert.rejects(context.board.call('board.idea', { projectId: context.project.id, title: 'Changed', description: 'Changed content', submissionId: 'idea-1' }, guide), /reused/);

    await context.board.call('board.link', { projectId: context.project.id, ideaId: first.idea.id, specId: context.draft.id, expectedRev: first.idea.rev }, guide);
    const linked = context.store.require<any>('idea', first.idea.id);
    assert.equal(linked.links[0].specId, context.draft.id);

    const spec = domainAccept(context, ['H-001', 'H-002']);
    const proposal = await context.board.call('board.propose', { ...work(spec, ['H-001']), submissionId: 'phase-proposal' }, owner);
    const prepared = await context.board.call('board.prepare', { projectId: context.project.id, cardId: proposal.cardId, profile }, owner);
    const approved = await context.board.call('board.approve', { projectId: context.project.id, cardId: proposal.cardId, fingerprint: prepared.fingerprint, profile, submissionId: 'phase-approve' }, owner);
    const worker = { role: 'worker' as const, id: 'board-worker', taskId: approved.task.id };
    const claim = context.domain.call('task.claim', { taskId: approved.task.id, expectedRev: approved.task.rev }, worker);
    const phased = await context.board.call('board.phase', { taskId: claim.task.id, expectedRev: claim.task.rev, phase: 'planning', note: 'Reading the bounded scope.' }, worker);
    assert.equal(phased.phase.name, 'planning');
    await assert.rejects(context.board.call('board.phase', { taskId: phased.id, expectedRev: phased.rev, phase: 'implementing' }, { role: 'worker', id: 'other-worker', taskId: phased.id }), /own task|own/);
  } finally { context.close(); }
});

test('stale canonical content, cross-project cards and non-owner approval cannot change state', async () => {
  const context = boardFixture();
  try {
    const proposed = await context.board.call('board.propose', {...work(context.draft,['H-001']),submissionId:'stale-proposal'},guide);
    const prepared = await context.board.call('board.prepare',{projectId:context.project.id,cardId:proposed.cardId,profile},owner);
    const input = {projectId:context.project.id,cardId:proposed.cardId,fingerprint:prepared.fingerprint,profile,submissionId:'stale-approval'};
    await assert.rejects(context.board.call('board.approve',input,guide),/Role/);
    context.domain.call('project.register',{id:'another-project',name:'Another',root:context.root,purpose:'Isolation'},owner);
    await assert.rejects(context.board.call('board.prepare',{...input,projectId:'another-project'},owner),/belong/);
    writeFileSync(join(context.root,'spec/PRD.md'),'**H-001 Changed.** A different requirement.\n');
    await assert.rejects(context.board.call('board.approve',input,owner),/changed/i);
    assert.equal(context.store.require<any>('spec',context.draft.id).status,'Draft');
    assert.equal(context.store.list('task').length,0);
    assert.equal(context.store.list('approval').length,0);
  } finally {context.close();}
});

test('one linked idea moves through review and approval without duplicate cards or duplicate approvals', async () => {
  const context = boardFixture(['H-001']);
  try {
    const saved=await context.board.call('board.idea',{projectId:context.project.id,title:'Linked idea',description:'Turn this into a bounded change.',submissionId:'linked-idea'},owner);
    const proposalInput={...work(context.draft,['H-001']),ideaId:saved.idea.id,submissionId:'linked-proposal'};
    const proposed=await context.board.call('board.propose',proposalInput,guide);
    let listed=cards(await context.board.call('board.list',{projectId:context.project.id},owner));
    assert.equal(listed.ideas.length,0);
    assert.equal(listed.prd_review.length,1);
    const prepared=await context.board.call('board.prepare',{projectId:context.project.id,cardId:proposed.cardId,profile},owner);
    const input={projectId:context.project.id,cardId:proposed.cardId,fingerprint:prepared.fingerprint,profile,submissionId:'linked-approve'};
    const result=await context.board.call('board.approve',input,owner);
    assert.deepEqual(await context.board.call('board.approve',input,owner),result);
    assert.equal((await context.board.call('board.propose',proposalInput,guide)).proposal.id,proposed.proposal.id);
    assert.equal(context.store.list('task').length,1);
    assert.equal(context.store.list('approval').length,2);
    listed=cards(await context.board.call('board.list',{projectId:context.project.id},owner));
    assert.equal(listed.prd_review.length,0);
    assert.equal(listed.ready.length,1);
    assert.equal(listed.ready[0].taskId,result.task.id);
    const task=context.store.require<any>('task',result.task.id);
    context.store.put('task',{...task,state:'Needs result review'},task.rev);
    listed=cards(await context.board.call('board.list',{projectId:context.project.id},owner));
    assert.equal(listed.ready.length,0);
    assert.equal(listed.review.length,1);
  } finally {context.close();}
});
