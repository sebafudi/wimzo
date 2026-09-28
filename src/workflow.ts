import { assert, hash, now, type RecordValue, type Store } from './store.ts';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, realpathSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dispatchRuntime } from './worker-profile.ts';
import { contextBudget } from './worker-context.ts';

type Role = 'owner' | 'guide' | 'worker' | 'system';
type Actor = { role: Role; id: string; taskId?: string };
type Json = Record<string, any>;
type DomainApi = { call(action: string, input: Json, actor: Actor): any };
type RecommendationsApi = { validateProfile(profile: Json, permissions?: string[], projectId?: string): Promise<Json> };
type Project = RecordValue & { name: string; root: string; canonicalPaths: string[] };
type Spec = RecordValue & { projectId: string; path: string; hash: string; status: string; requirementIds: string[]; acceptedRequirementIds?: string[] };
type Task = RecordValue & { projectId: string; specId: string; specHash: string; requirements: string[]; objective: string; criteria: string[]; scope: string; permissions: string[]; budget: Json; deadline?: string; sourceCandidate?: Json; runtime?: string; worktree?: string | boolean; resources: string[]; dependencies: string[]; state: string; workerId?: string };

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const phases = new Set(['idea', 'preparing_prd', 'prd_review', 'ready', 'planning', 'implementing', 'verifying', 'result_review', 'done', 'blocked', 'future']);

function text(value: unknown, label: string, limit = 4_000) { assert(typeof value === 'string' && value.trim() && value.length <= limit, `${label} is required and bounded`); return value.trim(); }
function strings(value: unknown, label: string, limit = 40) { assert(Array.isArray(value) && value.length <= limit && value.every(item => typeof item === 'string' && item.trim()), `${label} must be a bounded string array`); return [...new Set((value as string[]).map(item => item.trim()))]; }
function object(value: unknown, label: string): Json { assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); return value as Json; }
function exactCommit(value: unknown, label = 'sourceCandidate') { const candidate = object(value, label); const commit = candidate.commit ?? candidate.sha ?? candidate.id; assert(typeof commit === 'string' && commitPattern.test(commit), `${label} requires an exact commit`); return { ...candidate, commit }; }
function futureDeadline(maxRunMs: number) { return new Date(Date.now() + maxRunMs).toISOString(); }
function featureDeadline(config: any, direct: boolean) { const sequentialMs = config.implementationBudget.maxExecutionMs + (direct ? 0 : config.planningBudget.maxExecutionMs); return futureDeadline(Math.max(config.maxRunMs, sequentialMs)); }
function acceptedRequirements(spec: Spec) { return spec.acceptedRequirementIds ?? spec.requirementIds; }
function same(value: unknown) { return JSON.stringify(value); }
function canonical(value: any): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function taskAuthorityShape(value: Task) { return { id: value.id, projectId: value.projectId, specId: value.specId, specHash: value.specHash, requirements: value.requirements, objective: value.objective, criteria: value.criteria, scope: value.scope, permissions: value.permissions, budget: value.budget, deadline: value.deadline, sourceCandidate: value.sourceCandidate, runtime: value.runtime, worktree: value.worktree, resources: value.resources, dependencies: value.dependencies }; }
function budget(value: unknown, label: string) { const result = object(value, label); assert(Number.isFinite(result.maxExecutionMs) && result.maxExecutionMs > 0 && result.maxExecutionMs <= 24 * 60 * 60_000, `${label}.maxExecutionMs must be a bounded positive duration`); return structuredClone(result); }
function implementationBudgetSplit(value: Json) { assert(value.maxExecutionMs >= 2, 'implementationBudget.maxExecutionMs must reserve time for verification'); const verificationReserveMs = Math.max(1, Math.min(value.maxExecutionMs - 1, Math.floor(value.maxExecutionMs / 5))); return { total: structuredClone(value), work: { ...structuredClone(value), maxExecutionMs: value.maxExecutionMs - verificationReserveMs }, verificationReserveMs }; }
function context(value: unknown) { const result = object(value, 'context'); const exceptionMaxTokens = result.exceptionMaxTokens ?? result.maxTokens; for (const key of ['targetTokens', 'checkpointTokens', 'reserveTokens']) assert(Number.isInteger(result[key]) && result[key] > 0, `context.${key} must be a positive integer`); assert(Number.isInteger(exceptionMaxTokens) && exceptionMaxTokens > 0, 'context.exceptionMaxTokens must be a positive integer'); assert(result.reserveTokens <= result.checkpointTokens && result.checkpointTokens <= result.targetTokens && result.targetTokens <= exceptionMaxTokens, 'Context thresholds are not ordered'); contextBudget(result); return { targetTokens: result.targetTokens, checkpointTokens: result.checkpointTokens, reserveTokens: result.reserveTokens, maxTokens: exceptionMaxTokens, exceptionMaxTokens, ...(typeof result.exceptionReason === 'string' ? { exceptionReason: result.exceptionReason.trim() } : {}) }; }

export function Workflow(store: Store, domain: DomainApi, recommendations: RecommendationsApi) {
  const actions = () => [
    { name: 'workflow.configure', description: 'Configure an owner-approved feature workflow.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'enabled'], properties: { projectId: { type: 'string' }, enabled: { type: 'boolean' }, baselineSpecId: { type: 'string' }, defaultProfile: { type: 'object' }, sourceCandidate: { type: 'object' }, maxRunMs: { type: 'integer' }, worktree: { oneOf: [{ type: 'string' }, { type: 'boolean' }] }, preparationBudget: { type: 'object' }, planningBudget: { type: 'object' }, implementationBudget: { type: 'object' }, context: { type: 'object' }, decision: { type: 'string' }, source: { type: 'string' } } } },
    { name: 'workflow.list', description: 'List durable feature workflow records and their exact review and work links.', roles: ['owner', 'guide', 'system'], inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } } } },
    { name: 'workflow.review', description: 'Read exact workflow draft and accepted document revisions for owner or guide review.', roles: ['owner', 'guide', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId'], properties: { featureId: { type: 'string' } } } },
    { name: 'workflow.tick', description: 'Advance deterministic workflow bookkeeping and create authorized requirements preparation tasks without dispatching work.', roles: ['system'], inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } } } },
    { name: 'workflow.proposeRequirements', description: 'Persist a task-bound, exact PRD amendment proposal for owner review without accepting it.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId', 'expectedTaskRev', 'changes', 'revisionNote', 'submissionId'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' }, expectedTaskRev: { type: 'integer' }, changes: { type: 'array', items: { type: 'object' } }, revisionNote: { type: 'string' }, summary: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.draftContext', description: 'Read exact prior workflow drafts and revision notes for the current task-bound requirements revision.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' } } } },
    { name: 'workflow.requestChanges', description: 'Save feedback against an exact workflow PRD draft and queue one authorized revision task.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'documentId', 'expectedRev', 'note', 'submissionId'], properties: { featureId: { type: 'string' }, documentId: { type: 'string' }, expectedRev: { type: 'integer' }, note: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.acceptRequirements', description: 'Owner-accept exact workflow PRD drafts by writing prevalidated canonical paths, capturing them, and recording exact specification decisions.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'documents', 'decision', 'source', 'submissionId'], properties: { featureId: { type: 'string' }, documents: { type: 'array', items: { type: 'object' } }, decision: { type: 'string' }, source: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.approve', description: 'Bind an owner-reviewed accepted specification revision and create approved planning or direct implementation work.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'specId', 'specHash', 'specRev', 'profile', 'directImplementation', 'objective', 'scope', 'criteria', 'permissions', 'decision', 'source', 'submissionId'], properties: { featureId: { type: 'string' }, specId: { type: 'string' }, specHash: { type: 'string' }, specRev: { type: 'integer' }, profile: { type: 'object' }, planningProfile: { type: 'object' }, implementationProfile: { type: 'object' }, directImplementation: { type: 'boolean' }, objective: { type: 'string' }, scope: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } }, permissions: { type: 'array', items: { type: 'string' } }, sourceCandidate: { type: 'object' }, deadline: { type: 'string' }, worktree: { oneOf: [{ type: 'string' }, { type: 'boolean' }] }, decision: { type: 'string' }, source: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.reviewResult', description: 'Owner-review every exact verified implementation child and persist one aggregate feature result decision.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'children', 'decision', 'source', 'submissionId'], properties: { featureId: { type: 'string' }, children: { type: 'array', items: { type: 'object' } }, decision: { type: 'string', enum: ['accept', 'reject'] }, source: { type: 'string' }, notes: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.resumeResult', description: 'Owner-authorize exact replacement implementation tasks after an aggregate result rejection.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'children', 'decision', 'source', 'submissionId'], properties: { featureId: { type: 'string' }, children: { type: 'array', items: { type: 'object' } }, decision: { type: 'string' }, source: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.submitPlan', description: 'Save a task-bound plan and create authorized dependency-bound implementation slices within the owner-approved total budget.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId', 'expectedTaskRev', 'slices', 'submissionId'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' }, expectedTaskRev: { type: 'integer' }, slices: { type: 'array', items: { type: 'object' } }, submissionId: { type: 'string' } } } },
    { name: 'workflow.submitVerification', description: 'Persist exact read-only verification evidence for a feature implementation candidate and advance only verified work to owner result review.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId', 'expectedTaskRev', 'targetTaskId', 'candidate', 'checks', 'summary', 'submissionId'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' }, expectedTaskRev: { type: 'integer' }, targetTaskId: { type: 'string' }, candidate: { type: 'object' }, checks: { type: 'array', items: { type: 'object' } }, summary: { type: 'string' }, submissionId: { type: 'string' } } } },
    { name: 'workflow.continuation', description: 'Read exact verified same-feature dependency candidates for the current bound implementation task.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' } } } },
    { name: 'workflow.progress', description: 'Record a bounded task-bound workflow progress note without changing approval state.', roles: ['worker', 'system'], inputSchema: { type: 'object', additionalProperties: false, required: ['featureId', 'taskId', 'expectedTaskRev', 'summary'], properties: { featureId: { type: 'string' }, taskId: { type: 'string' }, expectedTaskRev: { type: 'integer' }, summary: { type: 'string' } } } },
  ];

  function project(projectId: string) { return store.require<Project>('project', projectId); }
  function feature(featureId: string) { return store.require<any>('workflow_feature', featureId); }
  function config(projectId: string) { return store.get<any>('workflow_config', projectId); }
  function spec(specId: string) { return store.require<Spec>('spec', specId); }
  function task(taskId: string) { return store.require<Task>('task', taskId); }
  function authorize(taskValue: Task, ownerApprovalId: string, owner: any) {
    const authorization = store.put('workflow_authorization', { id: `workflow_auth:${taskValue.id}`, projectId: taskValue.projectId, ownerApprovalId, owner, task: taskAuthorityShape(taskValue), createdAt: now() });
    return domain.call('task.authorizeChild', { taskId: taskValue.id, expectedRev: taskValue.rev, authorizationId: authorization.id }, { role: 'system', id: 'workflow' });
  }
  function featureUpdate(value: any, patch: Json, eventType = 'workflow.feature.updated') {
    const next = store.put('workflow_feature', { ...value, ...patch, updatedAt: now() }, value.rev); store.event(eventType, next.projectId, { featureId: next.id, phase: next.phase }); return next;
  }
  function projectionUpdate(value: any, patch: Json) {
    return store.tx(() => {
      const latest = feature(value.id);
      if (latest.rev !== value.rev) return null;
      return featureUpdate(latest, patch);
    });
  }
  function assertBound(actor: Actor, taskValue: Task, expectedTaskRev: number) { assert(taskValue.rev === expectedTaskRev, 'Stale task revision'); if (actor.role === 'worker') { assert(actor.taskId === taskValue.id, 'Worker may mutate only its bound task'); assert(!taskValue.workerId || taskValue.workerId === actor.id, 'Worker does not own task'); assert((taskValue as any).controller?.kind !== 'human', 'Task is under human control'); } }
  function submission(featureId: string, name: string, submissionId: string, input: Json, actor: Actor) {
    const owner = { id: actor.id, role: actor.role }; const id = `workflow_submission:${hash(JSON.stringify({ featureId, name, submissionId, owner }))}`; const prior = store.get<any>('workflow_submission', id); const signature = hash(JSON.stringify(input));
    if (prior) { assert(prior.signature === signature, 'submissionId was reused with different workflow content'); return { id, prior }; }
    return { id, signature };
  }
  function remember(value: { id: string; signature?: string }, result: any) { store.put('workflow_submission', { id: value.id, signature: value.signature, result, createdAt: now() }); return result; }
  function scopedTarget(projectValue: Project, path: unknown, label = 'change.path') {
    const relativePath = text(path, label, 400); assert(!isAbsolute(relativePath) && !relativePath.split('/').includes('..'), 'Change path must remain below the project root');
    const root = realpathSync(projectValue.root); const target = resolve(root, relativePath); const ancestor = (() => { let current = target; while (!existsSync(current)) { const parent = dirname(current); assert(parent !== current, 'Change path is unavailable'); current = parent; } return current; })();
    const actual = realpathSync(ancestor); const rel = relative(root, actual); assert(!rel.startsWith('..') && !isAbsolute(rel), 'Change path escapes the project root'); return { path: relativePath, root, target };
  }
  function canonicalPath(projectValue: Project, path: unknown) {
    const scoped = scopedTarget(projectValue, path); assert(projectValue.canonicalPaths.includes(scoped.path), 'Change path is not a registered canonical specification'); assert(existsSync(scoped.target), 'Change path is unavailable');
    const actual = realpathSync(scoped.target); const rel = relative(scoped.root, actual); assert(rel === scoped.path && !rel.startsWith('..') && !isAbsolute(rel), 'Change path escapes the project root'); return scoped.path;
  }
  function newCanonicalPath(projectValue: Project, path: unknown) {
    const scoped = scopedTarget(projectValue, path); assert(scoped.path.startsWith('spec/'), 'New workflow requirements must be proposed below spec/'); assert(!projectValue.canonicalPaths.includes(scoped.path), 'New workflow requirement path is already registered'); assert(!existsSync(scoped.target), 'New workflow requirement path already exists'); return scoped;
  }
  function writeCanonical(target: string, content: string, receiptId: string) { const temporary = `${target}.workflow-${hash(receiptId).slice(0, 12)}.tmp`; writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, target); }
  function writeNewCanonical(root: string, target: string, content: string) { mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); const parent = realpathSync(dirname(target)); const rel = relative(root, parent); assert(!rel.startsWith('..') && !isAbsolute(rel), 'New workflow requirement path escapes the project root'); writeFileSync(target, content, { mode: 0o600, flag: 'wx' }); }
  function recoverWorkflowFiles(projectValue: Project) {
    for (const receipt of store.list<any>('workflow_file_recovery').filter(value => value.projectId === projectValue.id && value.status === 'prepared')) {
      const documents = (receipt.documentIds ?? []).map((id: string) => store.get<any>('workflow_document', id));
      if (documents.length && documents.every((document: any) => document?.status === 'Accepted' && document.acceptedSpec?.hash === document.proposedHash)) { store.put('workflow_file_recovery', { ...receipt, status: 'committed', recoveredAt: now() }, receipt.rev); continue; }
      let recoverable = true;
      for (const file of receipt.files ?? []) {
        const scoped = scopedTarget(projectValue, file.path, 'recovery.path'); const target = scoped.target;
        if (file.existed === false) {
          if (existsSync(target)) { const current = hash(readFileSync(target, 'utf8')); if (current === file.proposedHash) unlinkSync(target); else recoverable = false; }
          continue;
        }
        if (!existsSync(target)) { recoverable = false; continue; }
        const current = hash(readFileSync(target, 'utf8'));
        if (current === file.proposedHash) writeCanonical(target, file.content, receipt.id);
        else if (current !== file.hash) recoverable = false;
      }
      const latest = store.require<any>('workflow_file_recovery', receipt.id);
      store.put('workflow_file_recovery', { ...latest, status: recoverable ? 'rolled_back' : 'recovery_required', recoveredAt: now() }, latest.rev);
      assert(recoverable, `Workflow canonical recovery needs owner attention: ${receipt.id}`);
    }
  }
  function enabledConfig(projectId: string) { const value = config(projectId); assert(value?.enabled === true, 'Workflow is not enabled for this project'); return value; }
  function preparationSpecs(projectValue: Project) {
    const latest = new Map<string, Spec>();
    for (const candidate of store.list<Spec>('spec').filter(item => item.projectId === projectValue.id && item.status === 'Accepted' && projectValue.canonicalPaths.includes(item.path))) {
      const previous = latest.get(candidate.path); if (!previous || candidate.rev > previous.rev || (candidate.rev === previous.rev && candidate.id > previous.id)) latest.set(candidate.path, candidate);
    }
    return [...latest.values()].sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id)).slice(0, 200).map(candidate => ({ id: candidate.id, path: candidate.path, hash: candidate.hash, rev: candidate.rev }));
  }

  function newFeature(idea: any, value: any) {
    const id = `feature:${hash(`${idea.projectId}:${idea.id}`).slice(0, 28)}`; const prior = store.get<any>('workflow_feature', id); if (prior) return prior;
    return store.put('workflow_feature', { id, projectId: idea.projectId, ideaId: idea.id, title: idea.title, description: idea.description, phase: idea.future === true ? 'future' : 'idea', configApprovalId: value.approvalId, linkedSpecIds: [...new Set((idea.links ?? []).map((link: any) => link.specId).filter((id: unknown) => typeof id === 'string'))], taskIds: [], documentIds: [], createdAt: now(), updatedAt: now() });
  }
  function createPreparation(value: any, workflowConfig: any, ownerApprovalId: string, reason?: string) {
    const baseline = spec(workflowConfig.baselineSpecId); assert(baseline.projectId === value.projectId && baseline.status === 'Accepted' && acceptedRequirements(baseline).length > 0, 'Configured baseline specification is not accepted and usable');
    const taskId = reason ? `workflow_requirements_revision:${value.id}:${hash(reason).slice(0, 12)}` : `workflow_requirements:${value.id}`;
    const existing = store.get<Task>('task', taskId); if (existing) return existing;
    const priorDrafts = store.list<any>('workflow_document').filter(document => document.featureId === value.id).map(document => ({ id: document.id, path: document.path, baseHash: document.baseHash, proposedHash: document.proposedHash, revisionNote: document.revisionNote, requestNote: document.requestNote }));
    const taskValue = domain.call('task.create', { id: taskId, projectId: value.projectId, specId: baseline.id, specHash: baseline.hash, requirements: acceptedRequirements(baseline), objective: `Prepare requirements: ${value.title}`, scope: `Feature ${value.id}\nIdea: ${value.description}\nPrepare the smallest coherent PRD amendment. Do not implement product behavior or accept requirements.${reason ? `\nRevision feedback: ${reason}` : ''}${priorDrafts.length ? `\nPrior proposal identities and notes: ${JSON.stringify(priorDrafts)}` : ''}\nUse only task-bound workflow.draftContext, workflow.proposeRequirements, context.build, checkpoint, and board.phase operations.`, criteria: ['Persist exact proposed PRD changes and a revision note for owner review'], permissions: [], budget: { ...workflowConfig.preparationBudget, workerProfile: workflowConfig.defaultProfile, context: workflowConfig.context }, deadline: futureDeadline(workflowConfig.maxRunMs), sourceCandidate: workflowConfig.sourceCandidate, runtime: dispatchRuntime(workflowConfig.defaultProfile), worktree: workflowConfig.worktree, resources: [], dependencies: [] }, { role: 'system', id: 'workflow' }) as Task;
    const acceptedSpecs = preparationSpecs(project(value.projectId)); assert(acceptedSpecs.some(item => item.id === baseline.id && item.hash === baseline.hash), 'Configured baseline specification is not among current accepted canonical specifications');
    const tagged = store.put<Task>('task', { ...taskValue, workflow: { featureId: value.id, purpose: 'requirements_preparation', preparationSpecs: acceptedSpecs, ...(reason ? { revisionReason: reason } : {}) } }, taskValue.rev);
    authorize(tagged, ownerApprovalId, workflowConfig.owner);
    return store.require<Task>('task', taskId);
  }
  function createVerification(value: any, target: Task) {
    assert(value.approvalId && value.reviewedSpec && target.state === 'Verifying' && target.candidate, 'Feature implementation is not ready for workflow verification');
    const taskId = `workflow_verify:${target.id}`; const existing = store.get<Task>('task', taskId); if (existing) return existing;
    const profile = value.implementationProfile ?? value.profile;
    const count = Math.max(1, (value.implementationTaskIds ?? []).length); const verificationBudget = { ...value.implementationBudget, maxExecutionMs: Math.max(1, Math.floor(value.verificationReserveMs / count)), workerProfile: profile, context: value.context, verificationOf: target.id };
    const created = domain.call('task.create', {
      id: taskId, projectId: value.projectId, specId: target.specId, specHash: target.specHash, requirements: target.requirements,
      objective: `Verify implementation candidate: ${target.objective}`,
      scope: `Read-only verification of task ${target.id} for feature ${value.id}. Verify only candidate ${canonical(target.candidate)} against the named criteria. Do not edit product files or accept a result.`,
      criteria: target.criteria, permissions: [], budget: verificationBudget, deadline: value.deadline,
      sourceCandidate: target.sourceCandidate, runtime: dispatchRuntime(profile as any), worktree: true, resources: [], dependencies: [],
    }, { role: 'system', id: 'workflow' }) as Task;
    const ownerApprovalId = target.inheritedAuthorization?.ownerApprovalId ?? value.approvalId; assert(typeof ownerApprovalId === 'string', 'Workflow verification lacks exact owner authorization'); const ownerApproval = store.require<any>('workflow_owner_approval', ownerApprovalId); assert(ownerApproval.projectId === value.projectId && ownerApproval.actor?.role === 'owner', 'Workflow verification owner authorization is invalid');
    const tagged = store.put<Task>('task', { ...created, workflow: { featureId: value.id, purpose: 'verification', targetTaskId: target.id, targetCandidate: target.candidate, sourceOwnerApprovalId: ownerApprovalId } }, created.rev);
    return authorize(tagged, ownerApprovalId, ownerApproval.actor).task;
  }
  function taskForFeature(value: any, taskValue: Task) { return featureUpdate(value, { taskIds: [...new Set([...value.taskIds, taskValue.id])] }); }
  function settleInternalTask(value: any, taskValue: Task) {
    if (taskValue.state !== 'Verifying') return false;
    const purpose = taskValue.workflow?.purpose;
    const reason = purpose === 'requirements_preparation' && (value.documentIds ?? []).length ? 'Requirements proposal is persisted for owner PRD review' : purpose === 'planning' && (value.slices ?? []).length ? 'Implementation slices are persisted for owner-authorized workflow execution' : purpose === 'verification' && !!store.get<any>('workflow_verification_submission', taskValue.id) ? 'Exact verification evidence is persisted against the implementation candidate' : null;
    if (!reason) return false;
    const id = `workflow_internal_completion:${taskValue.id}`; if (store.get<any>('workflow_internal_completion', id)) return false;
    store.tx(() => {
      store.put('workflow_internal_completion', { id, projectId: value.projectId, featureId: value.id, taskId: taskValue.id, purpose, reason, taskRev: taskValue.rev, at: now() });
      for (const inbox of store.list<any>('inbox').filter(item => item.projectId === value.projectId && item.status !== 'resolved' && item.data?.taskId === taskValue.id && ['verification needed', 'result review'].includes(String(item.kind).trim().toLowerCase()))) store.put('inbox', { ...inbox, status: 'resolved', resolution: reason, resolvedAt: now() }, inbox.rev);
      store.event('workflow.internal.completed', value.projectId, { featureId: value.id, taskId: taskValue.id, purpose });
    });
    return true;
  }

  async function configure(input: Json, actor: Actor) {
    const projectValue = project(text(input.projectId, 'projectId', 200));
    assert(typeof input.enabled === 'boolean', 'enabled must be boolean');
    const previous = config(projectValue.id);
    if (!input.enabled) {
      const approval = store.put('workflow_owner_approval', { id: `workflow_config_approval:${projectValue.id}:${(previous?.rev ?? 0) + 1}`, projectId: projectValue.id, kind: 'configuration', actor: { id: actor.id, role: actor.role }, decision: text(input.decision ?? 'Disable workflow', 'decision'), source: text(input.source ?? 'owner', 'source'), at: now() });
      const saved = store.put('workflow_config', { id: projectValue.id, projectId: projectValue.id, enabled: false, approvalId: approval.id, owner: approval.actor, configuredAt: now() }, previous?.rev); store.event('workflow.configured', projectValue.id, { enabled: false, approvalId: approval.id }); return saved;
    }
    const baseline = spec(text(input.baselineSpecId, 'baselineSpecId', 200)); assert(baseline.projectId === projectValue.id && baseline.status === 'Accepted' && acceptedRequirements(baseline).length > 0, 'baselineSpecId must select an accepted specification with requirements');
    const profile = await recommendations.validateProfile(object(input.defaultProfile, 'defaultProfile'), [], projectValue.id);
    const sourceCandidate = exactCommit(input.sourceCandidate); const maxRunMs = Number(input.maxRunMs); assert(Number.isFinite(maxRunMs) && maxRunMs >= 60_000 && maxRunMs <= 24 * 60 * 60_000, 'maxRunMs must be a bounded duration');
    const approval = store.put('workflow_owner_approval', { id: `workflow_config_approval:${projectValue.id}:${(previous?.rev ?? 0) + 1}`, projectId: projectValue.id, kind: 'configuration', actor: { id: actor.id, role: actor.role }, decision: text(input.decision, 'decision'), source: text(input.source, 'source'), at: now() });
    const saved = store.put('workflow_config', { id: projectValue.id, projectId: projectValue.id, enabled: true, baselineSpecId: baseline.id, defaultProfile: profile, sourceCandidate, maxRunMs, worktree: input.worktree, preparationBudget: budget(input.preparationBudget, 'preparationBudget'), planningBudget: budget(input.planningBudget, 'planningBudget'), implementationBudget: budget(input.implementationBudget, 'implementationBudget'), context: context(input.context), approvalId: approval.id, owner: approval.actor, configuredAt: now() }, previous?.rev);
    store.event('workflow.configured', projectValue.id, { enabled: true, approvalId: approval.id, baselineSpecId: baseline.id }); return saved;
  }

  function taskSummary(value: Task) { return { id: value.id, rev: value.rev, title: value.objective, state: value.state, specId: value.specId, specHash: value.specHash, requirements: value.requirements, runtime: value.runtime ?? null, profile: value.budget?.workerProfile ?? null, deadline: value.deadline ?? null, dependencies: value.dependencies, candidate: value.candidate ?? null, resultReview: value.resultReview ?? null, waitingReasons: value.waitingReasons ?? [], internalCompletion: store.get<any>('workflow_internal_completion', `workflow_internal_completion:${value.id}`) ?? null }; }
  function documentSummary(value: any) { return { id: value.id, rev: value.rev, path: value.path, newDocument: value.newDocument === true, baseSpecId: value.baseSpecId, baseHash: value.baseHash, proposedHash: value.proposedHash, revisionNote: value.revisionNote, requestNote: value.requestNote ?? null, status: value.status, acceptedSpec: value.acceptedSpec ?? null, submittedAt: value.submittedAt, acceptedAt: value.acceptedAt ?? null }; }
  function list(input: Json) {
    if (input.projectId !== undefined) project(text(input.projectId, 'projectId', 200));
    return store.list<any>('workflow_feature').filter(value => !input.projectId || value.projectId === input.projectId).map(value => ({
      ...value,
      documents: (value.documentIds ?? []).map((id: string) => store.get<any>('workflow_document', id)).filter(Boolean).map(documentSummary),
      tasks: (value.taskIds ?? []).map((id: string) => store.get<Task>('task', id)).filter(Boolean).map(taskSummary),
    }));
  }
  function review(input: Json) {
    const value = feature(text(input.featureId, 'featureId', 200));
    const documents = (value.documentIds ?? []).map((documentId: string) => {
      const document = store.require<any>('workflow_document', documentId); const base = document.baseSpecId ? spec(document.baseSpecId) : null;
      if (base) assert(base.projectId === value.projectId && base.path === document.path && base.hash === document.baseHash, 'Workflow draft base snapshot is inconsistent');
      else assert(document.newDocument === true && document.baseHash === null, 'Workflow draft new-document snapshot is inconsistent');
      return {
        ...documentSummary(document),
        base: base ? { id: base.id, rev: base.rev, path: base.path, hash: base.hash, status: base.status, content: base.content } : null,
        proposed: { hash: document.proposedHash, content: document.content },
      };
    });
    const specIds = [...new Set([...(value.linkedSpecIds ?? []), ...(value.acceptedSpecs ?? []).map((item: any) => item.id), ...documents.map((item: any) => item.acceptedSpec?.id).filter((item: unknown): item is string => typeof item === 'string')])];
    const specs = specIds.map(specId => spec(specId)).filter(item => item.projectId === value.projectId).map(item => ({ id: item.id, path: item.path, hash: item.hash, rev: item.rev, status: item.status, requirementIds: item.requirementIds, acceptedRequirementIds: item.acceptedRequirementIds ?? item.requirementIds, content: item.content }));
    return { feature: { ...value, documents: undefined }, documents, specs, tasks: (value.taskIds ?? []).map((id: string) => store.get<Task>('task', id)).filter(Boolean).map(taskSummary) };
  }

  function tick(input: Json) {
    if (input.projectId !== undefined) project(text(input.projectId, 'projectId', 200));
    const created: string[] = []; const advanced: string[] = []; const skipped: string[] = [];
    for (const workflowConfig of store.list<any>('workflow_config').filter(value => value.enabled === true && (!input.projectId || value.projectId === input.projectId))) {
      for (const idea of store.list<any>('idea').filter(value => value.projectId === workflowConfig.projectId && value.future !== true)) {
        let value = newFeature(idea, workflowConfig);
        if (value.documentIds.length || value.approvalId) continue;
        const linkedTasks = (idea.links ?? []).map((link: any) => typeof link.taskId === 'string' ? store.get<Task>('task', link.taskId) : undefined).filter(Boolean) as Task[];
        const linkedAcceptedSpec = (value.linkedSpecIds ?? []).map((specId: string) => store.get<Spec>('spec', specId)).find((candidate: Spec | undefined) => candidate?.status === 'Accepted');
        if (!value.preparationTaskId && linkedTasks.length) { const running = linkedTasks.some(taskValue => taskValue.state === 'Running' || taskValue.state === 'Verifying'); const approved = linkedTasks.some(taskValue => taskValue.state === 'Approved'); const review = linkedTasks.some(taskValue => taskValue.state === 'Needs result review'); value = featureUpdate(value, { phase: running ? 'implementing' : approved ? 'ready' : review ? 'result_review' : linkedTasks.every(taskValue => taskValue.state === 'Accepted') ? 'done' : 'blocked', waitingFor: approved ? 'implementation' : null, boardTaskId: linkedTasks[0].id, implementationTaskIds: linkedTasks.map(taskValue => taskValue.id), taskIds: [...new Set([...(value.taskIds ?? []), ...linkedTasks.map(taskValue => taskValue.id)])] }); continue; }
        if (linkedAcceptedSpec) { featureUpdate(value, { phase: 'prd_review' }); continue; }
        if (!value.preparationTaskId) {
          try { const prep = createPreparation(value, workflowConfig, workflowConfig.approvalId); value = taskForFeature(featureUpdate(value, { preparationTaskId: prep.id, phase: 'preparing_prd' }), prep); store.put('idea', { ...idea, links: [...(idea.links ?? []), { taskId: prep.id }] }, idea.rev); created.push(value.id); } catch { skipped.push(value.id); }
        }
      }
    }
    for (const value of store.list<any>('workflow_feature').filter(item => !input.projectId || item.projectId === input.projectId)) {
      let current = value;
      const initialTasks = (current.taskIds ?? []).map((taskId: string) => store.get<Task>('task', taskId)).filter(Boolean) as Task[];
      for (const target of initialTasks.filter(item => !!current.approvalId && item.workflow?.featureId === current.id && (current.implementationTaskIds ?? []).includes(item.id) && item.state === 'Verifying' && item.candidate)) {
        const verification = createVerification(current, target);
        if (!(current.taskIds ?? []).includes(verification.id)) {
          current = taskForFeature(featureUpdate(current, { verificationTaskIds: [...new Set([...(current.verificationTaskIds ?? []), verification.id])], verificationByTarget: { ...(current.verificationByTarget ?? {}), [target.id]: verification.id } }, 'workflow.verification.queued'), verification);
          created.push(current.id);
        }
      }
      const tasks = (current.taskIds ?? []).map((taskId: string) => store.get<Task>('task', taskId)).filter(Boolean) as Task[];
      for (const taskValue of tasks) if (settleInternalTask(current, taskValue)) advanced.push(current.id);
      const children = tasks.filter(item => (current.implementationTaskIds ?? []).includes(item.id));
      const stopped = (taskValue: Task | undefined) => !!taskValue && ['Paused', 'Blocked', 'Failed', 'Canceled', 'Superseded'].includes(taskValue.state);
      let phase = current.phase; let waitingFor: string | null = current.waitingFor ?? null;
      const documents = (current.documentIds ?? []).map((id: string) => store.get<any>('workflow_document', id)).filter(Boolean);
      const preparation = current.preparationTaskId ? store.get<Task>('task', current.preparationTaskId) : undefined;
      if (!current.approvalId && documents.length && documents.some((document: any) => document.status === 'Changes requested')) {
        if (stopped(preparation)) { phase = 'blocked'; waitingFor = null; }
        else { phase = 'preparing_prd'; waitingFor = 'requirements revision'; }
      }
      else if (!current.approvalId && documents.length) { phase = 'prd_review'; waitingFor = null; }
      else if (!current.approvalId && preparation && stopped(preparation)) { phase = 'blocked'; waitingFor = null; }
      else if (!current.approvalId && preparation && ['Approved', 'Running', 'Verifying'].includes(preparation.state)) { phase = 'preparing_prd'; waitingFor = preparation.state === 'Running' ? null : 'requirements preparation'; }
      else if (children.length && children.some(stopped)) { phase = 'blocked'; waitingFor = null; }
      else if (current.verificationFailure) { phase = 'blocked'; waitingFor = null; }
      else if (children.length && children.every(item => item.state === 'Accepted')) { const workflowChildren = children.every(item => item.workflow?.featureId === current.id); if (workflowChildren && current.aggregateResult?.decision !== 'accept') { phase = 'blocked'; waitingFor = null; } else { phase = 'done'; waitingFor = null; } }
      else if (children.length && children.every(item => item.state === 'Needs result review')) { phase = 'result_review'; waitingFor = null; }
      else if (children.length && children.some(item => item.state === 'Running')) { phase = 'implementing'; waitingFor = null; }
      else if (children.length && children.some(item => item.state === 'Verifying')) {
        const verificationTasks = children.filter(item => item.state === 'Verifying').map(item => current.verificationByTarget?.[item.id]).filter(Boolean).map((id: string) => store.get<Task>('task', id));
        if (verificationTasks.some(stopped)) { phase = 'blocked'; waitingFor = null; }
        else { phase = 'verifying'; waitingFor = null; }
      }
      else if (children.length) { phase = 'ready'; waitingFor = 'implementation'; }
      else if (current.directTaskId) { const direct = tasks.find(item => item.id === current.directTaskId); if (stopped(direct)) { phase = 'blocked'; waitingFor = null; } else if (direct?.state === 'Running') { phase = 'implementing'; waitingFor = null; } else if (direct?.state === 'Approved') { phase = 'ready'; waitingFor = 'implementation'; } }
      else if (current.planTaskId) { const plan = task(current.planTaskId); if (stopped(plan)) { phase = 'blocked'; waitingFor = null; } else if (plan.state === 'Running') { phase = 'planning'; waitingFor = null; } else if (plan.state === 'Approved') { phase = 'ready'; waitingFor = 'planner'; } }
      if ((phase !== current.phase || waitingFor !== (current.waitingFor ?? null)) && phases.has(phase)) { if (projectionUpdate(current, { phase, waitingFor })) advanced.push(current.id); }
    }
    return { created, advanced, skipped, at: now() };
  }

  function proposeRequirements(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const taskValue = task(text(input.taskId, 'taskId', 200)); assert(value.preparationTaskId === taskValue.id, 'Task is not this feature requirements preparation'); const changeRows = Array.isArray(input.changes) ? input.changes : []; assert(changeRows.length > 0 && changeRows.length <= 12, 'changes must contain 1 to 12 documents'); assert(changeRows.reduce((total, change: any) => total + Buffer.byteLength(typeof change?.content === 'string' ? change.content : '', 'utf8'), 0) <= 200_000, 'Combined proposed document content is limited to 200KB'); const revisionNote = text(input.revisionNote, 'revisionNote', 8_000); const submissionValue = submission(value.id, 'proposeRequirements', text(input.submissionId, 'submissionId', 200), { changes: changeRows, revisionNote, summary: input.summary ?? null, expectedTaskRev: input.expectedTaskRev }, actor); if (submissionValue.prior) return submissionValue.prior.result; assertBound(actor, taskValue, input.expectedTaskRev); assert(taskValue.state === 'Running', 'Requirements proposal task is not running');
    const projectValue = project(value.projectId); const documents = store.tx(() => changeRows.map((change: any) => {
      const content = typeof change.content === 'string' ? change.content : ''; assert(content.length > 0 && Buffer.byteLength(content, 'utf8') <= 200_000, 'change.content must be nonempty and at most 200KB');
      const isNew = change.baseSpecId === undefined && change.baseHash === undefined;
      if (isNew) {
        const scoped = newCanonicalPath(projectValue, change.path); const id = `workflow_document:${hash(JSON.stringify({ featureId: value.id, path: scoped.path, content, newDocument: true }))}`;
        return store.get<any>('workflow_document', id) ?? store.put('workflow_document', { id, featureId: value.id, projectId: value.projectId, path: scoped.path, baseSpecId: null, baseHash: null, newDocument: true, proposedHash: hash(content), content, revisionNote, status: 'Draft', submittedBy: { id: actor.id, role: actor.role }, submittedAt: now() });
      }
      assert(change.baseSpecId !== undefined && change.baseHash !== undefined, 'Existing workflow requirements changes need both baseSpecId and baseHash');
      const path = canonicalPath(projectValue, change.path); const baseSpec = spec(text(change.baseSpecId, 'change.baseSpecId', 200)); const baseHash = text(change.baseHash, 'change.baseHash', 128);
      assert(baseSpec.projectId === value.projectId && baseSpec.path === path && baseSpec.hash === baseHash && baseSpec.status === 'Accepted', 'Change base revision is stale or belongs to another canonical document');
      const id = `workflow_document:${hash(JSON.stringify({ featureId: value.id, path, baseSpecId: baseSpec.id, baseHash, content }))}`; return store.get<any>('workflow_document', id) ?? store.put('workflow_document', { id, featureId: value.id, projectId: value.projectId, path, baseSpecId: baseSpec.id, baseHash, newDocument: false, proposedHash: hash(content), content, revisionNote, status: 'Draft', submittedBy: { id: actor.id, role: actor.role }, submittedAt: now() });
    }));
    assert(new Set(documents.map((document: any) => document.path)).size === documents.length, 'Workflow draft paths must be unique');
    const next = featureUpdate(value, { documentIds: documents.map(item => item.id), revisionNote, phase: 'prd_review' }, 'workflow.requirements.proposed');
    const inbox = store.put('inbox', { id: `workflow_prd_review:${next.id}:${hash(next.documentIds.join(','))}`, projectId: next.projectId, kind: 'prd review', summary: `Review proposed requirements: ${next.title}`, data: { featureId: next.id, documentIds: next.documentIds, revisionNote }, status: 'pending', createdAt: now() });
    return remember(submissionValue, { feature: next, documents, inbox });
  }

  function draftContext(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const taskValue = task(text(input.taskId, 'taskId', 200)); assert(value.preparationTaskId === taskValue.id, 'Task is not the current feature requirements revision'); if (actor.role === 'worker') assertBound(actor, taskValue, taskValue.rev);
    return { featureId: value.id, idea: { title: value.title, description: value.description }, revisionNote: value.revisionNote ?? null, documents: store.list<any>('workflow_document').filter(document => document.featureId === value.id).map(document => ({ id: document.id, path: document.path, newDocument: document.newDocument === true, baseSpecId: document.baseSpecId, baseHash: document.baseHash, proposedHash: document.proposedHash, content: document.content, revisionNote: document.revisionNote, requestNote: document.requestNote ?? null, status: document.status })) };
  }

  function requestChanges(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const documentId = text(input.documentId, 'documentId', 200); const note = text(input.note, 'note', 8_000); const submissionValue = submission(value.id, 'requestChanges', text(input.submissionId, 'submissionId', 200), { documentId, expectedRev: input.expectedRev, note }, actor); if (submissionValue.prior) return submissionValue.prior.result; const document = store.require<any>('workflow_document', documentId); assert(document.featureId === value.id && document.rev === input.expectedRev && document.status === 'Draft', 'Draft document is stale or belongs to another feature');
    const workflowConfig = enabledConfig(value.projectId); const changed = store.put('workflow_document', { ...document, status: 'Changes requested', requestedBy: { id: actor.id, role: actor.role }, requestNote: note, requestedAt: now() }, document.rev);
    const currentPreparation = value.preparationTaskId ? store.get<Task>('task', value.preparationTaskId) : undefined;
    const reusable = currentPreparation?.workflow?.featureId === value.id && currentPreparation?.workflow?.purpose === 'requirements_preparation' && !!currentPreparation?.workflow?.revisionReason && ['Approved', 'Running'].includes(currentPreparation?.state ?? '');
    if (reusable && currentPreparation) { const next = featureUpdate(value, { phase: 'preparing_prd', revisionNote: note }, 'workflow.requirements.revision.updated'); return remember(submissionValue, { feature: next, task: currentPreparation, document: changed }); }
    const ownerApproval = store.put('workflow_owner_approval', { id: `workflow_revision_approval:${value.id}:${changed.rev}`, projectId: value.projectId, kind: 'requirements_revision', actor: { id: actor.id, role: actor.role }, sourceOwnerApprovalId: workflowConfig.approvalId, note, at: now() });
    const prep = createPreparation(value, workflowConfig, ownerApproval.id, `${changed.id}:${note}`); const next = taskForFeature(featureUpdate(value, { preparationTaskId: prep.id, phase: 'preparing_prd', revisionNote: note }), prep); return remember(submissionValue, { feature: next, task: prep, document: changed });
  }

  function acceptRequirements(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const rows = Array.isArray(input.documents) ? input.documents : []; assert(rows.length > 0 && rows.length === (value.documentIds ?? []).length, 'Every current workflow draft document must be reviewed together');
    const submissionValue = submission(value.id, 'acceptRequirements', text(input.submissionId, 'submissionId', 200), { documents: rows, decision: input.decision, source: input.source }, actor); if (submissionValue.prior) return submissionValue.prior.result;
    const decisionText = text(input.decision, 'decision'); const sourceText = text(input.source, 'source');
    const byId = new Map(rows.map((row: any) => [text(row.documentId, 'documentId', 200), row])); assert(byId.size === rows.length && [...byId.keys()].every(id => value.documentIds.includes(id)), 'Review documents do not match the current feature drafts');
    const projectValue = project(value.projectId); recoverWorkflowFiles(projectValue);
    const receiptId = `workflow_file_recovery:${hash(`${value.id}:${submissionValue.id}`)}`;
    const persistedDocuments = [...byId.entries()].map(([documentId]) => store.require<any>('workflow_document', documentId));
    if (persistedDocuments.every(document => document.featureId === value.id && document.status === 'Accepted' && document.acceptedSpec?.hash === document.proposedHash)) {
      const receipt = store.get<any>('workflow_file_recovery', receiptId); assert(receipt?.submissionId === submissionValue.id && receipt.submissionSignature === submissionValue.signature, 'Workflow acceptance replay has no matching durable receipt');
      assert(persistedDocuments.every((document, index) => document.acceptedFromRev === rows[index]?.expectedRev), 'Workflow acceptance replay is stale');
      return store.tx(() => {
        const accepted = persistedDocuments.map(document => ({ document, spec: spec(document.acceptedSpec.id), approval: store.require<any>('approval', document.acceptedSpec.approvalId) }));
        const currentReceipt = store.require<any>('workflow_file_recovery', receiptId); if (currentReceipt.status !== 'committed') store.put('workflow_file_recovery', { ...currentReceipt, status: 'committed', committedAt: now() }, currentReceipt.rev);
        const next = featureUpdate(value, { phase: 'prd_review', linkedSpecIds: [...new Set([...value.linkedSpecIds, ...accepted.map(item => item.spec.id)])], acceptedSpecs: accepted.map(item => ({ id: item.spec.id, hash: item.spec.hash, rev: item.spec.rev, path: item.spec.path })) }, 'workflow.requirements.accepted.reconciled');
        for (const inbox of store.list<any>('inbox').filter(item => item.projectId === value.projectId && item.kind === 'prd review' && item.data?.featureId === value.id && item.status !== 'resolved')) store.put('inbox', { ...inbox, status: 'resolved', resolution: 'workflow requirements accepted', resolvedAt: now() }, inbox.rev);
        return remember(submissionValue, { feature: next, accepted });
      });
    }
    const documents = [...byId.entries()].map(([documentId, row]) => {
      const document = store.require<any>('workflow_document', documentId); assert(document.featureId === value.id && document.status === 'Draft' && document.rev === row.expectedRev, 'Workflow draft is stale');
      if (document.newDocument === true) {
        const scoped = newCanonicalPath(projectValue, document.path); const requirementIds = [`workflow:${value.id}:${scoped.path}`];
        return { document, path: scoped.path, target: scoped.target, root: scoped.root, content: null, baseSpec: null, requirementIds, existed: false };
      }
      const path = canonicalPath(projectValue, document.path); const target = resolve(projectValue.root, path); const baseSpec = spec(document.baseSpecId); assert(baseSpec.projectId === value.projectId && baseSpec.path === path && baseSpec.hash === document.baseHash, 'Workflow draft base is inconsistent'); const content = readFileSync(target, 'utf8'); assert(hash(content) === document.baseHash, 'Canonical requirements changed after this draft was prepared'); const requirementIds = baseSpec.requirementIds.length ? baseSpec.requirementIds : [`workflow:${value.id}:${path}`]; return { document, path, target, root: realpathSync(projectValue.root), content, baseSpec, requirementIds, existed: true };
    });
    assert(new Set(documents.map(item => item.path)).size === documents.length, 'Workflow draft paths must be unique');
    const existingReceipt = store.get<any>('workflow_file_recovery', receiptId);
    const receipt = existingReceipt ? (existingReceipt.submissionId === undefined ? store.put('workflow_file_recovery', { ...existingReceipt, submissionId: submissionValue.id, submissionSignature: submissionValue.signature }, existingReceipt.rev) : existingReceipt) : store.put('workflow_file_recovery', { id: receiptId, projectId: value.projectId, featureId: value.id, submissionId: submissionValue.id, submissionSignature: submissionValue.signature, documentIds: documents.map(item => item.document.id), files: documents.map(item => ({ path: item.path, existed: item.existed, hash: item.document.baseHash, proposedHash: item.document.proposedHash, content: item.content })), status: 'prepared', preparedAt: now() });
    assert(receipt.submissionId === submissionValue.id && receipt.submissionSignature === submissionValue.signature, 'Workflow acceptance receipt belongs to another submission');
    let accepted: any[];
    try {
      for (const item of documents) { if (item.existed) writeCanonical(item.target, item.document.content, receipt.id); else writeNewCanonical(item.root, item.target, item.document.content); }
      const result = store.tx(() => {
        const currentProject = project(value.projectId); const additions = documents.filter(item => !item.existed).map(item => item.path);
        if (additions.length) domain.call('project.update', { projectId: currentProject.id, expectedRev: currentProject.rev, canonicalPaths: [...currentProject.canonicalPaths, ...additions] }, actor);
        accepted = documents.map(item => {
          const captured = domain.call('spec.capture', { projectId: value.projectId, path: item.path, requirementIds: item.requirementIds }, actor) as Spec; assert(captured.hash === item.document.proposedHash && captured.status === 'Draft', 'Canonical capture does not match the reviewed workflow draft');
          const decision = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, requirementIds: captured.requirementIds, decision: decisionText, source: sourceText }, actor) as { spec: Spec; approval: any };
          const document = store.put('workflow_document', { ...item.document, status: 'Accepted', acceptedFromRev: item.document.rev, acceptedSpec: { id: decision.spec.id, hash: decision.spec.hash, rev: decision.spec.rev, approvalId: decision.approval.id }, acceptedAt: now(), acceptedBy: actor.id }, item.document.rev); return { document, spec: decision.spec, approval: decision.approval };
        });
        const currentReceipt = store.require<any>('workflow_file_recovery', receipt.id); store.put('workflow_file_recovery', { ...currentReceipt, status: 'committed', committedAt: now() }, currentReceipt.rev);
        const next = featureUpdate(value, { phase: 'prd_review', linkedSpecIds: [...new Set([...value.linkedSpecIds, ...accepted.map(item => item.spec.id)])], acceptedSpecs: accepted.map(item => ({ id: item.spec.id, hash: item.spec.hash, rev: item.spec.rev, path: item.spec.path })) }, 'workflow.requirements.accepted');
        for (const inbox of store.list<any>('inbox').filter(item => item.projectId === value.projectId && item.kind === 'prd review' && item.data?.featureId === value.id && item.status !== 'resolved')) store.put('inbox', { ...inbox, status: 'resolved', resolution: 'workflow requirements accepted', resolvedAt: now() }, inbox.rev);
        return remember(submissionValue, { feature: next, accepted });
      });
      return result;
    } catch (error) {
      let recoverable = true;
      for (const item of documents) {
        if (!existsSync(item.target)) { if (item.existed) recoverable = false; continue; }
        const current = hash(readFileSync(item.target, 'utf8'));
        if (current === item.document.proposedHash) { if (item.existed) writeCanonical(item.target, item.content!, receipt.id); else unlinkSync(item.target); }
        else if (current !== item.document.baseHash) recoverable = false;
      }
      const latest = store.require<any>('workflow_file_recovery', receipt.id); store.put('workflow_file_recovery', { ...latest, status: recoverable ? 'rolled_back' : 'recovery_required', recoveredAt: now() }, latest.rev); throw error;
    }
  }

  async function approve(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const submissionValue = submission(value.id, 'approve', text(input.submissionId, 'submissionId', 200), structuredClone(input), actor); if (submissionValue.prior) return submissionValue.prior.result; assert(value.phase === 'prd_review', 'Feature is not awaiting PRD review'); const workflowConfig = enabledConfig(value.projectId); const reviewed = spec(text(input.specId, 'specId', 200)); assert(reviewed.projectId === value.projectId && reviewed.status === 'Accepted' && reviewed.hash === text(input.specHash, 'specHash', 128) && reviewed.rev === input.specRev, 'Reviewed specification revision is stale or not accepted');
    const documents = (value.documentIds ?? []).map((documentId: string) => store.require<any>('workflow_document', documentId)); const linkedAcceptedSpec = (value.linkedSpecIds ?? []).includes(reviewed.id); const primaryDraft = documents.find((document: any) => document.acceptedSpec?.id === reviewed.id && document.acceptedSpec?.hash === reviewed.hash); assert((documents.length > 0 && documents.every((document: any) => document.status === 'Accepted') && !!primaryDraft) || linkedAcceptedSpec, 'The accepted canonical revision does not match the owner-reviewed workflow drafts'); const approvedSpecs = documents.length ? documents.map((document: any) => ({ id: document.acceptedSpec.id, hash: document.acceptedSpec.hash, rev: document.acceptedSpec.rev, path: document.path })) : [{ id: reviewed.id, hash: reviewed.hash, rev: reviewed.rev, path: reviewed.path }];
    const permissions = strings(input.permissions, 'permissions'); const profile = await recommendations.validateProfile(object(input.profile, 'profile'), permissions, value.projectId); const planningProfile = input.planningProfile === undefined ? await recommendations.validateProfile(profile, [], value.projectId) : await recommendations.validateProfile(object(input.planningProfile, 'planningProfile'), [], value.projectId); const implementationProfile = input.implementationProfile === undefined ? profile : await recommendations.validateProfile(object(input.implementationProfile, 'implementationProfile'), permissions, value.projectId); const sourceCandidate = input.sourceCandidate === undefined ? workflowConfig.sourceCandidate : exactCommit(input.sourceCandidate); const direct = input.directImplementation === true; const defaultDeadline = featureDeadline(workflowConfig, direct); const deadline = input.deadline === undefined ? defaultDeadline : text(input.deadline, 'deadline', 80); assert(Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) >= Date.parse(defaultDeadline), 'deadline must cover the owner-approved sequential execution budget');
    const objective = text(input.objective, 'objective', 1_000); const scope = text(input.scope, 'scope', 8_000); const criteria = strings(input.criteria, 'criteria'); const requirements = acceptedRequirements(reviewed); assert(requirements.length > 0, 'Reviewed specification needs accepted requirements');
    const executionBudget = implementationBudgetSplit(workflowConfig.implementationBudget);
    const ownerApproval = store.put('workflow_owner_approval', { id: `workflow_feature_approval:${value.id}:${reviewed.id}:${reviewed.rev}`, projectId: value.projectId, kind: 'feature', actor: { id: actor.id, role: actor.role }, decision: text(input.decision, 'decision'), source: text(input.source, 'source'), featureId: value.id, specId: reviewed.id, specHash: reviewed.hash, specRev: reviewed.rev, approvedSpecs, profile, planningProfile, implementationProfile, directImplementation: direct, scope, criteria, permissions, sourceCandidate, deadline, context: workflowConfig.context, implementationBudget: executionBudget.total, implementationWorkBudget: executionBudget.work, verificationReserveMs: executionBudget.verificationReserveMs, at: now() });
    const taskProfile = direct ? implementationProfile : planningProfile; const taskId = direct ? `workflow_implementation:${value.id}` : `workflow_plan:${value.id}`; const existing = store.get<Task>('task', taskId); const taskValue = existing ?? domain.call('task.create', { id: taskId, projectId: value.projectId, specId: reviewed.id, specHash: reviewed.hash, requirements, objective: direct ? objective : `Plan implementation: ${objective}`, scope: direct ? `${scope}\n\nPlan internally before editing. Remain within this approved scope.` : `${scope}\n\nProduce dependency-bound implementation slices only. Do not implement product behavior.`, criteria: direct ? [...criteria, 'Record the internal plan before editing'] : ['Persist bounded implementation slices with dependencies, ownership, and budget totals'], permissions: direct ? permissions : [], budget: { ...(direct ? executionBudget.work : workflowConfig.planningBudget), workerProfile: taskProfile, context: workflowConfig.context }, deadline, sourceCandidate, runtime: dispatchRuntime(taskProfile as any), worktree: input.worktree ?? workflowConfig.worktree, resources: [], dependencies: [] }, { role: 'system', id: 'workflow' }) as Task;
    const tagged = store.put<Task>('task', { ...taskValue, workflow: { featureId: value.id, purpose: direct ? 'direct_implementation' : 'planning', internalPlanRequired: direct } }, taskValue.rev); const authorized = existing?.state === 'Approved' ? existing : authorize(tagged, ownerApproval.id, ownerApproval.actor).task;
    const next = taskForFeature(featureUpdate(value, { phase: 'ready', waitingFor: direct ? 'implementation' : 'planner', approvalId: ownerApproval.id, worktree: taskValue.worktree, reviewedSpec: { id: reviewed.id, hash: reviewed.hash, rev: reviewed.rev }, approvedSpecs, profile, planningProfile, implementationProfile, directImplementation: direct, sourceCandidate, deadline, scope, criteria, permissions, requirements, context: workflowConfig.context, implementationBudget: executionBudget.total, implementationWorkBudget: executionBudget.work, verificationReserveMs: executionBudget.verificationReserveMs, ...(direct ? { directTaskId: authorized.id, implementationTaskIds: [authorized.id] } : { planTaskId: authorized.id }) }), authorized);
    return remember(submissionValue, { feature: next, task: authorized, approval: ownerApproval });
  }

  function reviewResult(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const rows = Array.isArray(input.children) ? input.children : []; const decision = text(input.decision, 'decision', 20); assert(decision === 'accept' || decision === 'reject', 'decision must be accept or reject'); const source = text(input.source, 'source'); const notes = input.notes === undefined ? undefined : text(input.notes, 'notes', 8_000);
    const submissionValue = submission(value.id, 'reviewResult', text(input.submissionId, 'submissionId', 200), { children: rows, decision, source, notes: notes ?? null }, actor); if (submissionValue.prior) return submissionValue.prior.result;
    const childIds = value.implementationTaskIds ?? []; assert(childIds.length > 0 && rows.length === childIds.length, 'Every feature implementation child requires an exact result decision'); const byId = new Map(rows.map((row: any) => [text(row.taskId, 'child.taskId', 200), row])); assert(byId.size === rows.length && [...byId.keys()].every(id => childIds.includes(id)), 'Result decisions do not match the feature implementation children');
    const children = childIds.map((taskId: string) => { const child = task(taskId); const row = byId.get(taskId)!; const candidate = object(row.candidate, 'child.candidate'); assert(child.projectId === value.projectId && child.workflow?.featureId === value.id && child.state === 'Needs result review' && child.rev === row.expectedRev && canonical(child.candidate) === canonical(candidate), 'Feature child result is stale or not verified'); return child; });
    const receiptId = `workflow_result_review:${hash(`${value.id}:${submissionValue.id}`)}`;
    return store.tx(() => {
      for (const child of children) store.put('workflow_result_review_gate', { id: `workflow_result_review_gate:${child.id}`, projectId: value.projectId, featureId: value.id, taskId: child.id, taskRev: child.rev, candidate: child.candidate, owner: { id: actor.id, role: actor.role }, receiptId, at: now() });
      const reviewed = children.map((child: Task) => domain.call('task.review', { taskId: child.id, expectedRev: child.rev, candidate: child.candidate, decision, source, notes }, actor));
      const receipt = store.put('workflow_result_review', { id: receiptId, projectId: value.projectId, featureId: value.id, decision, source, notes: notes ?? null, actor: { id: actor.id, role: actor.role }, children: reviewed.map((result: any) => ({ taskId: result.task.id, taskRev: result.task.rev, candidate: result.task.candidate, reviewId: result.review.id })), at: now() });
      const next = featureUpdate(value, { phase: decision === 'accept' ? 'done' : 'blocked', aggregateResult: { id: receipt.id, decision, at: receipt.at } }, 'workflow.result.reviewed');
      return remember(submissionValue, { feature: next, receipt, children: reviewed });
    });
  }

  function resumeResult(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const rows = Array.isArray(input.children) ? input.children : []; const decision = text(input.decision, 'decision', 4_000); const source = text(input.source, 'source'); const submissionValue = submission(value.id, 'resumeResult', text(input.submissionId, 'submissionId', 200), { children: rows, decision, source }, actor); if (submissionValue.prior) return submissionValue.prior.result;
    assert(value.aggregateResult?.decision === 'reject' && value.approvalId, 'Feature has no rejected aggregate result to resume'); const priorApproval = store.require<any>('workflow_owner_approval', value.approvalId); assert(priorApproval.projectId === value.projectId && priorApproval.kind === 'feature' && priorApproval.actor?.role === 'owner', 'Feature lacks an exact owner work approval');
    const childIds = value.implementationTaskIds ?? []; assert(childIds.length > 0 && rows.length === childIds.length, 'Every rejected feature implementation child requires an exact rework decision'); const byId = new Map(rows.map((row: any) => [text(row.taskId, 'child.taskId', 200), row])); assert(byId.size === rows.length && [...byId.keys()].every(id => childIds.includes(id)), 'Rework decisions do not match the feature implementation children');
    const children: Task[] = childIds.map((taskId: string) => { const child = task(taskId); const row = byId.get(taskId)!; const candidate = object(row.candidate, 'child.candidate'); assert(child.projectId === value.projectId && child.workflow?.featureId === value.id && child.state === 'Blocked' && child.resultReview?.decision === 'reject' && child.rev === row.expectedRev && canonical(child.candidate) === canonical(candidate), 'Rejected feature child is stale or not eligible for rework'); return child; });
    const originalDeadline = text(value.deadline, 'feature.deadline', 80); const reworkBudget = budget(value.implementationBudget, 'feature.implementationBudget'); const deadline = futureDeadline(reworkBudget.maxExecutionMs); const reworkSources = new Map(children.map((child: Task) => { const commit = child.candidate?.materializedCommit; assert(typeof commit === 'string' && commitPattern.test(commit), 'Rejected feature candidate has no exact materialized commit for safe rework'); return [child.id, { commit, rejectedCandidate: child.candidate.id }]; }));
    return store.tx(() => {
      const receiptId = `workflow_result_rework:${hash(`${value.id}:${submissionValue.id}`)}`; const reworkApproval = store.put('workflow_owner_approval', { id: `workflow_result_rework_approval:${value.id}:${hash(submissionValue.id).slice(0, 20)}`, projectId: value.projectId, kind: 'result_rework', actor: { id: actor.id, role: actor.role }, sourceOwnerApprovalId: value.approvalId, featureId: value.id, decision, source, children: children.map(child => ({ taskId: child.id, taskRev: child.rev, candidate: child.candidate, reworkSource: reworkSources.get(child.id) })), scope: value.scope, criteria: value.criteria, permissions: value.permissions, sourceCandidate: value.sourceCandidate, originalDeadline, deadline, profile: value.implementationProfile ?? value.profile, implementationBudget: value.implementationBudget, at: now() });
      const replacementIds = new Map<string, string>(children.map((child: Task) => [child.id, `workflow_rework:${child.id}:${hash(submissionValue.id).slice(0, 12)}`]));
      const replacements: Task[] = children.map((child: Task) => {
        const replacement = domain.call('task.create', { id: replacementIds.get(child.id), projectId: child.projectId, specId: child.specId, specHash: child.specHash, requirements: child.requirements, objective: child.objective, scope: `${child.scope}\n\nOwner result review feedback: ${child.resultReview?.notes ?? decision}`, criteria: child.criteria, permissions: child.permissions, budget: child.budget, deadline, sourceCandidate: reworkSources.get(child.id), runtime: child.runtime, worktree: true, resources: child.resources, dependencies: child.dependencies.map((dependency: string) => replacementIds.get(dependency) ?? dependency) }, { role: 'system', id: 'workflow' }) as Task;
        const tagged = store.put<Task>('task', { ...replacement, workflow: { ...child.workflow, reworkOf: child.id, reworkApprovalId: reworkApproval.id } }, replacement.rev); return authorize(tagged, reworkApproval.id, reworkApproval.actor).task;
      });
      const receipt = store.put('workflow_result_rework', { id: receiptId, projectId: value.projectId, featureId: value.id, actor: { id: actor.id, role: actor.role }, sourceOwnerApprovalId: value.approvalId, reworkApprovalId: reworkApproval.id, decision, source, replacements: replacements.map((taskValue: Task, index: number) => ({ rejectedTaskId: children[index].id, rejectedTaskRev: children[index].rev, taskId: taskValue.id, taskRev: taskValue.rev })), at: now() });
      const directReplacement = value.directTaskId ? replacements.find((taskValue: Task, index: number) => children[index].id === value.directTaskId) : undefined;
      const { verificationFailure: _verificationFailure, ...withoutVerificationFailure } = value;
      const next = featureUpdate(withoutVerificationFailure, { phase: 'ready', waitingFor: 'implementation', deadline, implementationTaskIds: replacements.map((taskValue: Task) => taskValue.id), taskIds: [...new Set([...(value.taskIds ?? []), ...replacements.map((taskValue: Task) => taskValue.id)])], ...(directReplacement ? { directTaskId: directReplacement.id } : {}), aggregateResult: { id: receipt.id, decision: 'rework', at: receipt.at }, rework: { receiptId: receipt.id, sourceOwnerApprovalId: value.approvalId, originalDeadline, deadline, at: receipt.at } }, 'workflow.result.rework.authorized');
      return remember(submissionValue, { feature: next, replacements: replacements.map((taskValue: Task, index: number) => ({ rejectedTaskId: children[index].id, task: taskValue })), receipt });
    });
  }

  function submitPlan(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const planTask = task(text(input.taskId, 'taskId', 200)); assert(value.planTaskId === planTask.id && value.directImplementation !== true, 'Task is not this feature planning task'); const rows = Array.isArray(input.slices) ? input.slices : []; assert(rows.length > 0 && rows.length <= 12, 'slices must contain 1 to 12 items'); const submissionValue = submission(value.id, 'submitPlan', text(input.submissionId, 'submissionId', 200), { slices: rows, expectedTaskRev: input.expectedTaskRev }, actor); if (submissionValue.prior) return submissionValue.prior.result; assertBound(actor, planTask, input.expectedTaskRev); assert(planTask.state === 'Running', 'Planning task is not running');
    const normalized = rows.map((row: any) => ({ id: text(row.id, 'slice.id', 100), objective: text(row.objective, 'slice.objective', 1_000), scope: text(row.scope, 'slice.scope', 8_000), criteria: strings(row.criteria, 'slice.criteria'), requirements: strings(row.requirements, 'slice.requirements'), permissions: strings(row.permissions, 'slice.permissions'), budget: budget(row.budget, 'slice.budget'), dependencies: strings(row.dependencies ?? [], 'slice.dependencies'), worktree: value.worktree ?? null, requestedWorktree: row.worktree }));
    assert(new Set(normalized.map(row => row.id)).size === normalized.length, 'Slice IDs must be unique'); const sliceIds = new Set(normalized.map(row => row.id)); for (const row of normalized) { assert(row.requestedWorktree === undefined || canonical(row.requestedWorktree) === canonical(value.worktree ?? null), 'Slice worktree differs from the owner-approved feature worktree'); assert(row.requirements.every(requirement => value.requirements.includes(requirement)), 'Slice requirements exceed the owner-approved feature'); assert(row.permissions.every(permission => value.permissions.includes(permission)), 'Slice permissions exceed the owner-approved feature'); assert(row.dependencies.every(dependency => sliceIds.has(dependency) && dependency !== row.id), 'Slice dependency is invalid'); }
    const bySliceId = new Map(normalized.map(row => [row.id, row])); const ordered: typeof normalized = []; const visiting = new Set<string>(); const visited = new Set<string>(); const visit = (row: typeof normalized[number]) => { if (visited.has(row.id)) return; assert(!visiting.has(row.id), 'Slice dependencies contain a cycle'); visiting.add(row.id); for (const dependency of row.dependencies) visit(bySliceId.get(dependency)!); visiting.delete(row.id); visited.add(row.id); ordered.push(row); }; for (const row of normalized) visit(row);
    const total = normalized.reduce((sum, row) => sum + row.budget.maxExecutionMs, 0); assert(total <= (value.implementationWorkBudget ?? value.implementationBudget).maxExecutionMs, 'Implementation slices exceed the owner-approved execution budget after its verification reserve');
    const created = store.tx(() => ordered.map(row => {
      const taskId = `workflow_implementation:${value.id}:${row.id}`; const dependencyIds = row.dependencies.map(dependency => `workflow_implementation:${value.id}:${dependency}`); let taskValue = store.get<Task>('task', taskId);
      if (!taskValue) { const implementationProfile = value.implementationProfile ?? value.profile; taskValue = domain.call('task.create', { id: taskId, projectId: value.projectId, specId: value.reviewedSpec.id, specHash: value.reviewedSpec.hash, requirements: row.requirements, objective: row.objective, scope: row.scope, criteria: row.criteria, permissions: row.permissions, budget: { ...row.budget, workerProfile: implementationProfile, context: value.context }, deadline: value.deadline, sourceCandidate: value.sourceCandidate, runtime: dispatchRuntime(implementationProfile as any), worktree: row.worktree ?? undefined, resources: [], dependencies: dependencyIds }, { role: 'system', id: 'workflow' }) as Task; taskValue = store.put<Task>('task', { ...taskValue, workflow: { featureId: value.id, purpose: 'implementation_slice', sliceId: row.id, planTaskId: planTask.id } }, taskValue.rev); taskValue = authorize(taskValue, value.approvalId, store.require<any>('workflow_owner_approval', value.approvalId).actor).task; }
      assert(taskValue, 'Workflow implementation task was not created'); return taskValue;
    }));
    const next = featureUpdate(value, { phase: 'ready', waitingFor: 'implementation', slices: normalized.map(({ requestedWorktree, ...row }) => ({ ...row, taskId: `workflow_implementation:${value.id}:${row.id}` })), implementationTaskIds: created.map(item => item.id), taskIds: [...new Set([...value.taskIds, ...created.map(item => item.id)])] }, 'workflow.plan.submitted'); return remember(submissionValue, { feature: next, tasks: created });
  }

  function verificationChecks(input: unknown, target: Task) {
    assert(Array.isArray(input) && input.length === target.criteria.length && input.length > 0, 'Verification must report every target criterion exactly once');
    const rows = input.map((value: any) => ({ check: text(value?.check, 'verification.check', 1_000), result: text(value?.result, 'verification.result', 20), details: value?.details === undefined ? {} : object(value.details, 'verification.details') }));
    assert(rows.every(row => row.result === 'pass' || row.result === 'fail'), 'Verification result must be pass or fail');
    assert(new Set(rows.map(row => row.check)).size === rows.length && rows.every(row => target.criteria.includes(row.check)), 'Verification checks must exactly match the target criteria');
    return rows;
  }
  function submitVerification(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const verification = task(text(input.taskId, 'taskId', 200)); const target = task(text(input.targetTaskId, 'targetTaskId', 200));
    assert(verification.workflow?.featureId === value.id && verification.workflow?.purpose === 'verification' && verification.workflow?.targetTaskId === target.id, 'Task is not this feature verification task');
    const submissionValue = submission(value.id, 'submitVerification', text(input.submissionId, 'submissionId', 200), { taskId: verification.id, targetTaskId: target.id, candidate: input.candidate, checks: input.checks, summary: input.summary, expectedTaskRev: input.expectedTaskRev }, actor); if (submissionValue.prior) return submissionValue.prior.result;
    assertBound(actor, verification, input.expectedTaskRev); assert(verification.state === 'Running', 'Verification task is not running'); assert(target.state === 'Verifying' && !!target.candidate, 'Implementation target is not awaiting verification');
    const candidate = object(input.candidate, 'candidate'); assert(candidate.specHash === target.specHash && canonical(candidate) === canonical(target.candidate), 'Verification candidate is stale');
    const checks = verificationChecks(input.checks, target); const summary = text(input.summary, 'summary', 4_000);
    const evidence = checks.map(row => domain.call('evidence.record', { taskId: target.id, candidate: target.candidate, specHash: target.specHash, check: row.check, environment: `workflow verification ${verification.id}`, result: row.result, details: { ...row.details, featureId: value.id, verificationTaskId: verification.id, summary }, artifacts: [], notes: summary }, { role: 'system', id: `workflow-verification:${verification.id}` }));
    if (checks.some(row => row.result === 'fail')) {
      const failed = featureUpdate(value, { phase: 'blocked', verificationFailure: { taskId: verification.id, targetTaskId: target.id, candidate: target.candidate, summary, at: now() } }, 'workflow.verification.failed');
      store.put('workflow_verification_submission', { id: verification.id, projectId: value.projectId, featureId: value.id, taskId: verification.id, targetTaskId: target.id, targetTaskRev: target.rev, candidate: target.candidate, checks, summary, outcome: 'fail', at: now() });
      const inbox = store.put('inbox', { id: `workflow_verification_failed:${verification.id}:${target.rev}`, projectId: value.projectId, kind: 'workflow verification failed', summary: `Verification failed for ${target.objective}`, data: { featureId: value.id, taskId: target.id, verificationTaskId: verification.id, candidate: target.candidate }, status: 'pending', createdAt: now() });
      return remember(submissionValue, { feature: failed, target, evidence, verified: false, inbox });
    }
    const verified = domain.call('task.verify', { taskId: target.id, expectedRev: target.rev, candidate: target.candidate, specHash: target.specHash }, { role: 'system', id: `workflow-verification:${verification.id}` }) as Task;
    store.put('workflow_verification_submission', { id: verification.id, projectId: value.projectId, featureId: value.id, taskId: verification.id, targetTaskId: verified.id, targetTaskRev: verified.rev, candidate: verified.candidate, checks, summary, outcome: 'pass', at: now() });
    const continuations = store.list<Task>('task').filter(candidateTask => candidateTask.projectId === value.projectId && candidateTask.workflow?.featureId === value.id && candidateTask.dependencies.includes(verified.id)).map(candidateTask => store.put('workflow_continuation', { id: `workflow_continuation:${verified.id}:${candidateTask.id}`, projectId: value.projectId, featureId: value.id, targetTaskId: verified.id, targetTaskRev: verified.rev, successorTaskId: candidateTask.id, candidate: verified.candidate, specId: verified.specId, specHash: verified.specHash, verificationTaskId: verification.id, ownerApprovalId: verified.inheritedAuthorization?.ownerApprovalId ?? value.approvalId, verifiedAt: now() }));
    const next = featureUpdate(value, { phase: 'verifying', verificationFailure: undefined }, 'workflow.verification.submitted');
    return remember(submissionValue, { feature: next, target: verified, evidence, verified: true, continuations });
  }
  function continuation(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const successor = task(text(input.taskId, 'taskId', 200)); assert(successor.workflow?.featureId === value.id, 'Task does not belong to this feature'); if (actor.role === 'worker') assertBound(actor, successor, successor.rev);
    const dependencies = successor.dependencies.map(dependencyId => store.get<any>('workflow_continuation', `workflow_continuation:${dependencyId}:${successor.id}`)).filter(Boolean).map(record => ({ taskId: record.targetTaskId, taskRev: record.targetTaskRev, candidate: record.candidate, specId: record.specId, specHash: record.specHash, verificationTaskId: record.verificationTaskId, verifiedAt: record.verifiedAt }));
    return { featureId: value.id, taskId: successor.id, dependencies };
  }

  function progress(input: Json, actor: Actor) {
    const value = feature(text(input.featureId, 'featureId', 200)); const taskValue = task(text(input.taskId, 'taskId', 200)); assert((value.taskIds ?? []).includes(taskValue.id), 'Task does not belong to this feature'); assertBound(actor, taskValue, input.expectedTaskRev); const note = text(input.summary, 'summary', 1_000); const record = store.put('workflow_progress', { id: `workflow_progress:${value.id}:${taskValue.id}:${taskValue.rev}`, featureId: value.id, projectId: value.projectId, taskId: taskValue.id, summary: note, actor: { id: actor.id, role: actor.role }, at: now() }); store.event('workflow.progress', value.projectId, { featureId: value.id, taskId: taskValue.id }); return record;
  }

  function attachApprovedTask(taskValue: Task) {
    const workflowConfig = config(taskValue.projectId); if (!workflowConfig?.enabled || taskValue.state !== 'Approved') return null;
    const linkedIdea = store.list<any>('idea').find(idea => idea.projectId === taskValue.projectId && (idea.links ?? []).some((link: any) => link.taskId === taskValue.id)); if (!linkedIdea) return null;
    const value = newFeature(linkedIdea, workflowConfig); if ((value.taskIds ?? []).includes(taskValue.id)) return value;
    return taskForFeature(featureUpdate(value, { phase: 'ready', waitingFor: 'implementation', boardTaskId: taskValue.id, implementationTaskIds: [...new Set([...(value.implementationTaskIds ?? []), taskValue.id])] }), taskValue);
  }

  async function call(action: string, input: Json = {}, actor: Actor) {
    const descriptor = actions().find(item => item.name === action); assert(descriptor, `Unknown workflow action: ${action}`); assert(descriptor.roles.includes(actor.role), `Role ${actor.role} cannot call ${action}`);
    if (action === 'workflow.configure') return configure(input, actor); if (action === 'workflow.list') return list(input); if (action === 'workflow.review') return review(input); if (action === 'workflow.tick') return tick(input); if (action === 'workflow.proposeRequirements') return proposeRequirements(input, actor); if (action === 'workflow.draftContext') return draftContext(input, actor); if (action === 'workflow.requestChanges') return requestChanges(input, actor); if (action === 'workflow.acceptRequirements') return acceptRequirements(input, actor); if (action === 'workflow.approve') return approve(input, actor); if (action === 'workflow.reviewResult') return reviewResult(input, actor); if (action === 'workflow.resumeResult') return resumeResult(input, actor); if (action === 'workflow.submitPlan') return submitPlan(input, actor); if (action === 'workflow.submitVerification') return submitVerification(input, actor); if (action === 'workflow.continuation') return continuation(input, actor); return progress(input, actor);
  }
  return { actions, call, tick, attachApprovedTask };
}
