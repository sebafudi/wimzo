import { assertTechnicalTask } from './launch-policy.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Store, assert, hash, id, now, type RecordValue } from './store.ts';
import { approvedWorkflowFeature } from './workflow-authority.ts';
import { contextBudget } from './worker-context.ts';

export type Role = 'owner' | 'guide' | 'worker' | 'system';
export type Actor = { role: Role; id: string; taskId?: string };
type Json = Record<string, any>;
type Project = RecordValue & { name: string; root: string; purpose: string; canonicalPaths: string[]; specIds: string[] };
type Spec = RecordValue & { projectId: string; path: string; hash: string; content: string; status: 'Draft' | 'Accepted' | 'Superseded' | 'Retired'; requirementIds: string[]; acceptedRequirementIds?: string[]; previousId?: string; diff?: Json; capturedAt: string; acceptedAt?: string };
type TaskState = 'Needs approval' | 'Approved' | 'Running' | 'Verifying' | 'Needs result review' | 'Accepted' | 'Paused' | 'Blocked' | 'Failed' | 'Canceled' | 'Superseded';
type Task = RecordValue & { projectId: string; specId: string; specHash: string; requirements: string[]; objective: string; criteria: string[]; scope: string; permissions: string[]; budget: Json; deadline?: string; sourceCandidate?: Json; runtime?: string; capability?: string; capabilityInput?: Json; worktree?: string; resources: string[]; priority: number; state: TaskState; waitingReasons: string[]; dependencies: string[]; workerId?: string; runId?: string; candidate?: Json; requested?: Json; acknowledged?: Json; pausedFrom?: TaskState; stopped?: Json; controller?: Json; lastController?: Json; dimensions: Json; createdBy: Json; workflow?: Json; inheritedAuthorization?: Json };
type Run = RecordValue & { taskId: string; projectId: string; runtime?: string; runType: 'technical' | 'script' | 'gui'; purpose?: 'implementation' | 'verification'; workerId?: string; resources: string[]; worktree?: string; state: 'Running' | 'Paused' | 'Completed' | 'Canceled' | 'Failed'; startedAt: string; endedAt?: string };

const technicalStates = new Set(['Running']);
const terminalStates = new Set<TaskState>(['Accepted', 'Canceled', 'Superseded']);
const allRoles: Role[] = ['owner', 'guide', 'worker', 'system'];
const schemas: Record<string, Json> = {
  'project.register': { required: ['name', 'root', 'purpose'] },
  'project.update': { required: ['projectId', 'expectedRev'] }, 'project.list': {}, 'project.get': { required: ['projectId'] },
  'spec.capture': { required: ['projectId', 'path'] },
  'spec.list': { required: ['projectId'] }, 'spec.accept': { required: ['specId', 'hash', 'expectedRev', 'decision', 'source'] }, 'spec.retire': { required: ['specId', 'expectedRev', 'decision', 'source'] },
  'task.create': { required: ['projectId', 'specId', 'specHash', 'requirements', 'objective', 'criteria', 'scope', 'permissions', 'budget'] },
  'task.approve': { required: ['taskId', 'expectedRev', 'decision', 'source'] }, 'task.authorizeChild': { required: ['taskId', 'expectedRev', 'authorizationId'] }, 'task.setDeadline': { required: ['taskId', 'expectedRev', 'deadline', 'decision', 'source'] }, 'task.queue': { required: ['taskId', 'expectedRev'] }, 'task.reprioritize': { required: ['taskId', 'expectedRev', 'priority', 'decision'] },
  'task.claim': { required: ['taskId', 'expectedRev'] }, 'task.claimVerification': { required: ['taskId', 'expectedRev'] }, 'task.waiting': { required: ['taskId'] },
  'task.control': { required: ['taskId', 'expectedRev', 'command'] }, 'task.ack': { required: ['taskId', 'expectedRev', 'command'] }, 'task.fail': { required: ['taskId', 'expectedRev', 'reason'] }, 'task.block': { required: ['taskId', 'expectedRev', 'reason'] },
  'task.workerResult': { required: ['taskId', 'runId', 'candidate', 'summary', 'expectedTaskRev'] },
  'task.verify': { required: ['taskId', 'expectedRev', 'candidate', 'specHash'] },
  'task.review': { required: ['taskId', 'expectedRev', 'candidate', 'decision', 'source'] },
  'task.get': { required: ['taskId'] }, 'task.list': {},
  'evidence.record': { required: ['taskId', 'candidate', 'specHash', 'check', 'environment', 'result'] }, 'evidence.list': { required: ['taskId'] },
  'release.decide': { required: ['taskId', 'candidate', 'decision', 'source'] }, 'release.record': { required: ['taskId', 'candidate', 'operation', 'evidence', 'version'] }, 'release.list': { required: ['projectId'] }, 'release.observations': { required: ['projectId'] }, 'feature.map': { required: ['projectId'] },
  'triage.classify': { required: ['projectId', 'classification', 'summary'] }, 'triage.list': { required: ['projectId'] }, 'triage.resolve': { required: ['triageId', 'resolution'] },
  'outside.observe': { required: ['projectId', 'revision', 'summary'] },
  'decision.record': { required: ['projectId', 'summary'] }, 'decision.list': { required: ['projectId'] },
  'context.build': { required: ['projectId'] }, 'context.receipt': { required: ['receiptId'] },
  'context.freshness': { required: ['receiptId'] },
  'checkpoint.get': { required: ['checkpointId'] }, 'checkpoint.list': {},
  'dispatch.pause': { required: ['projectId', 'decision'] }, 'dispatch.resume': { required: ['projectId', 'decision'] }, 'dispatch.status': { required: ['projectId'] },
  'conversation.focus': { required: ['conversationId', 'projectId'] }, 'conversation.get': { required: ['conversationId'] },
  'inbox.create': { required: ['projectId', 'kind', 'summary'] }, 'inbox.list': {}, 'inbox.deliver': { required: ['inboxId', 'expectedRev'] }
};

const roles: Record<string, Role[]> = {
  'project.register': ['owner'], 'project.update': ['owner'], 'project.list': allRoles, 'project.get': allRoles,
  'spec.capture': ['owner', 'guide', 'system'], 'spec.list': allRoles, 'spec.accept': ['owner'], 'spec.retire': ['owner'],
  'task.create': ['owner', 'guide', 'system'], 'task.approve': ['owner'], 'task.authorizeChild': ['system'], 'task.setDeadline': ['owner'], 'task.queue': ['owner', 'guide', 'system'], 'task.reprioritize': ['owner'],
  'task.claim': ['system', 'worker'], 'task.claimVerification': ['system', 'worker'], 'task.waiting': allRoles, 'task.control': ['owner', 'system'], 'task.ack': ['system', 'worker'], 'task.fail': ['system'], 'task.block': ['system'],
  'task.workerResult': ['system', 'worker'], 'task.verify': ['system', 'worker'], 'task.review': ['owner'], 'task.get': allRoles, 'task.list': allRoles,
  'evidence.record': ['system', 'worker'], 'evidence.list': allRoles, 'release.decide': ['owner'], 'release.record': ['system'], 'release.list': allRoles, 'release.observations': allRoles, 'feature.map': allRoles,
  'triage.classify': ['owner', 'guide', 'system'], 'triage.list': allRoles, 'triage.resolve': ['owner', 'guide'], 'decision.record': ['owner', 'guide'], 'decision.list': ['owner', 'guide'],
  'outside.observe': ['owner', 'guide', 'system'],
  'context.build': allRoles, 'context.receipt': allRoles, 'context.freshness': allRoles, 'checkpoint.get': allRoles, 'checkpoint.list': allRoles, 'dispatch.pause': ['owner'], 'dispatch.resume': ['owner'], 'dispatch.status': allRoles, 'conversation.focus': ['owner', 'guide', 'system'], 'conversation.get': allRoles,
  'inbox.create': ['owner', 'guide', 'system'], 'inbox.list': allRoles, 'inbox.deliver': ['owner', 'guide', 'system']
};

function requireObject(input: unknown): Json { assert(!!input && typeof input === 'object' && !Array.isArray(input), 'Input must be an object'); return input as Json; }
function strings(value: unknown, label: string): string[] { assert(Array.isArray(value) && value.every(v => typeof v === 'string'), `${label} must be string array`); return [...new Set(value)]; }
function expected(input: Json): number { assert(Number.isInteger(input.expectedRev), 'expectedRev is required'); return input.expectedRev; }
function diff(before: string | undefined, after: string): Json {
  if (before === undefined) return { before: null, after: hash(after), changed: true, lines: [{ op: 'add', text: after }] };
  if (before === after) return { before: hash(before), after: hash(after), changed: false, lines: [] };
  const oldLines = before.split('\n'); const newLines = after.split('\n');
  return { before: hash(before), after: hash(after), changed: true, lines: [{ op: 'remove', text: oldLines.join('\n') }, { op: 'add', text: newLines.join('\n') }] };
}
const requirementPattern = '\\b(?:H-\\d{3}|DS-\\d{3}|DS-PILOT-\\d{3})\\b';
function requirementIds(content: string): string[] { return [...new Set(content.match(new RegExp(requirementPattern, 'g')) ?? [])]; }
function ruleBlocks(content: string): Map<string, string> {
  const found = [...content.matchAll(new RegExp(`^(?:\\*\\*(${requirementPattern.slice(2, -2)})\\s+[^\\n]*\\*\\*|##\\s+(${requirementPattern.slice(2, -2)})[^\\n]*)[\\s\\S]*?(?=^(?:\\*\\*(?:${requirementPattern.slice(2, -2)})\\s|##\\s+(?:${requirementPattern.slice(2, -2)})\\b)|^## |(?![\\s\\S]))`, 'gm'))];
  return new Map(found.map(m => [m[1] ?? m[2], m[0].trim()]));
}
function canonicalJson(value: any): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function sameCandidate(left: any, right: any) { return canonicalJson(left) === canonicalJson(right); }
function provenance(input: Json) { assert(typeof input.decision === 'string' && input.decision.trim(), 'decision is required'); assert(typeof input.source === 'string' && input.source.trim(), 'source is required'); return { decision: input.decision.trim(), source: input.source.trim() }; }

export function Domain(store: Store) {
  const fieldDetails: Record<string, Json> = {
    projectId: { type: 'string', description: 'Stable managed-project ID.' }, taskId: { type: 'string', description: 'Stable task ID.' }, specId: { type: 'string', description: 'Captured specification snapshot ID.' }, expectedRev: { type: 'integer', description: 'Current record revision for compare-and-swap.' }, expectedTaskRev: { type: 'integer', description: 'Current task revision for result compare-and-swap.' },
    name: { type: 'string', description: 'Human-readable project name.' }, root: { type: 'string', description: 'Existing absolute project root.' }, purpose: { type: 'string', description: 'Short project purpose.' },
    affectedRequirements: { type: 'array', items: { type: 'string' }, description: 'Requirement IDs affected by an outside observation.' },
    budget: { type: 'object', description: 'Bounded execution budget.' }, candidate: { type: 'object', description: 'Exact candidate identity, including its spec hash.' }, sourceCandidate: { type: 'object', description: 'Candidate reference from which this task was created.' }, capabilityInput: { type: 'object', description: 'Structured input for a named script capability.' }, evidence: { type: 'object', description: 'Structured evidence or release observation.' }, checkpoint: { type: 'object', description: 'Checkpoint data acknowledged by the worker.' }, details: { type: 'object', description: 'Optional structured evidence details.' }, artifacts: { type: 'array', items: { type: 'object' }, description: 'Optional structured artifact references, including hashes when available.' },
    canonicalPaths: { type: 'array', items: { type: 'string' }, description: 'Canonical specification paths.' }, requirementIds: { type: 'array', items: { type: 'string' }, description: 'Requirement IDs.' }, requirements: { type: 'array', items: { type: 'string' }, description: 'Requirement IDs.' }, criteria: { type: 'array', items: { type: 'string' }, description: 'Named checks.' }, permissions: { type: 'array', items: { type: 'string' }, description: 'Authorized permissions.' }, resources: { type: 'array', items: { type: 'string' }, description: 'Exclusive resources.' }, dependencies: { type: 'array', items: { type: 'string' }, description: 'Predecessor task IDs.' }, openQuestions: { type: 'array', items: { type: 'string' }, description: 'Conversation open questions.' }, focus: { type: 'object', description: 'Conversation focus.' }, handoff: { oneOf: [{ type: 'string' }, { type: 'object' }], description: 'Saved conversation handoff text or structured data.' }, data: { type: 'object', description: 'Inbox structured data.' }, omittedCategories: { type: 'array', items: { type: 'string' }, description: 'Context categories intentionally omitted.' },
    runtime: { type: 'string', description: 'Execution runtime name.' }, runType: { type: 'string', description: 'technical, script, or gui capacity class.' }, worktree: { oneOf: [{ type: 'string' }, { type: 'boolean' }], description: 'Exclusive worktree resource path, or false when no worktree is required.' }, specHash: { type: 'string', description: 'Exact reviewed specification SHA-256.' }, deadline: { type: 'string', description: 'Future ISO-8601 deadline bound to a task.' }, decision: { type: 'string', description: 'Nonempty human decision text.' }, source: { type: 'string', description: 'Nonempty provenance source for a decision.' }, notes: { type: 'string', description: 'Optional explanatory notes.' }, command: { type: 'string', description: 'Executed verification command or task control command.' }, environment: { type: 'string', description: 'Named verification environment.' }, check: { type: 'string', description: 'Named acceptance criterion or check.' }, result: { type: 'string', description: 'Observed check result, such as pass or fail.' }, priority: { type: 'integer', description: 'Scheduling priority.' },
  };
  fieldDetails.checks = { type: 'array', description: 'Worker-reported checks.' };
  fieldDetails.unresolved = { type: 'array', description: 'Worker-reported unresolved questions.' };
  fieldDetails.usage = { type: 'object', description: 'Reported runtime usage and unknowns.' };
  const actionFieldDetails: Record<string, Record<string, Json>> = {
    'triage.classify': { evidence: { type: 'array', description: 'Structured evidence references for the triage record.' } },
    'triage.resolve': { evidence: { type: 'array', description: 'Evidence references for the resolution.' } },
    'outside.observe': { evidence: { type: 'array', description: 'Structured observed evidence references.' } },
    'release.record': { evidence: { type: 'object', description: 'Structured evidence for the observed release operation.' } },
    'spec.capture': { movedFrom: { type: 'string', description: 'Prior path of a moved document.' } },
    'task.control': { command: { type: 'string', enum: ['pause', 'cancel', 'checkpoint', 'resume', 'takeover', 'release'], description: 'takeover stops agent input, then gives the owner exclusive control of the preserved worktree; release checkpoints the human changes for an owner resume.' } },
  };
  const actionDetails: Record<string, string> = {
    'project.register': 'Register a managed project and its canonical specification paths.', 'project.update': 'Update owner-managed project metadata or append canonical specification paths.', 'spec.capture': 'Capture an immutable hash snapshot from a registered canonical file.', 'spec.accept': 'Accept an exact reviewed specification snapshot with recorded provenance.', 'task.create': 'Create a bounded task against accepted requirements and named criteria.', 'task.authorizeChild': 'Authorize an exact workflow child from a recorded owner workflow approval.', 'task.setDeadline': 'Set a missing or expired deadline on an otherwise unchanged task awaiting approval.', 'task.claim': 'Atomically claim an approved task if capacity and resources are available.', 'evidence.record': 'Record exact-candidate verification evidence and structured artifacts.', 'task.verify': 'Require passing evidence for every named criterion before owner review.', 'feature.map': 'Map accepted requirement intent to task implementation, verification, acceptance, and release state.', 'context.build': 'Build a source-receipted context from relevant accepted rules.',
    'decision.list': 'List project decisions.',
  };
  const actionFields: Record<string, string[]> = {
    'project.register':['id','name','root','purpose','canonicalPaths'], 'project.update':['projectId','expectedRev','name','root','purpose','canonicalPaths'],
    'project.list':[], 'project.get':['projectId','taskId'], 'spec.capture':['projectId','path','requirementIds','sourceRevision','movedFrom'], 'spec.list':['projectId','taskId'],
    'spec.accept':['specId','hash','expectedRev','requirementIds','decision','source'], 'spec.retire':['specId','expectedRev','decision','source'],
    'task.create':['id','projectId','specId','specHash','requirements','objective','criteria','scope','permissions','budget','deadline','sourceCandidate','runtime','capability','capabilityInput','worktree','resources','priority','dependencies'],
    'task.approve':['taskId','expectedRev','decision','source'], 'task.authorizeChild':['taskId','expectedRev','authorizationId'], 'task.setDeadline':['taskId','expectedRev','deadline','decision','source'], 'task.queue':['taskId','expectedRev','runType','resources','worktree'], 'task.reprioritize':['taskId','expectedRev','priority','decision'],
    'task.claim':['taskId','expectedRev','workerId','runtime','runType','resources','worktree'], 'task.claimVerification':['taskId','expectedRev','workerId','runtime','runType','resources','worktree'], 'task.waiting':['taskId','runType','resources','worktree'],
    'task.control':['taskId','expectedRev','command'], 'task.ack':['taskId','expectedRev','command','checkpoint'], 'task.fail':['taskId','expectedRev','runId','reason','checkpoint'], 'task.block':['taskId','expectedRev','runId','reason','checkpoint'], 'task.workerResult':['taskId','runId','candidate','summary','expectedTaskRev','checks','artifacts','unresolved','usage','exitReason'],
    'task.verify':['taskId','expectedRev','candidate','specHash'], 'task.review':['taskId','expectedRev','candidate','decision','source','notes'], 'task.get':['taskId'], 'task.list':['projectId'],
    'evidence.record':['taskId','candidate','specHash','check','environment','result','details','artifacts','command','notes','at'], 'evidence.list':['taskId'], 'release.decide':['taskId','candidate','decision','source','version','notes'],
    'release.record':['taskId','candidate','operation','evidence','version'], 'release.list':['projectId','taskId'], 'release.observations':['projectId','taskId'], 'feature.map':['projectId','taskId'],
    'triage.classify':['projectId','classification','summary','evidence','requirements','status'], 'triage.list':['projectId','taskId'], 'triage.resolve':['triageId','expectedRev','resolution','evidence'], 'outside.observe':['projectId','revision','summary','evidence','affectedRequirements','behavior'],
    'decision.record':['projectId','summary','requirements','source','status'], 'decision.list':['projectId'], 'context.build':['projectId','taskId','requirementIds','omittedCategories'], 'context.receipt':['receiptId','taskId'], 'context.freshness':['receiptId','taskId'],
    'checkpoint.get':['checkpointId','taskId'], 'checkpoint.list':['taskId'], 'dispatch.pause':['projectId','decision'], 'dispatch.resume':['projectId','decision'], 'dispatch.status':['projectId','taskId'],
    'conversation.focus':['conversationId','projectId','expectedRev','focus','openQuestions','handoff'], 'conversation.get':['conversationId','taskId'], 'inbox.create':['projectId','kind','summary','data'], 'inbox.list':['projectId','status'], 'inbox.deliver':['inboxId','expectedRev','status']
  };
  function descriptor(name: string) { const base = schemas[name]; const keys = actionFields[name] ?? base.required ?? []; return { name, description: actionDetails[name] ?? name.replaceAll('.', ' '), roles: roles[name], inputSchema: { type: 'object', additionalProperties: false, required: base.required ?? [], properties: Object.fromEntries(keys.map(key => [key, actionFieldDetails[name]?.[key] ?? fieldDetails[key] ?? { type: 'string', description: `${key} value.` }])) } }; }
  function event(type: string, projectId: string | null, data: Json, key?: string) { return store.event(type, projectId, data, key); }
  function project(projectId: string): Project { return store.require<Project>('project', projectId); }
  function task(taskId: string): Task { return store.require<Task>('task', taskId); }
  function spec(specId: string): Spec { return store.require<Spec>('spec', specId); }
  function taskAuthorityShape(value: Task) { const shape = {
    id: value.id, projectId: value.projectId, specId: value.specId, specHash: value.specHash, requirements: value.requirements,
    objective: value.objective, criteria: value.criteria, scope: value.scope, permissions: value.permissions, budget: value.budget,
    deadline: value.deadline, sourceCandidate: value.sourceCandidate, runtime: value.runtime, worktree: value.worktree,
    resources: value.resources, dependencies: value.dependencies,
  }; return Object.fromEntries(Object.entries(shape).filter(([, entry]) => entry !== undefined)); }
  function assertInheritedWorkflowResume(value: Task) {
    assert(['Paused', 'Failed'].includes(value.state), 'Inherited workflow work may resume only from a paused checkpoint');
    const workflow = value.workflow;
    assert(workflow && typeof workflow === 'object' && ['direct_implementation', 'implementation_slice', 'verification'].includes(workflow.purpose), 'Task has no resumable inherited workflow authority');
    const inherited = value.inheritedAuthorization;
    assert(inherited && typeof inherited.id === 'string' && typeof inherited.ownerApprovalId === 'string', 'Task has no exact inherited workflow authorization');
    const authorization = store.require<any>('workflow_authorization', inherited.id);
    assert(authorization.projectId === value.projectId && authorization.ownerApprovalId === inherited.ownerApprovalId && authorization.owner?.role === 'owner', 'Inherited workflow authorization is stale');
    assert(canonicalJson(authorization.task) === canonicalJson(taskAuthorityShape(value)), 'Task differs from its owner-approved workflow authorization');
    const taskApproval = store.list<any>('approval').find(approval => approval.kind === 'task-inherited' && approval.subjectId === value.id && approval.projectId === value.projectId && approval.hash === value.specHash && approval.sourceOwnerApprovalId === inherited.ownerApprovalId);
    assert(taskApproval && canonicalJson(taskApproval.scope) === canonicalJson(value.scope) && canonicalJson(taskApproval.requirements) === canonicalJson(value.requirements), 'Task has no exact inherited approval');
    assert(typeof value.deadline === 'string' && Number.isFinite(Date.parse(value.deadline)) && Date.parse(value.deadline) > Date.now(), 'Inherited workflow deadline has expired');
    const ownerApproval = store.require<any>('workflow_owner_approval', inherited.ownerApprovalId);
    assert(ownerApproval.projectId === value.projectId && ownerApproval.actor?.role === 'owner' && (ownerApproval.kind === 'feature' || ownerApproval.kind === 'result_rework'), 'Inherited workflow owner approval is unavailable');
    approvedWorkflowFeature(store, value);
    const run = typeof value.runId === 'string' ? store.get<any>('run', value.runId) : undefined;
    assert(run && run.taskId === value.id && run.projectId === value.projectId && ['Paused', 'Failed'].includes(run.state), 'Paused inherited workflow task has no stopped run');
    assert(run.checkpointCandidate && typeof run.checkpointCandidate === 'object', 'Paused inherited workflow run has no preserved candidate');
    const checkpoint = store.list<any>('checkpoint').find(item => item.projectId === value.projectId && item.taskId === value.id && item.runId === run.id && item.data?.candidate && sameCandidate(item.data.candidate, run.checkpointCandidate));
    assert(checkpoint, 'Paused inherited workflow run has no exact saved checkpoint');
  }
  function acceptedRequirements(value: Spec): string[] { return value.status === 'Accepted' ? value.acceptedRequirementIds ?? value.requirementIds : value.requirementIds; }
  function acceptanceStatus(value: Spec): string { return value.status === 'Accepted' && acceptedRequirements(value).length < value.requirementIds.length ? 'Accepted subset' : value.status; }
  function assertTaskSpecification(value: Task): Spec { const valueSpec = spec(value.specId); assert(valueSpec.status === 'Accepted' && valueSpec.hash === value.specHash && value.requirements.every(requirement => acceptedRequirements(valueSpec).includes(requirement)), 'Task specification is stale'); return valueSpec; }
  function assertProjectAccess(actor: Actor, projectId: string, taskId?: string) {
    if (actor.role !== 'worker') return;
    assert(!!actor.taskId, 'Worker actor must be task-bound');
    assert(actor.taskId === (taskId ?? actor.taskId), 'Worker may access only its task');
    assert(task(actor.taskId).projectId === projectId, 'Worker may access only its project');
  }
  function verifyWorker(actor: Actor, value: Task, acknowledging = false) {
    if (actor.role !== 'worker') return;
    assert(actor.taskId === value.id, 'Worker may mutate only its bound task');
    assert(!value.workerId || value.workerId === actor.id, 'Worker does not own task');
    assert(value.controller?.kind !== 'human', 'Task is under human control');
    assert(acknowledging || value.requested?.command !== 'takeover', 'Human takeover is stopping agent input');
  }
  function transferControl(value: Task, expectedRev: number, by: string, stopped: Json) {
    const run = value.runId ? store.get<any>('run', value.runId) : undefined;
    const controller = { kind: 'human', id: by, at: now(), runId: value.runId, worktree: run?.cwd ?? run?.worktree ?? value.worktree };
    event('task.takeover.input_stopped', value.projectId, { taskId: value.id, runId: value.runId, ...stopped });
    if (run) store.put('run', { ...run, controller }, run.rev);
    return persistTask({ ...value, controller, waitingReasons: [...new Set([...(value.waitingReasons ?? []), `human_control:${by}`])] }, expectedRev, 'task.takeover.transferred', { controller });
  }
  function canonical(projectValue: Project, source: string): string {
    assert(typeof source === 'string' && source.length > 0, 'path is required');
    assert(!isAbsolute(source), 'Canonical path must be relative');
    const root = realpathSync(projectValue.root); const candidate = resolve(root, source); const lexical = relative(root, candidate);
    assert(lexical !== '' && !lexical.startsWith('..') && !isAbsolute(lexical), 'Canonical path escapes project root');
    assert(projectValue.canonicalPaths.includes(lexical), 'Path is not registered canonical specification');
    const actual = realpathSync(candidate); const rel = relative(root, actual);
    assert(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'Canonical path escapes project root');
    return lexical;
  }
  function workflowDependencyReady(successor: Task, dependency: Task) {
    if (dependency.state === 'Accepted') return true;
    if (dependency.state !== 'Needs result review') return false;
    const record = store.get<any>('workflow_continuation', `workflow_continuation:${dependency.id}:${successor.id}`);
    if (!record || record.projectId !== successor.projectId || record.featureId !== successor.workflow?.featureId || dependency.workflow?.featureId !== successor.workflow?.featureId) return false;
    if (record.targetTaskId !== dependency.id || record.targetTaskRev !== dependency.rev || record.successorTaskId !== successor.id) return false;
    if (record.specId !== dependency.specId || record.specHash !== dependency.specHash || !sameCandidate(record.candidate, dependency.candidate)) return false;
    const ownerApprovalId = successor.inheritedAuthorization?.ownerApprovalId;
    return typeof ownerApprovalId === 'string' && ownerApprovalId === dependency.inheritedAuthorization?.ownerApprovalId && ownerApprovalId === record.ownerApprovalId;
  }
  function waiting(value: Task, input: Json = {}, expectedState: TaskState = 'Approved'): string[] {
    const reasons: string[] = [];
    if (value.state !== expectedState) reasons.push(`state is ${value.state}`);
    if (store.get<any>('dispatch', value.projectId)?.paused) reasons.push(`dispatch_paused:${value.projectId}`);
    if (value.requested?.command) reasons.push(`control_requested:${value.requested.command}`);
    if (value.controller?.kind === 'human') reasons.push(`human_control:${value.controller.id}`);
    try { assertTaskSpecification(value); } catch { reasons.push('accepted specification is stale'); }
    for (const dependencyId of value.dependencies) { const dependency = task(dependencyId); if (!workflowDependencyReady(value, dependency)) reasons.push(`dependency ${dependencyId} is not accepted or workflow-verified`); }
    const activeRuns = store.list<Run>('run').filter(run => run.taskId !== value.id && run.state === 'Running');
    const runType = (input.runType ?? 'technical') as Run['runType'];
    if (runType === 'technical' && activeRuns.filter(run => run.runType === 'technical').length >= 2) reasons.push('technical worker capacity reached');
    if (runType === 'gui' && activeRuns.filter(run => run.runType === 'gui').length >= 1) reasons.push('GUI controller capacity reached');
    const wanted = [...new Set([...(value.resources ?? []), ...(Array.isArray(input.resources) ? input.resources : []), ...[value.worktree, input.worktree].filter((worktree): worktree is string => typeof worktree === 'string' && worktree.length > 0)])];
    for (const run of activeRuns) {
      const other = task(run.taskId); const held = new Set([...(other.resources ?? []), ...(run.resources ?? []), ...[other.worktree, run.worktree].filter((worktree): worktree is string => typeof worktree === 'string' && worktree.length > 0)]);
      for (const resource of wanted) if (held.has(resource)) reasons.push(`resource ${resource} is owned by ${other.id}`);
    }
    return [...new Set(reasons)];
  }
  function persistTask(value: Task, expectedRev: number, type: string, extra: Json = {}) {
    const next = store.put<Task>('task', value, expectedRev); event(type, next.projectId, { taskId: next.id, rev: next.rev, ...extra }); return next;
  }
  function inbox(projectId: string, kind: string, summary: string, data: Json = {}) {
    const value = store.put('inbox', { id: id('inbox'), projectId, kind, summary, data, status: 'pending', createdAt: now() });
    event('inbox.created', projectId, { inboxId: value.id, kind, summary }); return value;
  }
  function reconcileInbox(projectId: string, matches: (item: any) => boolean, resolution: string) {
    const resolved: any[] = [];
    for (const item of store.list<any>('inbox')) {
      if (item.projectId !== projectId || item.status === 'resolved' || !matches(item)) continue;
      const next = store.put('inbox', { ...item, status: 'resolved', resolvedAt: now(), resolution }, item.rev);
      event('inbox.resolved', projectId, { inboxId: next.id, kind: next.kind, resolution }); resolved.push(next);
    }
    return resolved;
  }
  function capture(input: Json): Spec {
    const p = project(input.projectId); assert(existsSync(p.root), 'Registered project root is unavailable');
    const path = canonical(p, input.path); const absolute = resolve(p.root, path); const content = readFileSync(absolute, 'utf8');
    const latestAt = (candidate: string) => store.list<Spec>('spec').filter(s => s.projectId === p.id && s.path === candidate).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    let previous = latestAt(path); let movedFrom: string | undefined;
    if (input.movedFrom !== undefined) {
      assert(typeof input.movedFrom === 'string' && input.movedFrom.length > 0 && !isAbsolute(input.movedFrom) && !input.movedFrom.split('/').includes('..') && input.movedFrom !== path, 'movedFrom must be a different project-relative path');
      assert(!previous, 'movedFrom applies only to the first snapshot at a new path');
      previous = latestAt(input.movedFrom); assert(previous, 'movedFrom has no saved snapshot in this project'); movedFrom = input.movedFrom;
    }
    if (previous?.hash === hash(content) && !movedFrom) return previous;
    const value = store.put<Spec>('spec', { id: id('spec'), projectId: p.id, path, hash: hash(content), content, status: 'Draft', requirementIds: strings(input.requirementIds ?? requirementIds(content), 'requirementIds'), previousId: previous?.id, diff: diff(previous?.content, content), capturedAt: now(), sourceRevision: input.sourceRevision, ...(movedFrom ? { movedFrom } : {}) });
    const updated = store.put<Project>('project', { ...p, specIds: [...new Set([...p.specIds, value.id])] }, p.rev);
    event('spec.captured', p.id, { specId: value.id, hash: value.hash, path, previousId: previous?.id, ...(movedFrom ? { movedFrom } : {}), projectRev: updated.rev }); return value;
  }
  function buildContext(input: Json, actor: Actor) {
    const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId);
    let requested = strings(input.requirementIds ?? [], 'requirementIds');
    if (!requested.length && actor.role === 'worker') requested = task(actor.taskId!).requirements;
    if (!requested.length && input.taskId) { const value = task(input.taskId); assert(value.projectId === p.id, 'Task belongs to another project'); requested = value.requirements; }
    const accepted = store.list<Spec>('spec').filter(s => s.projectId === p.id && s.status === 'Accepted');
    const sourceSpecs = accepted.length ? accepted : store.list<Spec>('spec').filter(s => s.projectId === p.id && s.status === 'Draft');
    const blocks = new Map<string, { spec: Spec; text: string }>();
    for (const s of sourceSpecs) for (const [key, text] of ruleBlocks(s.content)) if (acceptedRequirements(s).includes(key)) blocks.set(key, { spec: s, text });
    if (!requested.length) requested = blocks.size ? [...blocks.keys()] : [...new Set(sourceSpecs.flatMap(acceptedRequirements))];
    for (const rule of requested) {
      if (blocks.has(rule)) continue;
      const source = sourceSpecs.find(s => acceptedRequirements(s).includes(rule));
      if (source) blocks.set(rule, { spec: source, text: source.content });
    }
    if (actor.role === 'worker') { const bound = task(actor.taskId!); assert(requested.every(rule => bound.requirements.includes(rule)), 'Worker context is outside task scope'); }
    const selected = new Set(requested.filter(r => blocks.has(r)));
    for (const rule of selected) for (const link of blocks.get(rule)!.text.match(new RegExp(requirementPattern, 'g')) ?? []) if (blocks.has(link)) selected.add(link);
    const relevant = [...selected].sort().map(rule => ({ requirementId: rule, content: blocks.get(rule)!.text, specId: blocks.get(rule)!.spec.id, specHash: blocks.get(rule)!.spec.hash, sourceStatus: acceptanceStatus(blocks.get(rule)!.spec), inclusion: requested.includes(rule) ? 'requested' : 'linked rule' }));
    const decisions = store.list<any>('decision').filter(d => d.projectId === p.id && (!requested.length || (d.requirements ?? []).some((r: string) => selected.has(r))));
    const triage = store.list<any>('triage').filter(t => t.projectId === p.id && ['specification conflict', 'gap'].includes(t.classification));
    const active = store.list<Task>('task').filter(t => t.projectId === p.id && !terminalStates.has(t.state));
    const observations = store.list<any>('outside').filter(o => o.projectId === p.id && (!(o.affectedRequirements ?? []).length || o.affectedRequirements.some((r: string) => selected.has(r) || requested.includes(r)))).map(o => ({ id: o.id, revision: o.revision, summary: o.summary, behavior: o.behavior, affectedRequirements: o.affectedRequirements ?? [], evidence: o.evidence ?? [], observedBy: o.observedBy, at: o.at }));
    const latestByPath = new Map<string, Spec>(); for (const s of store.list<Spec>('spec').filter(s => s.projectId === p.id)) { const prior = latestByPath.get(s.path); if (!prior || s.capturedAt.localeCompare(prior.capturedAt) >= 0) latestByPath.set(s.path, s); }
    const withheldDrafts = accepted.length ? [...latestByPath.values()].filter(s => s.status === 'Draft').map(s => ({ specId: s.id, path: s.path, specHash: s.hash, status: s.status, reason: 'Draft, not selected for authoritative context' })) : [];
    const before = store.watermark(); const omissions = requested.filter(r => !blocks.has(r)).map(r => `No accepted source for ${r}`);
    const receipt = store.put('receipt', { id: id('receipt'), projectId: p.id, role: actor.role, generatedAt: now(), stateWatermark: before, sources: relevant.map(r => ({ specId: r.specId, specHash: r.specHash, specRev: blocks.get(r.requirementId)!.spec.rev, status: blocks.get(r.requirementId)!.spec.status, sourceStatus: acceptanceStatus(blocks.get(r.requirementId)!.spec), requirementId: r.requirementId, inclusion: r.inclusion })), observations: observations.map(o => ({ id: o.id, revision: o.revision, behavior: o.behavior })), omitted: omissions, withheldDrafts, omittedCategories: input.omittedCategories ?? ['unselected requirements', 'other projects', 'implementation detail'] });
    event('context.built', p.id, { receiptId: receipt.id, watermark: before, sourceCount: relevant.length });
    return { project: { id: p.id, name: p.name, purpose: p.purpose }, rules: relevant, decisions, conflicts: triage, observations, activeTasks: active.map(t => ({ id: t.id, state: t.state, requirements: t.requirements, criteria: t.criteria })), receipt: { ...receipt, stateWatermark: before, fallbackSources: relevant.filter(rule => !ruleBlocks(blocks.get(rule.requirementId)!.spec.content).has(rule.requirementId)).map(rule => ({ requirementId: rule.requirementId, reason: 'accepted source references this requirement but has no dedicated rule heading' })) } };
  }
  function call(action: string, raw: unknown, actor: Actor): any {
    assert(typeof action === 'string' && !!roles[action], `Unknown action: ${action}`);
    assert(actor && roles[action].includes(actor.role), `Role ${actor?.role ?? 'unknown'} may not call ${action}`);
    const input = requireObject(raw);
    if (input.worktree !== undefined) assert(typeof input.worktree === 'string' || typeof input.worktree === 'boolean', 'worktree must be a path string or boolean');
    for (const key of schemas[action].required ?? []) assert(input[key] !== undefined, `${key} is required`);
    return store.tx(() => {
      switch (action) {
        case 'project.register': {
          assert(typeof input.name === 'string' && typeof input.purpose === 'string', 'name and purpose are required'); assert(isAbsolute(input.root) && existsSync(input.root), 'root must be an existing absolute path');
          assert(!input.id || !store.get('project', input.id), 'Project already exists'); const root = realpathSync(input.root); const paths = strings(input.canonicalPaths ?? ['spec/PRD.md'], 'canonicalPaths');
          for (const path of paths) { assert(!isAbsolute(path) && !path.split('/').includes('..'), 'Invalid canonical path'); }
          const value = store.put<Project>('project', { id: input.id ?? id('project'), name: input.name, root, purpose: input.purpose, canonicalPaths: paths, specIds: [] }); event('project.registered', value.id, { projectId: value.id, name: value.name }); return value;
        }
        case 'project.update': {
          const value = project(input.projectId); const paths = input.canonicalPaths === undefined ? value.canonicalPaths : strings(input.canonicalPaths, 'canonicalPaths');
          assert(value.canonicalPaths.every(path => paths.includes(path)), 'Canonical paths may only be appended');
          for (const path of paths) assert(!isAbsolute(path) && path.length > 0 && !path.split('/').includes('..'), 'Invalid canonical path');
          let root = value.root;
          if (input.root !== undefined) {
            assert(typeof input.root === 'string' && isAbsolute(input.root) && existsSync(input.root), 'root must be an existing absolute path'); root = realpathSync(input.root);
            for (const captured of store.list<Spec>('spec').filter(s => s.projectId === value.id)) {
              const relocated = resolve(root, captured.path); assert(existsSync(relocated), `Relocated canonical specification is unavailable: ${captured.path}`);
              assert(hash(readFileSync(relocated, 'utf8')) === captured.hash, `Relocated canonical specification changed: ${captured.path}`);
            }
          }
          if (input.name !== undefined) assert(typeof input.name === 'string' && input.name.trim(), 'name is required');
          if (input.purpose !== undefined) assert(typeof input.purpose === 'string' && input.purpose.trim(), 'purpose is required');
          const next = store.put<Project>('project', { ...value, root, canonicalPaths: paths, name: input.name?.trim() ?? value.name, purpose: input.purpose?.trim() ?? value.purpose }, expected(input));
          event('project.updated', next.id, { projectId: next.id, rev: next.rev, root: next.root, canonicalPaths: next.canonicalPaths }); return next;
        }
        case 'project.list': return actor.role === 'worker' ? [project(task(actor.taskId ?? '').projectId)] : store.list<Project>('project');
        case 'project.get': { const value = project(input.projectId); assertProjectAccess(actor, value.id, input.taskId); return value; }
        case 'spec.capture': return capture(input);
        case 'spec.list': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); return store.list<Spec>('spec').filter(s => s.projectId === p.id); }
        case 'spec.accept': {
          const provenanceValue = provenance(input); const value = spec(input.specId);
          assert(value.status === 'Draft' || value.status === 'Accepted', 'Only draft specifications or accepted subsets may be accepted');
          assert(value.hash === input.hash, 'Specification hash changed');
          assert(hash(readFileSync(resolve(project(value.projectId).root, value.path), 'utf8')) === value.hash, 'Canonical specification changed after review');
          const requestedRequirementIds = strings(input.requirementIds ?? value.requirementIds, 'requirementIds');
          assert(requestedRequirementIds.every(requirement => value.requirementIds.includes(requirement)), 'Accepted requirements must belong to the captured specification');
          const existingRequirementIds = value.status === 'Accepted' ? acceptedRequirements(value) : [];
          assert(existingRequirementIds.every(requirement => requestedRequirementIds.includes(requirement)), 'Accepted requirements may not be dropped');
          const addedRequirementIds = requestedRequirementIds.filter(requirement => !existingRequirementIds.includes(requirement));
          assert(value.status === 'Draft' || addedRequirementIds.length > 0, 'No new requirement IDs to accept');
          const selected = new Set([...existingRequirementIds, ...requestedRequirementIds]);
          const acceptedRequirementIds = value.requirementIds.filter(requirement => selected.has(requirement));
          const p = project(value.projectId);
          const current = store.list<Spec>('spec').filter(candidate => candidate.id !== value.id && candidate.projectId === p.id && candidate.path === value.path && candidate.status === 'Accepted');
          const accepted = store.put<Spec>('spec', { ...value, status: 'Accepted', acceptedRequirementIds, acceptedAt: now() }, expected(input));
          if (acceptedRequirementIds.length) for (const prior of current) {
            const priorAccepted = acceptedRequirements(prior);
            if (!priorAccepted.some(requirement => acceptedRequirementIds.includes(requirement))) continue;
            const remaining = priorAccepted.filter(requirement => !acceptedRequirementIds.includes(requirement));
            store.put<Spec>('spec', { ...prior, status: remaining.length ? 'Accepted' : 'Superseded', acceptedRequirementIds: remaining }, prior.rev);
          } else for (const prior of current.filter(candidate => candidate.requirementIds.length === 0)) {
            store.put<Spec>('spec', { ...prior, status: 'Superseded', acceptedRequirementIds: [] }, prior.rev);
          }
          const approval = store.put('approval', { id: id('approval'), kind: 'specification', projectId: p.id, subjectId: accepted.id, hash: accepted.hash, sourceRevision: accepted.rev, actor: { id: actor.id, role: actor.role }, provenance: provenanceValue, diff: accepted.diff, requirements: addedRequirementIds, at: now() });
          const resolved = reconcileInbox(p.id, item => ['prd review', 'specification review', 'spec review'].includes(String(item.kind).trim().toLowerCase()) && ((item.data?.specId === accepted.id && (item.data?.specHash ?? item.data?.hash) === accepted.hash) || (!item.data?.specId && (item.data?.specHash ?? item.data?.hash) === accepted.hash && item.data?.path === accepted.path)), 'accepted specification');
          event('spec.accepted', p.id, { specId: accepted.id, hash: accepted.hash, approvalId: approval.id, actor: actor.id, acceptedRequirementIds, addedRequirementIds, resolvedInboxIds: resolved.map(item => item.id) }); return { spec: accepted, approval };
        }
        case 'spec.retire': { const provenanceValue = provenance(input); const value = spec(input.specId); assert(!['Superseded', 'Retired'].includes(value.status), 'Specification is already inactive'); const next = store.put<Spec>('spec', { ...value, status: 'Retired', retiredAt: now(), retiredBy: { id: actor.id, provenance: provenanceValue } }, expected(input)); event('spec.retired', next.projectId, { specId: next.id, provenance: provenanceValue }); return next; }
        case 'task.create': {
          const p = project(input.projectId); const s = spec(input.specId); assert(s.projectId === p.id && s.hash === input.specHash, 'Task must bind exact project specification hash'); assert(s.status === 'Accepted', 'Task must bind an accepted specification');
          const requirements = strings(input.requirements, 'requirements'); const criteria = strings(input.criteria, 'criteria'); assert(requirements.length > 0, 'Task requires at least one accepted requirement'); assert(criteria.length > 0, 'Task requires at least one acceptance criterion'); assert(requirements.every(requirement => acceptedRequirements(s).includes(requirement)), 'Task requirements must be accepted by its specification');
          assert(!input.id || !store.get('task', input.id), 'Task already exists'); const context = contextBudget(input.budget?.context); const value = store.put<Task>('task', { id: input.id ?? id('task'), projectId: p.id, specId: s.id, specHash: s.hash, requirements, objective: input.objective, criteria, scope: input.scope, permissions: strings(input.permissions, 'permissions'), budget: input.budget, deadline: input.deadline, sourceCandidate: input.sourceCandidate, runtime: input.runtime, capability: input.capability, capabilityInput: input.capabilityInput, worktree: input.worktree, resources: strings(input.resources ?? [], 'resources'), priority: Number.isFinite(input.priority) ? input.priority : 0, state: 'Needs approval', waitingReasons: ['owner approval required'], dependencies: strings(input.dependencies ?? [], 'dependencies'), dimensions: { intended: true, implemented: false, verified: false, accepted: false, released: false }, createdBy: { id: actor.id, role: actor.role, at: now() } });
          for (const dependency of value.dependencies) { const other = task(dependency); assert(other.projectId === value.projectId, 'Dependency belongs to another project'); }
          event('task.created', p.id, { taskId: value.id, specId: s.id, specHash: s.hash, ...(context?.exceptionReason ? { contextException: { reason: context.exceptionReason, targetTokens: context.targetTokens ?? null, exceptionMaxTokens: context.exceptionMaxTokens ?? context.maxTokens ?? 180_000 } } : {}) }); return value;
        }
        case 'task.approve': {
          const provenanceValue = provenance(input); const value = task(input.taskId); assert(value.state === 'Needs approval', 'Task is not awaiting approval'); assertTaskSpecification(value);
          assertTechnicalTask(value);
          const next = persistTask({ ...value, state: 'Approved', waitingReasons: waiting({ ...value, state: 'Approved' }) }, expected(input), 'task.approved', { actor: actor.id });
          const approval = store.put('approval', { id: id('approval'), kind: 'task', projectId: next.projectId, subjectId: next.id, hash: next.specHash, sourceRevision: next.rev, scope: next.scope, requirements: next.requirements, actor: { id: actor.id, role: actor.role }, provenance: provenanceValue, at: now() });
          const resolved = reconcileInbox(next.projectId, item => item.kind === 'task approval' && item.data?.taskId === next.id, 'task approved');
          event('approval.recorded', next.projectId, { approvalId: approval.id, taskId: next.id, resolvedInboxIds: resolved.map(item => item.id) }); return { task: next, approval };
        }
        case 'task.authorizeChild': {
          const value = task(input.taskId); assert(value.state === 'Needs approval', 'Task is not awaiting approval'); assertTaskSpecification(value); assertTechnicalTask(value);
          const authorization = store.require<any>('workflow_authorization', input.authorizationId);
          assert(authorization.projectId === value.projectId, 'Workflow authorization belongs to another project');
          assert(authorization.ownerApprovalId && authorization.owner?.role === 'owner', 'Workflow authorization lacks an owner approval');
          assert(JSON.stringify(authorization.task) === JSON.stringify(taskAuthorityShape(value)), 'Task differs from its owner-approved workflow authorization');
          const next = persistTask({ ...value, state: 'Approved', waitingReasons: waiting({ ...value, state: 'Approved' }), inheritedAuthorization: { id: authorization.id, ownerApprovalId: authorization.ownerApprovalId, at: now() } }, expected(input), 'task.child.authorized', { authorizationId: authorization.id, ownerApprovalId: authorization.ownerApprovalId, actor: actor.id });
          const approval = store.put('approval', { id: id('approval'), kind: 'task-inherited', projectId: next.projectId, subjectId: next.id, hash: next.specHash, sourceRevision: next.rev, scope: next.scope, requirements: next.requirements, actor: { id: actor.id, role: actor.role }, sourceOwnerApprovalId: authorization.ownerApprovalId, at: now() });
          event('approval.recorded', next.projectId, { approvalId: approval.id, taskId: next.id, inheritedAuthorizationId: authorization.id, sourceOwnerApprovalId: authorization.ownerApprovalId }); return { task: next, approval };
        }
        case 'task.setDeadline': {
          const provenanceValue = provenance(input); const value = task(input.taskId);
          assert(value.state === 'Needs approval', 'Only tasks awaiting approval may change deadline');
          assert(typeof input.deadline === 'string' && Number.isFinite(Date.parse(input.deadline)) && Date.parse(input.deadline) > Date.now(), 'deadline must be a valid future time');
          assert(!value.deadline || !Number.isFinite(Date.parse(value.deadline)) || Date.parse(value.deadline) <= Date.now(), 'Task deadline is already valid');
          return persistTask({ ...value, deadline: input.deadline, deadlineUpdatedBy: { id: actor.id, provenance: provenanceValue, at: now() } }, expected(input), 'task.deadline.set', { deadline: input.deadline, decision: provenanceValue.decision, source: provenanceValue.source, actor: actor.id });
        }
        case 'task.queue': { const value = task(input.taskId); assertProjectAccess(actor, value.projectId, value.id); assert(value.state === 'Approved', 'Only approved tasks are queued'); const reasons = waiting(value, input); return persistTask({ ...value, waitingReasons: reasons }, expected(input), 'task.queued', { reasons }); }
        case 'task.reprioritize': { const value = task(input.taskId); assert(Number.isFinite(input.priority), 'priority must be a number'); assert(typeof input.decision === 'string' && input.decision.trim(), 'decision is required'); const next = persistTask({ ...value, priority: input.priority, priorityDecision: input.decision.trim() }, expected(input), 'task.reprioritized', { priority: input.priority, decision: input.decision.trim() }); return next; }
        case 'task.waiting': { const value = task(input.taskId); assertProjectAccess(actor, value.projectId, value.id); return { taskId: value.id, reasons: waiting(value, input) }; }
        case 'task.claim': {
          const value = task(input.taskId); if (actor.role === 'worker') { assert(actor.taskId === value.id, 'Worker may claim only bound task'); }
          assertTechnicalTask(value);
          assert(!value.runtime || input.runtime === undefined || input.runtime === value.runtime, 'Runtime differs from the approved task');
          const approvedRunType = value.runtime === 'script' ? 'script' : value.runtime === 'codex-app' ? 'gui' : 'technical';
          assert(input.runType === undefined || input.runType === approvedRunType, 'Run type differs from the approved task');
          assert(input.worktree === undefined || input.worktree === value.worktree, 'Worktree differs from the approved task');
          assert(strings(input.resources ?? [], 'resources').every(resource => value.resources.includes(resource)), 'Resources differ from the approved task');
          const reasons = waiting(value, { ...input, runType: approvedRunType }); if (reasons.length) { const next = persistTask({ ...value, waitingReasons: reasons }, expected(input), 'task.waiting', { reasons }); return { claimed: false, task: next, reasons }; }
          const runType = approvedRunType as Run['runType']; assert(['technical', 'script', 'gui'].includes(runType), 'Invalid runType'); const workerId = input.workerId ?? (actor.role === 'worker' ? actor.id : undefined);
          const run = store.put<Run>('run', { id: id('run'), taskId: value.id, projectId: value.projectId, runtime: input.runtime ?? value.runtime, runType, purpose: 'implementation', workerId, resources: [...new Set([...(value.resources ?? []), ...strings(input.resources ?? [], 'resources')])], worktree: input.worktree ?? value.worktree, state: 'Running', startedAt: now() });
          const next = persistTask({ ...value, state: 'Running', waitingReasons: [], workerId, runId: run.id, runtime: run.runtime, worktree: run.worktree, resources: run.resources }, expected(input), 'task.claimed', { runId: run.id, runType }); return { claimed: true, task: next, run };
        }
        case 'task.claimVerification': {
          const value = task(input.taskId); if (actor.role === 'worker') { assert(actor.taskId === value.id, 'Worker may claim only bound task'); assert(input.workerId === undefined || input.workerId === actor.id, 'Worker may not claim verification for another worker'); assert(!value.workerId || value.workerId === actor.id, 'Worker does not own task'); }
          const reasons = waiting(value, input, 'Verifying'); if (reasons.length) { const next = persistTask({ ...value, waitingReasons: reasons }, expected(input), 'task.verification.waiting', { reasons }); return { claimed: false, task: next, reasons }; }
          const runType = (input.runType ?? 'technical') as Run['runType']; assert(['technical', 'script', 'gui'].includes(runType), 'Invalid runType'); const workerId = input.workerId ?? (actor.role === 'worker' ? actor.id : value.workerId); assert(typeof workerId === 'string' && workerId.length > 0, 'workerId is required for verification');
          const run = store.put<Run>('run', { id: id('run'), taskId: value.id, projectId: value.projectId, runtime: input.runtime ?? value.runtime, runType, purpose: 'verification', workerId, resources: [...new Set([...(value.resources ?? []), ...strings(input.resources ?? [], 'resources')])], worktree: input.worktree ?? value.worktree, state: 'Running', startedAt: now() });
          const next = persistTask({ ...value, waitingReasons: [], workerId, runId: run.id, runtime: run.runtime, worktree: run.worktree, resources: run.resources }, expected(input), 'task.verification.claimed', { runId: run.id, runType }); return { claimed: true, task: next, run };
        }
        case 'task.control': {
          const value = task(input.taskId); assert(!terminalStates.has(value.state), 'Task is terminal'); assert(!value.requested, 'A task control request is already pending'); const command = input.command; assert(['pause', 'cancel', 'checkpoint', 'resume', 'takeover', 'release'].includes(command), 'Invalid task control'); const human = value.controller?.kind === 'human'; assert(!human || ['release', 'cancel'].includes(command), 'Task is under human control; release it before agents continue'); if (command === 'takeover' || command === 'release') assert(actor.role === 'owner', 'Only owner may take over or release work'); if (command === 'takeover') assert(['Running', 'Paused'].includes(value.state), 'Only running or paused work can be taken over'); if (command === 'release') assert(human, 'Task is not under human control'); if (command === 'takeover' && value.state === 'Paused') return transferControl(value, expected(input), actor.id, { alreadyStopped: true }); if (command === 'resume') { assert(actor.role === 'owner', 'Only owner may resume work'); assert(['Paused', 'Blocked', 'Failed'].includes(value.state), 'Task is not resumable'); const directApproval = store.list<any>('approval').some(approval => approval.kind === 'task' && approval.subjectId === value.id && approval.hash === value.specHash); if (!directApproval) assertInheritedWorkflowResume(value); }
          const requested = { command, by: actor.id, at: now(), state: value.state }; const next = persistTask({ ...value, requested }, expected(input), 'task.control.requested', { command }); if (command === 'cancel' || command === 'pause' || command === 'checkpoint' || command === 'takeover') inbox(next.projectId, 'control requested', `${command} requested for ${next.id}`, { taskId: next.id, command }); return next;
        }
        case 'task.ack': {
          const value = task(input.taskId); verifyWorker(actor, value, true); assert(value.requested?.command === input.command, 'No matching control request');
          const command = input.command; const stopping = command === 'pause' || command === 'takeover'; let state: TaskState = value.state; if (stopping) state = 'Paused'; if (command === 'cancel') state = 'Canceled'; if (command === 'resume') { assert(['Paused', 'Blocked', 'Failed'].includes(value.state), 'Task is not resumable'); state = value.pausedFrom === 'Verifying' ? 'Verifying' : 'Approved'; }
          if (command === 'checkpoint') { const checkpoint = store.put('checkpoint', { id: id('checkpoint'), projectId: value.projectId, taskId: value.id, runId: value.runId, data: input.checkpoint ?? {}, at: now(), actor: actor.id }); event('checkpoint.saved', value.projectId, { taskId: value.id, checkpointId: checkpoint.id }); }
          if (['pause', 'cancel', 'takeover'].includes(command) && value.runId) { const run = store.require<Run>('run', value.runId); store.put<Run>('run', { ...run, state: command === 'cancel' ? 'Canceled' : 'Paused', endedAt: command === 'cancel' ? now() : run.endedAt }, run.rev); }
          const released = command === 'release' ? { controller: undefined, lastController: { ...value.controller, releasedAt: now(), releasedBy: value.requested?.by }, waitingReasons: value.waitingReasons.filter(reason => !reason.startsWith('human_control:')) } : {};
          if (command === 'release' && value.runId) { const run = store.require<any>('run', value.runId); if (run.controller) store.put('run', { ...run, controller: undefined }, run.rev); }
          let next = persistTask({ ...value, state, pausedFrom: stopping ? value.state : command === 'resume' ? undefined : value.pausedFrom, acknowledged: { command, by: actor.id, at: now() }, requested: undefined, waitingReasons: state === 'Approved' ? waiting({ ...value, state: 'Approved' }) : value.waitingReasons, ...released }, expected(input), 'task.control.acknowledged', { command });
          if (command === 'takeover') next = transferControl(next, next.rev, value.requested?.by, { acknowledgedBy: actor.id });
          if (command === 'release') event('task.takeover.released', next.projectId, { taskId: next.id, runId: next.runId, by: value.requested?.by, checkpoint: input.checkpoint ?? null });
          const resolved = reconcileInbox(next.projectId, item => (item.kind === 'control requested' && item.data?.taskId === next.id && item.data?.command === command) || (command === 'cancel' && item.data?.taskId === next.id && ['verification needed', 'verification review', 'task verification', 'result review', 'task approval', 'control requested'].includes(String(item.kind).trim().toLowerCase())), `control ${command} acknowledged`);
          event('task.control.reconciled', next.projectId, { taskId: next.id, command, resolvedInboxIds: resolved.map(item => item.id) }); return next;
        }
        case 'task.fail': case 'task.block': {
          const value = task(input.taskId); assert(['Approved', 'Running', 'Verifying'].includes(value.state), `Task cannot stop from ${value.state}`); assert(typeof input.reason === 'string' && input.reason.trim(), 'reason is required');
          const failed = action === 'task.fail'; const state: TaskState = failed ? 'Failed' : 'Blocked'; const runId = input.runId ?? value.runId; const reason = input.reason.trim().slice(0, 4000); const at = now();
          const run = runId ? store.require<Run>('run', runId) : undefined; assert(!run || run.taskId === value.id, 'Run belongs to another task');
          if (run?.state === 'Running') store.put<Run>('run', { ...run, state: 'Failed', endedAt: at }, run.rev);
          if (input.checkpoint !== undefined) { const saved = store.put('checkpoint', { id: id('checkpoint'), projectId: value.projectId, taskId: value.id, runId, data: requireObject(input.checkpoint), at, actor: actor.id }); event('checkpoint.saved', value.projectId, { taskId: value.id, checkpointId: saved.id }); }
          const next = persistTask({ ...value, state, pausedFrom: value.state, stopped: { state, reason, runId, by: actor.id, at } }, expected(input), failed ? 'task.failed' : 'task.blocked', { runId, reason });
          const item = inbox(next.projectId, failed ? 'run failed' : 'run blocked', `${failed ? 'Run failed' : 'Work is blocked'} for ${next.id}${runId ? ` (run ${runId})` : ''}: ${reason}`, { taskId: next.id, runId, reason, state });
          return { task: next, inbox: item };
        }
        case 'task.workerResult': {
          const value = task(input.taskId); verifyWorker(actor, value); assertTaskSpecification(value); assert(value.state === 'Running' && value.runId === input.runId, 'Task is not running this run'); const run = store.require<Run>('run', input.runId); assert(run.state === 'Running', 'Run is no longer active'); const candidate = requireObject(input.candidate); assert(typeof candidate.id === 'string' && candidate.id.length > 0, 'candidate.id is required'); assert(candidate.specHash === value.specHash, 'Candidate has stale specification hash');
          const result = store.put('result', { id: id('result'), projectId: value.projectId, taskId: value.id, runId: run.id, candidate, summary: input.summary, checks: input.checks ?? [], artifacts: input.artifacts ?? [], unresolved: input.unresolved ?? [], usage: input.usage ?? {}, exitReason: input.exitReason ?? 'success', at: now() });
          store.put<Run>('run', { ...run, state: 'Completed', endedAt: now() }, run.rev); const next = persistTask({ ...value, state: 'Verifying', candidate, dimensions: { ...value.dimensions, implemented: true } }, input.expectedTaskRev, 'task.result.received', { resultId: result.id, candidate: candidate.id }); inbox(next.projectId, 'verification needed', `Result for ${next.id} needs verification`, { taskId: next.id, resultId: result.id }); return { task: next, result };
        }
        case 'evidence.record': {
          const value = task(input.taskId); verifyWorker(actor, value); assertTaskSpecification(value); assert(sameCandidate(value.candidate, input.candidate) && value.specHash === input.specHash, 'Evidence does not match current candidate and specification'); assert(typeof input.environment === 'string' && input.environment.trim(), 'environment is required'); assert(Array.isArray(input.artifacts ?? []) && (input.artifacts ?? []).every((artifact: unknown) => artifact && typeof artifact === 'object' && !Array.isArray(artifact)), 'artifacts must be an array of objects'); assert(input.details === undefined || (input.details && typeof input.details === 'object' && !Array.isArray(input.details)), 'details must be an object'); const evidence = store.put('evidence', { id: id('evidence'), projectId: value.projectId, taskId: value.id, candidate: input.candidate, specHash: input.specHash, check: input.check, environment: input.environment.trim(), result: input.result, command: input.command, notes: input.notes, artifacts: input.artifacts ?? [], details: input.details ?? {}, at: input.at ?? now(), actor: { id: actor.id, role: actor.role } }); event('evidence.recorded', value.projectId, { evidenceId: evidence.id, taskId: value.id, candidate: input.candidate.id, result: input.result, artifacts: evidence.artifacts.length }); return evidence;
        }
        case 'task.verify': {
          const value = task(input.taskId); verifyWorker(actor, value); assertTaskSpecification(value); assert(value.state === 'Verifying', 'Task is not verifying'); assert(sameCandidate(value.candidate, input.candidate) && value.specHash === input.specHash, 'Verification is stale'); const evidence = store.list<any>('evidence').filter(e => e.taskId === value.id && sameCandidate(e.candidate, input.candidate) && e.specHash === value.specHash); assert(evidence.length > 0 && !evidence.some(e => e.result === 'fail'), 'Exact passing evidence is required'); for (const criterion of value.criteria) { const matching = evidence.filter(e => e.check === criterion); assert(matching.length > 0 && matching.at(-1).result === 'pass', `Criterion lacks passing evidence: ${criterion}`); } const verificationRun = value.runId ? store.get<Run>('run', value.runId) : undefined; if (verificationRun?.state === 'Running' && verificationRun.purpose === 'verification') store.put<Run>('run', { ...verificationRun, state: 'Completed', endedAt: now() }, verificationRun.rev); const next = persistTask({ ...value, state: 'Needs result review', dimensions: { ...value.dimensions, verified: true } }, expected(input), 'task.verified', { candidate: input.candidate.id, evidenceIds: evidence.map(e => e.id), verificationRunId: verificationRun?.purpose === 'verification' ? verificationRun.id : undefined }); const resolved = reconcileInbox(next.projectId, item => item.kind === 'verification needed' && item.data?.taskId === next.id, 'verification completed'); inbox(next.projectId, 'result review', `Review result for ${next.id}`, { taskId: next.id, candidate: input.candidate }); event('task.verification.reconciled', next.projectId, { taskId: next.id, resolvedInboxIds: resolved.map(item => item.id) }); return next;
        }
        case 'task.review': {
          const provenanceValue = provenance(input); const value = task(input.taskId); if (value.workflow?.featureId && ['implementation_slice', 'direct_implementation'].includes(value.workflow?.purpose)) { const gate = store.get<any>('workflow_result_review_gate', `workflow_result_review_gate:${value.id}`); assert(gate?.projectId === value.projectId && gate.featureId === value.workflow.featureId && gate.taskRev === value.rev && sameCandidate(gate.candidate, input.candidate) && gate.owner?.role === 'owner' && gate.owner.id === actor.id, 'Workflow implementation results require aggregate feature review'); } assertTaskSpecification(value); assert(value.state === 'Needs result review', 'Task does not need result review'); assert(sameCandidate(value.candidate, input.candidate), 'Review candidate is stale'); assert(['accept', 'reject'].includes(input.decision), 'Invalid review decision'); const accepted = input.decision === 'accept'; const next = persistTask({ ...value, state: accepted ? 'Accepted' : 'Blocked', dimensions: { ...value.dimensions, accepted }, resultReview: { decision: input.decision, notes: input.notes, actor: actor.id, provenance: provenanceValue, at: now() } }, expected(input), 'task.result.reviewed', { decision: input.decision, candidate: input.candidate.id }); const review = store.put('review', { id: id('review'), projectId: next.projectId, taskId: next.id, candidate: input.candidate, decision: input.decision, notes: input.notes, provenance: provenanceValue, actor: { id: actor.id, role: actor.role }, at: now() }); const resolved = reconcileInbox(next.projectId, item => item.kind === 'result review' && item.data?.taskId === next.id, `result ${input.decision}`); if (!accepted) inbox(next.projectId, 'result rejected', `Result for ${next.id} was rejected`, { taskId: next.id, reviewId: review.id }); event('task.review.reconciled', next.projectId, { taskId: next.id, resolvedInboxIds: resolved.map(item => item.id) }); return { task: next, review };
        }
        case 'task.get': { const value = task(input.taskId); assertProjectAccess(actor, value.projectId, value.id); return value; }
        case 'task.list': { const values = store.list<Task>('task').filter(t => !input.projectId || t.projectId === input.projectId); if (actor.role === 'worker') return values.filter(t => t.id === actor.taskId); return values.map(t => ({ ...t, waitingReasons: t.state === 'Approved' ? waiting(t) : t.waitingReasons })); }
        case 'evidence.list': { const value = task(input.taskId); assertProjectAccess(actor, value.projectId, value.id); return store.list<any>('evidence').filter(e => e.taskId === value.id); }
        case 'release.decide': {
          const provenanceValue = provenance(input); const value = task(input.taskId); assertTaskSpecification(value); assert(value.state === 'Accepted', 'Only accepted results may receive a release decision'); assert(sameCandidate(value.candidate, input.candidate), 'Release candidate is stale'); assert(['approve', 'reject', 'defer'].includes(input.decision), 'Invalid release decision'); const release = store.put('release', { id: id('release'), projectId: value.projectId, taskId: value.id, candidate: input.candidate, decision: input.decision, version: input.version, notes: input.notes, provenance: provenanceValue, actor: { id: actor.id, role: actor.role }, at: now() }); event('release.decided', value.projectId, { releaseId: release.id, taskId: value.id, decision: input.decision }); return release;
        }
        case 'release.record': { const value = task(input.taskId); assertTaskSpecification(value); assert(value.state === 'Accepted' && sameCandidate(value.candidate, input.candidate), 'Release observation is stale'); assert(['merged', 'deployed', 'activated'].includes(input.operation), 'Invalid release operation'); const decisions = store.list<any>('release').filter(release => release.taskId === value.id && sameCandidate(release.candidate, input.candidate)); const latest = decisions.at(-1); assert(latest?.decision === 'approve', 'Release has not been authorized'); const record = store.put('releaseRecord', { id: id('release_record'), projectId: value.projectId, taskId: value.id, candidate: input.candidate, operation: input.operation, evidence: input.evidence, version: input.version, observedBy: actor.id, at: now() }); const next = persistTask({ ...value, dimensions: { ...value.dimensions, released: true } }, value.rev, 'task.release.observed', { releaseRecordId: record.id, operation: record.operation }); event('release.recorded', value.projectId, { releaseRecordId: record.id, taskId: value.id, taskRev: next.rev }); return { record, task: next }; }
        case 'release.list': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); return store.list<any>('release').filter(r => r.projectId === p.id); }
        case 'release.observations': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); return store.list<any>('releaseRecord').filter(record => record.projectId === p.id); }
        case 'feature.map': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); const allTasks = store.list<Task>('task').filter(t => t.projectId === p.id); const tasks = actor.role === 'worker' ? allTasks.filter(t => t.id === actor.taskId) : allTasks; const releaseRecords = store.list<any>('releaseRecord').filter(record => record.projectId === p.id); const acceptedRequirementIds = store.list<Spec>('spec').filter(s => s.projectId === p.id && s.status === 'Accepted').flatMap(acceptedRequirements); const requirements = actor.role === 'worker' ? tasks.flatMap(t => t.requirements) : [...acceptedRequirementIds, ...tasks.flatMap(t => t.requirements)]; const evidenceRecords = store.list<any>('evidence').filter(record => record.projectId === p.id); const fresh = new Map(tasks.map(t => { try { assertTaskSpecification(t); return [t.id, true]; } catch { return [t.id, false]; } })); const evidenceSummary = (t: Task) => t.criteria.map(check => { const latest = evidenceRecords.filter(record => record.taskId === t.id && record.check === check && record.specHash === t.specHash && sameCandidate(record.candidate, t.candidate)).at(-1); return latest ? { check, result: latest.result, evidenceId: latest.id, candidateId: latest.candidate?.id ?? null, artifacts: (latest.artifacts ?? []).map((artifact: any) => ({ path: artifact.path ?? artifact.name ?? null, hash: artifact.hash ?? artifact.sha256 ?? null })) } : { check, result: 'missing', evidenceId: null, candidateId: t.candidate?.id ?? null, artifacts: [] }; }); return [...new Set(requirements)].sort().map(requirement => { const related = tasks.filter(t => t.requirements.includes(requirement)); const current = related.filter(t => fresh.get(t.id) && !['Canceled', 'Superseded'].includes(t.state)); const historical = related.filter(t => !current.includes(t)); const dimensions = (list: Task[]) => ({ implemented: list.some(t => t.dimensions.implemented), verified: list.some(t => t.dimensions.verified), accepted: list.some(t => t.dimensions.accepted), released: list.some(t => t.dimensions.released) }); const releases = releaseRecords.filter(record => related.some(taskValue => taskValue.id === record.taskId)).map(record => ({ id: record.id, taskId: record.taskId, operation: record.operation, version: record.version, at: record.at, current: current.some(taskValue => taskValue.id === record.taskId) })); return { requirement, intended: acceptedRequirementIds.includes(requirement), ...dimensions(current), historical: dimensions(historical), tasks: related.map(t => ({ id: t.id, state: t.state, specHash: t.specHash, specificationFresh: fresh.get(t.id), current: current.includes(t), candidateId: t.candidate?.id ?? null, evidence: evidenceSummary(t) })), releases, deployedVersion: releases.filter(record => record.operation === 'deployed').at(-1)?.version, activatedVersion: releases.filter(record => record.operation === 'activated').at(-1)?.version }; }); }
        case 'triage.classify': {
          project(input.projectId); const allowed = ['bug', 'environment issue', 'duplicate', 'unreproduced report', 'gap', 'change request', 'specification conflict']; assert(allowed.includes(input.classification), 'Invalid classification'); const value = store.put('triage', { id: id('triage'), projectId: input.projectId, classification: input.classification, summary: input.summary, requirements: strings(input.requirements ?? [], 'requirements'), evidence: input.evidence ?? [], status: input.status ?? 'open', actor: { id: actor.id, role: actor.role }, at: now() }); event('triage.classified', input.projectId, { triageId: value.id, classification: value.classification }); if (['gap', 'specification conflict'].includes(value.classification)) inbox(value.projectId, value.classification, value.summary, { triageId: value.id }); return value;
        }
        case 'triage.resolve': {
          const value = store.require<any>('triage', input.triageId); assert(value.status !== 'resolved', 'Triage item is already resolved'); assert(input.expectedRev === undefined || input.expectedRev === value.rev, 'Triage revision is stale');
          assert(typeof input.resolution === 'string' && input.resolution.trim(), 'resolution is required'); assert(Array.isArray(input.evidence ?? []), 'evidence must be an array');
          const resolvedBy = { id: actor.id, role: actor.role }; const resolvedAt = now();
          const next = store.put('triage', { ...value, status: 'resolved', previousStatus: value.status, resolution: input.resolution.trim(), resolutionEvidence: input.evidence ?? [], resolvedBy, resolvedAt }, value.rev);
          const resolved = reconcileInbox(next.projectId, item => item.data?.triageId === next.id, `triage resolved: ${next.resolution}`);
          event('triage.resolved', next.projectId, { triageId: next.id, resolution: next.resolution, actor: resolvedBy, at: resolvedAt, resolvedInboxIds: resolved.map(item => item.id) }); return next;
        }
        case 'triage.list': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); return store.list<any>('triage').filter(t => t.projectId === p.id); }
        case 'outside.observe': {
          project(input.projectId); assert(typeof input.revision === 'string' && input.revision.length > 0, 'revision is required');
          const existing = store.list<any>('outside').find(item => item.projectId === input.projectId && item.revision === input.revision);
          if (existing) return { observation: existing, duplicate: true };
          const behavior = input.behavior ?? 'unknown'; assert(['matching', 'changed', 'unknown'].includes(behavior), 'Invalid outside behavior');
          const observation = store.put('outside', { id: id('outside'), projectId: input.projectId, revision: input.revision, summary: input.summary, behavior, affectedRequirements: strings(input.affectedRequirements ?? [], 'affectedRequirements'), evidence: input.evidence ?? [], observedBy: { id: actor.id, role: actor.role }, at: now() });
          event('outside.observed', input.projectId, { observationId: observation.id, revision: observation.revision, behavior }, `outside:${input.projectId}:${input.revision}`);
          if (behavior === 'changed') {
            const reconciliation = store.put('triage', { id: id('triage'), projectId: input.projectId, classification: 'change request', summary: `Outside revision ${input.revision}: ${input.summary}`, requirements: observation.affectedRequirements, evidence: observation.evidence, status: 'needs requirement review', source: observation.id, at: now() });
            inbox(input.projectId, 'outside change review', `Outside revision ${input.revision} needs requirement review`, { observationId: observation.id, triageId: reconciliation.id });
          }
          return { observation, duplicate: false };
        }
        case 'decision.list': { const p = project(input.projectId); assertProjectAccess(actor, p.id); return store.list<any>('decision').filter(d => d.projectId === p.id); }
        case 'decision.record': { project(input.projectId); const value = store.put('decision', { id: id('decision'), projectId: input.projectId, summary: input.summary, requirements: strings(input.requirements ?? [], 'requirements'), source: input.source, status: input.status ?? 'open', actor: { id: actor.id, role: actor.role }, at: now() }); event('decision.recorded', input.projectId, { decisionId: value.id }); return value; }
        case 'context.build': return buildContext(input, actor);
        case 'context.receipt': { const value = store.require<any>('receipt', input.receiptId); assertProjectAccess(actor, value.projectId, input.taskId); return value; }
        case 'context.freshness': { const value = store.require<any>('receipt', input.receiptId); assertProjectAccess(actor, value.projectId, input.taskId); const root = project(value.projectId).root; const changedSources = value.sources.flatMap((source: any) => { const current = store.get<Spec>('spec', source.specId); if (!current || !(current.rev === source.specRev && current.hash === source.specHash && current.status === source.status)) return [{ specId: source.specId, requirementId: source.requirementId, reason: 'stored specification changed' }]; try { return hash(readFileSync(resolve(root, current.path), 'utf8')) === source.specHash ? [] : [{ specId: source.specId, requirementId: source.requirementId, path: current.path, reason: 'canonical file changed' }]; } catch { return [{ specId: source.specId, requirementId: source.requirementId, path: current.path, reason: 'canonical file unavailable' }]; } }); const sourcesFresh = changedSources.length === 0; const changes = store.events(value.stateWatermark, value.projectId).filter(eventValue => !eventValue.type.startsWith('context.')); return { receiptId: value.id, fresh: sourcesFresh && changes.length === 0, sourcesFresh, changedSources, stateWatermark: value.stateWatermark, currentWatermark: store.watermark(), relevantChanges: changes.map(change => ({ seq: change.seq, type: change.type })) }; }
        case 'checkpoint.get': { const value = store.require<any>('checkpoint', input.checkpointId); assertProjectAccess(actor, value.projectId, value.taskId); return value; }
        case 'checkpoint.list': { const values = store.list<any>('checkpoint').filter(value => !input.taskId || value.taskId === input.taskId); if (actor.role === 'worker') return values.filter(value => value.taskId === actor.taskId); return values; }
        case 'dispatch.pause': { project(input.projectId); assert(typeof input.decision === 'string' && input.decision.trim(), 'decision is required'); const old = store.get<any>('dispatch', input.projectId); const value = store.put('dispatch', { id: input.projectId, projectId: input.projectId, paused: true, decision: input.decision.trim(), by: actor.id, at: now() }, old?.rev); event('dispatch.paused', input.projectId, { decision: value.decision }); return value; }
        case 'dispatch.resume': { project(input.projectId); assert(typeof input.decision === 'string' && input.decision.trim(), 'decision is required'); const old = store.get<any>('dispatch', input.projectId); const value = store.put('dispatch', { id: input.projectId, projectId: input.projectId, paused: false, decision: input.decision.trim(), by: actor.id, at: now() }, old?.rev); event('dispatch.resumed', input.projectId, { decision: value.decision }); return value; }
        case 'dispatch.status': { const p = project(input.projectId); assertProjectAccess(actor, p.id, input.taskId); return store.get<any>('dispatch', p.id) ?? { projectId: p.id, paused: false, reason: 'not configured' }; }
        case 'conversation.focus': { project(input.projectId); const old = store.get<any>('conversation', input.conversationId); if (old) assert(input.expectedRev !== undefined, 'expectedRev is required'); const value = store.put('conversation', { id: input.conversationId, projectId: input.projectId, focus: input.focus ?? {}, openQuestions: input.openQuestions ?? old?.openQuestions ?? [], handoff: input.handoff ?? old?.handoff, updatedAt: now() }, old ? expected(input) : undefined); event('conversation.focused', input.projectId, { conversationId: value.id }); return value; }
        case 'conversation.get': { const value = store.require<any>('conversation', input.conversationId); assertProjectAccess(actor, value.projectId, input.taskId); return value; }
        case 'inbox.create': { project(input.projectId); return inbox(input.projectId, input.kind, input.summary, input.data ?? {}); }
        case 'inbox.list': { const values = store.list<any>('inbox').filter(item => (!input.projectId || item.projectId === input.projectId) && (!input.status || item.status === input.status)); if (actor.role === 'worker') return values.filter(item => item.data?.taskId === actor.taskId); return values; }
        case 'inbox.deliver': { const value = store.require<any>('inbox', input.inboxId); const status = input.status ?? 'delivered'; assert(['pending', 'delivered', 'resolved'].includes(status), 'Invalid inbox status'); assert(value.status !== 'resolved' || status === 'resolved', 'Resolved inbox cannot be reopened'); const next = store.put('inbox', { ...value, status, deliveredAt: status === 'delivered' ? now() : value.deliveredAt, deliveredTo: status === 'delivered' ? actor.id : value.deliveredTo, resolvedAt: status === 'resolved' ? now() : value.resolvedAt, resolvedBy: status === 'resolved' ? actor.id : value.resolvedBy }, expected(input)); event(status === 'resolved' ? 'inbox.resolved' : 'inbox.delivered', next.projectId, { inboxId: next.id, status: next.status }); return next; }
      }
    });
  }
  return { call, actions: () => Object.keys(roles).sort().map(descriptor) };
}
