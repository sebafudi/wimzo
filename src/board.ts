import { assert, hash, id, now, type RecordValue, type Store } from './store.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dispatchRuntime } from './worker-profile.ts';
import { contextBudget } from './worker-context.ts';

type Role = 'owner' | 'guide' | 'worker' | 'system';
export type Actor = { role: Role; id: string; taskId?: string };
type Json = Record<string, any>;
type DomainApi = { call(action: string, input: Json, actor: Actor): any };
type ExecutionApi = { call(action: string, input: Json, actor: Actor): any };
type FeedbackApi = { call(action: string, input: Json, actor: Actor): any };
export type RecommendationsApi = {
  validateProfile(profile: Json, permissions?: string[], projectId?: string): Promise<Json>;
};

type Project = RecordValue & { name: string; root: string; canonicalPaths: string[] };
type Spec = RecordValue & {
  projectId: string; path: string; hash: string; status: 'Draft' | 'Accepted' | 'Superseded' | 'Retired';
  requirementIds: string[]; acceptedRequirementIds?: string[];
};
type Task = RecordValue & {
  projectId: string; specId: string; specHash: string; requirements: string[]; objective: string; criteria: string[];
  scope: string; permissions: string[]; budget: Json; deadline?: string; sourceCandidate?: Json; runtime?: string;
  worktree?: string | boolean; resources: string[]; priority: number; state: string; waitingReasons: string[];
};
type Idea = RecordValue & { projectId: string; title: string; description: string; future?: boolean; inboxId: string; links: { specId?: string; taskId?: string }[]; createdBy: Json; createdAt: string };
type Proposal = RecordValue & {
  projectId: string; specId: string; specHash: string; specRev: number; objective: string; scope: string; criteria: string[];
  requirements: string[]; permissions: string[]; budget: Json; sourceCandidate: Json; deadline: string;
  worktree?: string | boolean; ideaId?: string; state: 'Needs approval' | 'Approved'; taskId?: string; createdBy: Json; createdAt: string;
};

const columns = [
  ['ideas', 'Ideas'], ['prd_review', 'PRD review'], ['ready', 'Ready'], ['running', 'Running'],
  ['review', 'Review'], ['done', 'Done'], ['blocked', 'Blocked'],
] as const;

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function strings(value: unknown, label: string): string[] {
  assert(Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim()), `${label} must be a nonempty string array`);
  return [...new Set((value as string[]).map(item => item.trim()))];
}
function object(value: unknown, label: string): Json { assert(!!value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); return value as Json; }
function nonempty(value: unknown, label: string): string { assert(typeof value === 'string' && value.trim(), `${label} is required`); return value.trim(); }
function expected(value: Json): number { assert(Number.isInteger(value.expectedRev), 'expectedRev is required'); return value.expectedRev; }
function acceptedRequirements(spec: Spec): string[] { return spec.status === 'Accepted' ? spec.acceptedRequirementIds ?? spec.requirementIds : spec.requirementIds; }
function taskColumn(state: string): string {
  if (state === 'Approved') return 'ready';
  if (state === 'Running' || state === 'Verifying') return 'running';
  if (state === 'Needs result review') return 'review';
  if (state === 'Accepted' || state === 'Canceled' || state === 'Superseded') return 'done';
  if (state === 'Needs approval') return 'prd_review';
  return 'blocked';
}
function cardId(kind: string, value: string) { return `${kind}:${value}`; }
function specTitle(value: Spec): string { return String(value.content ?? '').match(/^#\s+(.+)$/m)?.[1]?.replace(/\*\*/g, '') ?? value.path; }
function workBoundsReason(value: { sourceCandidate?: Json; deadline?: string; permissions: string[]; worktree?: string | boolean }): string | null {
  const source = value.sourceCandidate?.commit ?? value.sourceCandidate?.sha ?? value.sourceCandidate?.id;
  if (typeof source !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(source)) return 'Bounded work requires an exact sourceCandidate commit.';
  if (typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline)) || Date.parse(value.deadline) <= Date.now()) return 'Bounded work requires a valid future deadline.';
  if (value.permissions.some(permission => ['write', 'workspace-write', 'filesystem:write'].includes(permission)) && value.worktree === false) return 'Bounded writer work requires an isolated worktree.';
  return null;
}
function assertWorkBounds(value: { sourceCandidate?: Json; deadline?: string; permissions: string[]; worktree?: string | boolean }) { const reason = workBoundsReason(value); assert(reason === null, reason ?? 'Invalid bounded work'); }

type WorkflowApi = { attachApprovedTask(task: any): any };
export function Board(store: Store, domain: DomainApi, execution: ExecutionApi, _feedback: FeedbackApi, recommendations?: RecommendationsApi, workflow?: WorkflowApi) {
  const actions = [
    { name: 'board.list', description: 'Show the durable project board derived from specifications, work, ideas, triage, and inbox state.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: { type: 'string' } } } },
    { name: 'board.idea', description: 'Save a durable product idea and owner-visible inbox item.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'title', 'description', 'submissionId'], properties: { projectId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, future: { type: 'boolean' }, submissionId: { type: 'string' } } } },
    { name: 'board.link', description: 'Link a saved idea to exact project specification and task records.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'ideaId', 'expectedRev'], properties: { projectId: { type: 'string' }, ideaId: { type: 'string' }, specId: { type: 'string' }, taskId: { type: 'string' }, expectedRev: { type: 'integer' } } } },
    { name: 'board.propose', description: 'Save bounded work for owner review without accepting requirements or launching execution.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'specId', 'objective', 'scope', 'criteria', 'requirements', 'permissions', 'budget', 'sourceCandidate', 'deadline'], properties: { projectId: { type: 'string' }, specId: { type: 'string' }, objective: { type: 'string' }, scope: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } }, requirements: { type: 'array', items: { type: 'string' } }, permissions: { type: 'array', items: { type: 'string' } }, budget: { type: 'object' }, sourceCandidate: { type: 'object' }, deadline: { type: 'string' }, worktree: { oneOf: [{ type: 'string' }, { type: 'boolean' }] }, ideaId: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'board.prepare', description: 'Prepare an exact specification or bounded-work approval for owner review.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'cardId'], properties: { projectId: { type: 'string' }, cardId: { type: 'string' }, profile: { type: 'object' } } } },
    { name: 'board.approve', description: 'Atomically accept an exact Draft and approve its bounded work, or approve an existing bounded task.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'cardId', 'fingerprint', 'profile', 'submissionId'], properties: { projectId: { type: 'string' }, cardId: { type: 'string' }, fingerprint: { type: 'string' }, profile: { type: 'object' }, submissionId: { type: 'string' } } } },
    { name: 'board.phase', description: 'Record the actual planning or implementation phase of an already running task.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'expectedRev', 'phase'], properties: { taskId: { type: 'string' }, expectedRev: { type: 'integer' }, phase: { type: 'string', enum: ['planning', 'implementing'] }, note: { type: 'string' } } } },
  ];

  function project(projectId: string): Project { return store.require<Project>('project', projectId); }
  function spec(specId: string): Spec { return store.require<Spec>('spec', specId); }
  function task(taskId: string): Task { return store.require<Task>('task', taskId); }
  function idea(ideaId: string): Idea { return store.require<Idea>('idea', ideaId); }
  function proposal(proposalId: string): Proposal { return store.require<Proposal>('board_proposal', proposalId); }
  function assertProject(projectId: string) { project(projectId); }
  function assertIdeaProject(value: Idea, projectId: string) { assert(value.projectId === projectId, 'Idea does not belong to the supplied project'); }
  function assertProfileAvailable(projectId: string, profile: Json, permissions: string[] = []): Promise<Json> {
    assert(recommendations, 'Worker profile recommendations are unavailable. Select a supported profile after the recommender is configured.');
    return recommendations.validateProfile(profile, permissions, projectId);
  }
  function profileBinding(profile: Json | undefined, permissions: string[]) {
    return profile ? { profile, profileStatus: 'supported' } : { profile: null, profileStatus: 'missing' };
  }
  async function resolveProfile(input: Json, projectId: string, permissions: string[]): Promise<Json | undefined> {
    if (input.profile === undefined) return undefined;
    const validated = await assertProfileAvailable(projectId, object(input.profile, 'profile'), permissions);
    assert(validated && typeof validated === 'object' && !Array.isArray(validated), 'Worker profile validation returned an invalid profile');
    assert(typeof validated.runtime === 'string' && validated.runtime, 'Worker profile validation returned no runtime');
    return structuredClone(validated);
  }
  function proposalInput(input: Json, currentSpec: Spec): Omit<Proposal, 'id' | 'rev' | 'projectId' | 'specId' | 'specHash' | 'specRev' | 'state' | 'createdBy' | 'createdAt'> {
    const requirements = strings(input.requirements, 'requirements');
    const allowed = currentSpec.status === 'Accepted' ? acceptedRequirements(currentSpec) : currentSpec.requirementIds;
    assert(requirements.length > 0 && requirements.every(value => allowed.includes(value)), 'Work requirements must belong to the exact specification revision');
    const deadline = nonempty(input.deadline, 'deadline');
    assert(Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) > Date.now(), 'deadline must be a valid future time');
    if (input.worktree !== undefined) assert(typeof input.worktree === 'string' || typeof input.worktree === 'boolean', 'worktree must be a path string or boolean');
    if (typeof input.worktree === 'string') assert(input.worktree.length > 0, 'worktree must not be empty');
    contextBudget(input.budget?.context);
    const result = {
      objective: nonempty(input.objective, 'objective'), scope: nonempty(input.scope, 'scope'), criteria: strings(input.criteria, 'criteria'), requirements,
      permissions: strings(input.permissions, 'permissions'), budget: structuredClone(object(input.budget, 'budget')),
      sourceCandidate: structuredClone(object(input.sourceCandidate, 'sourceCandidate')), deadline,
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }), ...(input.ideaId === undefined ? {} : { ideaId: nonempty(input.ideaId, 'ideaId') }),
    };
    assert(result.criteria.length > 0, 'criteria must contain at least one criterion');
    assertWorkBounds(result);
    return result;
  }
  function taskPayload(value: Proposal | Json, currentSpec: Spec, profile: Json) {
    return {
      projectId: value.projectId, specId: currentSpec.id, specHash: currentSpec.hash, requirements: value.requirements,
      objective: value.objective, criteria: value.criteria, scope: value.scope, permissions: value.permissions,
      budget: { ...structuredClone(value.budget), workerProfile: structuredClone(profile) }, sourceCandidate: structuredClone(value.sourceCandidate),
      deadline: value.deadline, ...(value.worktree === undefined ? {} : { worktree: value.worktree }), runtime: dispatchRuntime(profile as any),
    };
  }
  function bindingForProposal(value: Proposal, currentSpec: Spec, profile: Json | undefined) {
    return { kind: 'proposal', projectId: value.projectId, proposalId: value.id, proposalRev: value.rev, state: value.state, spec: { id: currentSpec.id, rev: currentSpec.rev, hash: currentSpec.hash, status: currentSpec.status, path: currentSpec.path }, objective: value.objective, scope: value.scope, criteria: value.criteria, requirements: value.requirements, permissions: value.permissions, budget: value.budget, sourceCandidate: value.sourceCandidate, deadline: value.deadline, worktree: value.worktree ?? null, ...profileBinding(profile, value.permissions) };
  }
  function bindingForTask(value: Task, currentSpec: Spec, profile: Json | undefined) {
    return { kind: 'task', projectId: value.projectId, taskId: value.id, taskRev: value.rev, state: value.state, spec: { id: currentSpec.id, rev: currentSpec.rev, hash: currentSpec.hash, status: currentSpec.status, path: currentSpec.path }, objective: value.objective, scope: value.scope, criteria: value.criteria, requirements: value.requirements, permissions: value.permissions, budget: value.budget, sourceCandidate: value.sourceCandidate ?? null, deadline: value.deadline ?? null, worktree: value.worktree ?? null, ...profileBinding(profile, value.permissions) };
  }
  function specInfo(value: Spec) { return { id: value.id, hash: value.hash, rev: value.rev, status: value.status, path: value.path }; }
  function canonicalHash(value: Spec): string | null {
    try { return hash(readFileSync(resolve(project(value.projectId).root, value.path), 'utf8')); } catch { return null; }
  }
  function prepareStatic(projectId: string, valueCardId: string, profile: Json | undefined) {
    const [kind, key] = valueCardId.split(':', 2);
    assert(kind && key, 'Unknown board card');
    if (kind === 'proposal') {
      const value = proposal(key); assert(value.projectId === projectId, 'Proposal does not belong to the supplied project');
      const currentSpec = spec(value.specId); const actualHash = canonicalHash(currentSpec); const exact = currentSpec.rev === value.specRev && currentSpec.hash === value.specHash && actualHash === currentSpec.hash;
      const bounds = workBoundsReason(value);
      const reason = value.state !== 'Needs approval' ? 'This proposal is already approved.' : !exact ? 'The specification changed. Prepare a new bounded proposal.' : currentSpec.status !== 'Draft' ? 'This proposal no longer targets a Draft specification.' : bounds ?? (!profile ? 'Select a supported worker profile before approval.' : null);
      const binding = { ...bindingForProposal(value, currentSpec, profile), canonicalHash: actualHash };
      return { fingerprint: hash(canonical(binding)), title: value.objective, scope: value.scope, criteria: value.criteria, permissions: value.permissions, budget: value.budget, deadline: value.deadline, sourceCandidate: value.sourceCandidate, worktree: value.worktree, spec: specInfo(currentSpec), proposal: structuredClone(value), profile: profile ?? null, canApprove: reason === null, reason };
    }
    if (kind === 'task') {
      const value = task(key); assert(value.projectId === projectId, 'Task does not belong to the supplied project');
      const currentSpec = spec(value.specId); const actualHash = canonicalHash(currentSpec); const exact = currentSpec.status === 'Accepted' && currentSpec.hash === value.specHash && actualHash === currentSpec.hash && value.requirements.every(requirement => acceptedRequirements(currentSpec).includes(requirement));
      const bounds = workBoundsReason(value);
      const reason = value.state !== 'Needs approval' ? `This task is ${value.state} and is not awaiting work approval.` : !exact ? 'The task specification is stale and must be reviewed again.' : bounds ?? (!profile ? 'Select a supported worker profile before approval.' : null);
      const binding = { ...bindingForTask(value, currentSpec, profile), canonicalHash: actualHash };
      return { fingerprint: hash(canonical(binding)), title: value.objective, scope: value.scope, criteria: value.criteria, permissions: value.permissions, budget: value.budget, deadline: value.deadline, sourceCandidate: value.sourceCandidate, worktree: value.worktree, spec: specInfo(currentSpec), task: structuredClone(value), profile: profile ?? null, canApprove: reason === null, reason };
    }
    if (kind === 'spec' || kind === 'spec-review' || kind === 'spec-ready') {
      const value = spec(key); assert(value.projectId === projectId, 'Specification does not belong to the supplied project');
      return { fingerprint: hash(canonical({ kind, projectId, spec: specInfo(value) })), title: value.path, scope: null, criteria: [], permissions: [], budget: null, deadline: null, spec: specInfo(value), profile: null, canApprove: false, reason: 'Prepare a bounded work scope before approving implementation.' };
    }
    throw new Error('This board card has no approval action');
  }
  async function prepare(input: Json, actor: Actor) {
    assertProject(input.projectId);
    const card = nonempty(input.cardId, 'cardId');
    const unprofiled = prepareStatic(input.projectId, card, undefined);
    const rawProfile = await resolveProfile(input, input.projectId, unprofiled.permissions);
    const result = prepareStatic(input.projectId, card, rawProfile);
    return { ...result, canApprove: actor.role === 'owner' && result.canApprove };
  }
  function submissionKey(action: string, actor: Actor, submissionId: string) { return hash(canonical({ action, actor: { id: actor.id, role: actor.role }, submissionId })); }
  function replay(key: string, signature: string) {
    const existing = store.get<any>('board_submission', key);
    if (existing) { assert(existing.signature === signature, 'submissionId was reused with different board content'); return existing.result; }
    return undefined;
  }
  function remember(key: string, signature: string, result: any, actor: Actor) { store.put('board_submission', { id: key, signature, result, actor: { id: actor.id, role: actor.role }, at: now() }); return result; }
  async function list(projectId: string) {
    const p = project(projectId);
    let queued: any[] = [];
    try {
      const fresh = await execution.call('execution.queue', { projectId: p.id }, { role: 'owner', id: 'board-projection' });
      if (Array.isArray(fresh)) queued = fresh;
    } catch { queued = []; }
    const queueReasons = new Map(queued.map(value => [value.taskId, Array.isArray(value.reasons) ? value.reasons : value.reason ? [value.reason] : []]));
    const cards: Record<string, any[]> = Object.fromEntries(columns.map(([key]) => [key, []]));
    const allTasks = store.list<Task>('task').filter(value => value.projectId === p.id);
    const proposals = store.list<Proposal>('board_proposal').filter(value => value.projectId === p.id);
    const coveredDrafts = new Set(proposals.filter(value => value.state === 'Needs approval').map(value => value.specId));
    for (const value of store.list<Idea>('idea').filter(value => value.projectId === p.id && value.links.length === 0)) cards.ideas.push({ id: cardId('idea', value.id), kind: 'idea', title: value.title, column: 'ideas', status: 'new', summary: value.description });
    for (const value of proposals.filter(value => value.state === 'Needs approval')) cards.prd_review.push({ id: cardId('proposal', value.id), kind: 'proposal', title: value.objective, column: 'prd_review', status: value.state, summary: value.scope, specId: value.specId, path: spec(value.specId).path, rev: value.specRev, waitingReasons: ['owner approval required'] });
    for (const value of store.list<Spec>('spec').filter(value => value.projectId === p.id && (value.status === 'Draft' || value.status === 'Accepted'))) {
      if (value.status === 'Draft' && coveredDrafts.has(value.id)) continue;
      const accepted = acceptedRequirements(value);
      const coveredRequirements = new Set(allTasks.filter(taskValue => taskValue.specId === value.id && taskValue.specHash === value.hash && !['Canceled', 'Superseded'].includes(taskValue.state)).flatMap(taskValue => taskValue.requirements));
      const remaining = value.status === 'Accepted' ? accepted.filter(requirement => !coveredRequirements.has(requirement)) : value.requirementIds;
      const pendingReview = value.status === 'Accepted' ? value.requirementIds.filter(requirement => !accepted.includes(requirement)) : [];
      if (pendingReview.length) cards.prd_review.push({ id: `spec-review:${value.id}`, kind: 'spec', title: specTitle(value), column: 'prd_review', status: 'Accepted subset', summary: 'Some requirements in this revision still need owner review.', specId: value.id, path: value.path, rev: value.rev, requirements: pendingReview });
      if (value.status === 'Accepted' && remaining.length === 0) continue;
      const column = value.status === 'Draft' ? 'prd_review' : 'ready';
      const summary = value.status === 'Draft'
        ? (value.requirementIds.length ? 'Requirement changes need owner review.' : 'Review this document in Requirements before preparing implementation work.')
        : 'Accepted requirements await a bounded work proposal.';
      cards[column].push({ id: value.status === 'Accepted' ? `spec-ready:${value.id}` : cardId('spec', value.id), kind: 'spec', title: specTitle(value), column, status: value.status, summary, specId: value.id, path: value.path, rev: value.rev, requirements: remaining });
    }
    for (const value of allTasks) {
      const column = taskColumn(value.state);
      const phase = value.state === 'Running' ? (value as any).phase : undefined;
      const closed = value.state === 'Canceled' || value.state === 'Superseded';
      const controller = !closed && (value as any).controller?.kind === 'human' ? (value as any).controller : undefined;
      const queued = closed ? [] : value.state === 'Approved' ? queueReasons.get(value.id) ?? value.waitingReasons : value.waitingReasons;
      const waitingReasons = controller ? [...queued.filter((reason: string) => !reason.startsWith('human_control:')), `Human control by ${controller.id}; release it to return the task to agents`] : queued;
      cards[column].push({ id: cardId('task', value.id), kind: 'task', title: value.objective, column, status: controller ? `${value.state} (human control)` : phase ? `${value.state} (${phase.name})` : closed ? `Closed: ${value.state.toLowerCase()}` : value.state, summary: phase?.note ? `${value.scope} ${phase.note}` : value.scope, specId: value.specId, taskId: value.id, path: spec(value.specId).path, rev: value.rev, phase: phase?.name, waitingReasons, ...(controller ? { controller } : {}), ...(closed ? { closed: true } : {}) });
    }
    const ideaInboxIds = new Set(store.list<Idea>('idea').filter(value => value.projectId === p.id).map(value => value.inboxId));
    const representedTriage = new Set<string>();
    for (const value of store.list<any>('inbox').filter(value => value.projectId === p.id && value.status !== 'resolved' && !ideaInboxIds.has(value.id))) {
      if (value.data?.triageId) representedTriage.add(value.data.triageId);
      const isChange = ['review change request', 'outside change review', 'gap', 'specification conflict'].includes(value.kind);
      if (!isChange && (value.data?.taskId || value.data?.specId)) continue;
      const column = isChange ? 'ideas' : 'blocked';
      cards[column].push({ id: cardId('inbox', value.id), kind: 'inbox', title: value.kind, column, status: value.status, summary: value.summary, specId: value.data?.specId, taskId: value.data?.taskId, featureId: value.data?.featureId, rev: value.rev, waitingReasons: ['needs attention'] });
    }
    for (const value of store.list<any>('triage').filter(value => value.projectId === p.id && value.status !== 'resolved' && !representedTriage.has(value.id))) {
      const column = ['gap', 'change request', 'specification conflict'].includes(value.classification) ? 'ideas' : 'blocked';
      cards[column].push({ id: `inbox:triage:${value.id}`, kind: 'inbox', title: value.classification, column, status: value.status, summary: value.summary, rev: value.rev, waitingReasons: ['needs triage'] });
    }
    return { columns: columns.map(([id, title]) => ({ id, title, cards: cards[id] })), watermark: store.watermark() };
  }
  async function approve(input: Json, actor: Actor) {
    const projectId = nonempty(input.projectId, 'projectId'); const approvalCardId = nonempty(input.cardId, 'cardId'); const fingerprint = nonempty(input.fingerprint, 'fingerprint'); const submissionId = nonempty(input.submissionId, 'submissionId');
    const rawProfile = object(input.profile, 'profile');
    const key = submissionKey('approve', actor, submissionId); const signature = hash(canonical({ projectId, cardId: approvalCardId, fingerprint, profile: rawProfile }));
    const cached = replay(key, signature); if (cached) return cached;
    const unprofiled = prepareStatic(projectId, approvalCardId, undefined);
    const profile = await assertProfileAvailable(projectId, rawProfile, unprofiled.permissions);
    return store.tx(() => {
      const prior = replay(key, signature); if (prior) return prior;
      const prepared = prepareStatic(projectId, approvalCardId, profile);
      assert(prepared.fingerprint === fingerprint, 'Board card changed. Prepare the approval again.');
      assert(prepared.canApprove, prepared.reason ?? 'This board card cannot be approved.');
      if (approvalCardId.startsWith('proposal:')) {
        const value = proposal(approvalCardId.slice('proposal:'.length)); const draft = spec(value.specId);
        assertWorkBounds(value);
        const accepted = domain.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, requirementIds: value.requirements, decision: `Accepted with bounded work: ${value.objective}`, source: `board.approve:${value.id}` }, actor).spec as Spec;
        const created = domain.call('task.create', taskPayload(value, accepted, profile), actor) as Task;
        const approved = domain.call('task.approve', { taskId: created.id, expectedRev: created.rev, decision: `Approved from board proposal ${value.id}`, source: `board.approve:${value.id}` }, actor).task as Task;
        const next = store.put<Proposal>('board_proposal', { ...value, state: 'Approved', taskId: approved.id, approvedAt: now(), approvedBy: actor.id }, value.rev);
        store.event('board.proposal.approved', projectId, { proposalId: next.id, specId: accepted.id, taskId: approved.id });
        if (value.ideaId) { const linked = idea(value.ideaId); store.put<Idea>('idea', { ...linked, links: [...linked.links, { specId: accepted.id, taskId: approved.id }] }, linked.rev); }
        workflow?.attachApprovedTask(approved);
        return remember(key, signature, { spec: accepted, task: approved, proposal: next, profile }, actor);
      }
      assert(approvalCardId.startsWith('task:'), 'Only a bounded proposal or task can be approved');
      const value = task(approvalCardId.slice('task:'.length));
      assertWorkBounds(value);
      const profiled = store.put<Task>('task', { ...value, runtime: dispatchRuntime(profile as any), budget: { ...value.budget, workerProfile: structuredClone(profile) } }, value.rev);
      const approved = domain.call('task.approve', { taskId: profiled.id, expectedRev: profiled.rev, decision: `Approved from board task ${profiled.id}`, source: `board.approve:${profiled.id}` }, actor).task as Task;
      store.event('board.task.approved', projectId, { taskId: approved.id, profile });
      workflow?.attachApprovedTask(approved);
      return remember(key, signature, { task: approved, profile }, actor);
    });
  }
  async function call(name: string, input: Json, actor: Actor): Promise<any> {
    const descriptor = actions.find(action => action.name === name);
    assert(descriptor, `Unknown board action: ${name}`); assert(descriptor.roles.includes(actor.role), `Role ${actor.role} may not call ${name}`);
    object(input, 'input');
    if (name === 'board.list') return list(nonempty(input.projectId, 'projectId'));
    if (name === 'board.idea') {
      const projectId = nonempty(input.projectId, 'projectId'); assertProject(projectId); const submissionId = nonempty(input.submissionId, 'submissionId');
      const key = submissionKey('idea', actor, submissionId); const signature = hash(canonical({ projectId, title: input.title, description: input.description, future: input.future === true })); const cached = replay(key, signature); if (cached) return cached;
      return store.tx(() => { const prior = replay(key, signature); if (prior) return prior; const title = nonempty(input.title, 'title'); const description = nonempty(input.description, 'description'); const future = input.future === true; const value = store.put<Idea>('idea', { id: id('idea'), projectId, title, description, future, inboxId: '', links: [], createdBy: { id: actor.id, role: actor.role }, createdAt: now() }); const inbox = store.put('inbox', { id: id('inbox'), projectId, kind: 'idea', summary: title, data: { ideaId: value.id, description, future }, status: 'pending', createdAt: now() }); const saved = store.put<Idea>('idea', { ...value, inboxId: inbox.id }, value.rev); store.event('board.idea.created', projectId, { ideaId: saved.id, inboxId: inbox.id, future }); return remember(key, signature, { idea: saved, inbox }, actor); });
    }
    if (name === 'board.link') {
      const projectId = nonempty(input.projectId, 'projectId'); assertProject(projectId); const value = idea(nonempty(input.ideaId, 'ideaId')); assertIdeaProject(value, projectId);
      assert(input.specId !== undefined || input.taskId !== undefined, 'specId or taskId is required'); let specId: string | undefined; let taskId: string | undefined;
      if (input.specId !== undefined) { const current = spec(nonempty(input.specId, 'specId')); assert(current.projectId === projectId, 'Specification belongs to another project'); specId = current.id; }
      if (input.taskId !== undefined) { const current = task(nonempty(input.taskId, 'taskId')); assert(current.projectId === projectId, 'Task belongs to another project'); taskId = current.id; if (specId) assert(current.specId === specId, 'Task does not bind the linked specification'); }
      const next = store.tx(() => { const current = idea(value.id); assert(current.rev === expected(input), 'Stale idea revision'); const saved = store.put<Idea>('idea', { ...current, links: [...current.links, { ...(specId ? { specId } : {}), ...(taskId ? { taskId } : {}) }] }, current.rev); store.event('board.idea.linked', projectId, { ideaId: saved.id, specId, taskId }); return saved; }); return { idea: next };
    }
    if (name === 'board.propose') {
      const projectId = nonempty(input.projectId, 'projectId'); assertProject(projectId); const submissionId = input.submissionId === undefined ? undefined : nonempty(input.submissionId, 'submissionId'); const signature = hash(canonical({ projectId, specId: input.specId, objective: input.objective, scope: input.scope, criteria: input.criteria, requirements: input.requirements, permissions: input.permissions, budget: input.budget, sourceCandidate: input.sourceCandidate, deadline: input.deadline, worktree: input.worktree, ideaId: input.ideaId })); const key = submissionId ? submissionKey('propose', actor, submissionId) : undefined; if (key) { const cached = replay(key, signature); if (cached) return cached; }
      const currentSpec = spec(nonempty(input.specId, 'specId')); assert(currentSpec.projectId === projectId, 'Specification does not belong to the supplied project'); assert(['Draft', 'Accepted'].includes(currentSpec.status), 'Work can only be proposed for a Draft or Accepted specification');
      const details = proposalInput(input, currentSpec); if (details.ideaId) assertIdeaProject(idea(details.ideaId), projectId);
      return store.tx(() => { if (key) { const prior = replay(key, signature); if (prior) return prior; } const exact = spec(currentSpec.id); assert(exact.rev === currentSpec.rev && exact.hash === currentSpec.hash, 'Specification changed while work was proposed'); const linkIdea = (taskId?: string) => { if (!details.ideaId) return; const linked = idea(details.ideaId); store.put<Idea>('idea', { ...linked, links: [...linked.links, { specId: exact.id, ...(taskId ? { taskId } : {}) }] }, linked.rev); }; if (exact.status === 'Accepted') { const created = domain.call('task.create', { projectId, specId: exact.id, specHash: exact.hash, ...details }, actor) as Task; linkIdea(created.id); store.event('board.task.proposed', projectId, { taskId: created.id, specId: exact.id, ideaId: details.ideaId }); const result = { task: created, cardId: cardId('task', created.id) }; return key ? remember(key, signature, result, actor) : result; } const value = store.put<Proposal>('board_proposal', { id: id('proposal'), projectId, specId: exact.id, specHash: exact.hash, specRev: exact.rev, ...details, state: 'Needs approval', createdBy: { id: actor.id, role: actor.role }, createdAt: now() }); linkIdea(); store.event('board.proposal.created', projectId, { proposalId: value.id, specId: exact.id, ideaId: details.ideaId }); const result = { proposal: value, cardId: cardId('proposal', value.id) }; return key ? remember(key, signature, result, actor) : result; });
    }
    if (name === 'board.prepare') return prepare(input, actor);
    if (name === 'board.approve') return approve(input, actor);
    const value = task(nonempty(input.taskId, 'taskId')); assert(value.state === 'Running', 'Only Running tasks can record an execution phase'); if (actor.role === 'worker') { assert(actor.taskId === value.id, 'Worker may update only its bound task'); assert(!value.workerId || value.workerId === actor.id, 'Worker does not own task'); }
    const phase = input.phase; assert(phase === 'planning' || phase === 'implementing', 'Invalid execution phase'); if (input.note !== undefined) nonempty(input.note, 'note');
    return store.tx(() => { const current = task(value.id); assert(current.state === 'Running', 'Only Running tasks can record an execution phase'); const next = store.put<Task>('task', { ...current, phase: { name: phase, note: input.note, at: now(), by: actor.id } }, expected(input)); store.event('task.phase', next.projectId, { taskId: next.id, phase, ...(input.note ? { note: input.note } : {}), actor: actor.id }); return next; });
  }
  return { actions: () => actions.map(action => structuredClone(action)), call };
}
