import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Actor } from './domain.ts';
import { Store, assert, hash, id, now, type RecordValue } from './store.ts';

type Json = Record<string, any>;
type DomainApi = { call: (name: string, input: Json, actor: Actor) => any };
type DocumentsApi = { call: (name: string, input: Json, actor: Actor) => Promise<any> };
type Project = RecordValue & { name: string; root: string };
type Spec = RecordValue & {
  projectId: string;
  path: string;
  hash: string;
  content: string;
  status: string;
  requirementIds: string[];
  acceptedRequirementIds?: string[];
};
type Task = RecordValue & {
  projectId: string;
  specId: string;
  specHash: string;
  objective: string;
  requirements: string[];
  state: string;
  candidate?: Json;
  sourceCandidate?: Json;
};
type DocumentTarget = {
  kind: 'document';
  projectId: string;
  path: string;
  beforeVersion: string | null;
  afterVersion: string;
};
type TaskTarget = { kind: 'task'; projectId: string; taskId: string };
type Target = DocumentTarget | TaskTarget;
type Resolution = {
  target: Target;
  subject: string;
  binding: Json;
  resolvedTarget: Json;
  canAccept: boolean;
  accepted: boolean;
  reason: string | null;
  accept: () => any;
};

const maxNoteLength = 10_000;
const maxCanonicalBytes = 200_000;

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(binding: Json): string { return hash(canonical(binding)); }

function normalizeTarget(value: unknown): Target {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'target must be an object');
  const target = value as Json;
  if (target.kind === 'document') {
    assert(typeof target.projectId === 'string' && target.projectId.length > 0, 'target.projectId is required');
    assert(typeof target.path === 'string' && target.path.length > 0, 'target.path is required');
    assert(target.beforeVersion === null || typeof target.beforeVersion === 'string', 'target.beforeVersion must be a saved version ID or null');
    assert(typeof target.afterVersion === 'string' && target.afterVersion.length > 0, 'target.afterVersion is required');
    return { kind: 'document', projectId: target.projectId, path: target.path, beforeVersion: target.beforeVersion, afterVersion: target.afterVersion };
  }
  assert(target.kind === 'task', 'target.kind must be document or task');
  assert(typeof target.projectId === 'string' && target.projectId.length > 0, 'target.projectId is required');
  assert(typeof target.taskId === 'string' && target.taskId.length > 0, 'target.taskId is required');
  return { kind: 'task', projectId: target.projectId, taskId: target.taskId };
}

function currentFileHash(project: Project, path: string): string | null {
  assert(!isAbsolute(path) && !path.includes('\0') && !/[\r\n]/.test(path), 'Canonical document path is invalid');
  const parts = path.split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..'), 'Canonical document path is invalid');
  assert(realpathSync(project.root) === project.root, 'Registered project root has changed');
  const absolute = resolve(project.root, path);
  const lexical = relative(project.root, absolute);
  assert(lexical === path && !lexical.startsWith('..') && !isAbsolute(lexical), 'Canonical document path escapes project root');
  let current = project.root;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) return null;
    assert(!lstatSync(current).isSymbolicLink(), 'Canonical document path may not contain symlinks');
  }
  const stat = statSync(absolute);
  assert(stat.isFile(), 'Canonical document is not a regular file');
  assert(stat.size <= maxCanonicalBytes, `Canonical document exceeds the ${maxCanonicalBytes} byte limit`);
  return hash(readFileSync(absolute, 'utf8'));
}

function assertTaskAccess(store: Store, actor: Actor, task: Task) {
  if (actor.role !== 'worker') return;
  assert(actor.taskId === task.id, 'Worker may review only its task');
  const owned = store.require<Task>('task', actor.taskId);
  assert(owned.projectId === task.projectId, 'Worker may access only its project');
}

function feedbackFor(store: Store, resolution: Resolution): any[] {
  return store.list<any>('feedback').filter(record => {
    if (resolution.target.kind === 'document') {
      return record.target?.kind === 'document'
        && record.target.projectId === resolution.target.projectId
        && record.target.path === resolution.target.path
        && record.target.afterVersion === resolution.target.afterVersion;
    }
    return record.target?.kind === 'task'
      && record.target.projectId === resolution.target.projectId
      && record.target.taskId === resolution.target.taskId
      && record.target.candidateHash === resolution.resolvedTarget.candidateHash;
  });
}

export function Feedback(store: Store, domain: DomainApi, documents: DocumentsApi) {
  const targetSchema = {
    oneOf: [
      {
        type: 'object', required: ['kind', 'projectId', 'path', 'beforeVersion', 'afterVersion'], additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['document'] }, projectId: { type: 'string' }, path: { type: 'string' },
          beforeVersion: { oneOf: [{ type: 'string' }, { type: 'null' }] }, afterVersion: { type: 'string' },
        },
      },
      {
        type: 'object', required: ['kind', 'projectId', 'taskId'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['task'] }, projectId: { type: 'string' }, taskId: { type: 'string' } },
      },
    ],
  };
  const actions = [
    {
      name: 'review.prepare',
      description: 'Prepare an exact document or task decision and list durable feedback for it.',
      roles: ['owner', 'guide', 'worker'],
      inputSchema: { type: 'object', required: ['target'], additionalProperties: false, properties: { target: targetSchema } },
    },
    {
      name: 'review.submit',
      description: 'Record the owner decision or change request for an exact prepared target.',
      roles: ['owner'],
      inputSchema: {
        type: 'object', required: ['target', 'fingerprint', 'decision', 'note', 'submissionId'], additionalProperties: false,
        properties: {
          target: targetSchema,
          fingerprint: { type: 'string' },
          decision: { type: 'string', enum: ['accept', 'request_changes'] },
          note: { type: 'string' },
          submissionId: { type: 'string' },
        },
      },
    },
  ];

  async function resolveDocument(target: DocumentTarget, actor: Actor): Promise<Resolution> {
    const comparison = await documents.call('review.compare', target, actor);
    const project = store.require<Project>('project', target.projectId);
    const markdown = comparison.files?.[0]?.markdown;
    const beforeContent = markdown?.before;
    const afterContent = markdown?.after;
    const beforeHash = beforeContent === null ? null : typeof beforeContent === 'string' ? hash(beforeContent) : null;
    const afterHash = afterContent === null ? null : typeof afterContent === 'string' ? hash(afterContent) : null;
    const pathSpecs = store.list<Spec>('spec').filter(spec => spec.projectId === project.id && spec.path === target.path);
    const versionSpecId = target.afterVersion.startsWith('spec:') ? target.afterVersion.slice(5) : undefined;
    const versionSpec = versionSpecId ? store.get<Spec>('spec', versionSpecId) : undefined;
    if (versionSpecId) assert(versionSpec?.projectId === project.id && versionSpec.path === target.path, 'Selected specification does not match this project document');
    const latestSpec = pathSpecs.at(-1);
    const selectedSpec = versionSpec ?? (target.afterVersion.startsWith('git:') && latestSpec?.hash === afterHash ? latestSpec : undefined);
    const canonicalHash = currentFileHash(project, target.path);
    const requirements = selectedSpec?.requirementIds ?? [];
    const acceptedIds = selectedSpec ? selectedSpec.acceptedRequirementIds ?? requirements : [];
    const fullyAccepted = requirements.every(requirement => acceptedIds.includes(requirement));
    const accepted = !!selectedSpec
      && selectedSpec.hash === afterHash
      && selectedSpec.status === 'Accepted'
      && fullyAccepted;
    let reason: string | null = null;
    if (accepted) reason = 'This exact specification is already accepted.';
    else if (afterContent === null) reason = 'Deleted document versions cannot be accepted.';
    else if (typeof afterContent !== 'string') reason = 'This document version cannot be read for acceptance.';
    else if (!selectedSpec) reason = 'Accepting this version requires a matching captured specification snapshot.';
    else if (target.afterVersion.startsWith('git:') && latestSpec?.id !== selectedSpec.id) reason = 'Only the latest matching captured specification can be accepted from Git history.';
    else if (!['Draft', 'Accepted'].includes(selectedSpec.status)) reason = `Only a Draft specification or Accepted subset can be accepted. This snapshot is ${selectedSpec.status}.`;
    else if (selectedSpec.hash !== afterHash) reason = 'The selected version does not match its captured specification.';
    else if (canonicalHash !== selectedSpec.hash) reason = 'The canonical document changed after this version was prepared.';
    const canAccept = reason === null;
    const binding = {
      kind: 'document', projectId: project.id, projectRev: project.rev, path: target.path,
      beforeVersion: target.beforeVersion, beforeHash, afterVersion: target.afterVersion, afterHash,
      canonicalHash,
      latestSpec: latestSpec ? { id: latestSpec.id, rev: latestSpec.rev, hash: latestSpec.hash, status: latestSpec.status } : null,
      selectedSpec: selectedSpec ? { id: selectedSpec.id, rev: selectedSpec.rev, hash: selectedSpec.hash, status: selectedSpec.status, requirementIds: requirements, acceptedRequirementIds: selectedSpec.acceptedRequirementIds ?? null } : null,
    };
    const resolvedTarget = {
      ...target, beforeHash, afterHash,
      ...(selectedSpec ? { specId: selectedSpec.id, specHash: selectedSpec.hash, requirementIds: [...requirements] } : {}),
    };
    return {
      target,
      subject: comparison.title,
      binding,
      resolvedTarget,
      canAccept,
      accepted,
      reason,
      accept: () => {
        assert(selectedSpec, 'No captured specification is available for acceptance');
        return domain.call('spec.accept', {
          specId: selectedSpec.id,
          hash: selectedSpec.hash,
          expectedRev: selectedSpec.rev,
          requirementIds: requirements,
          decision: 'Accepted through document review',
          source: `review.submit:${target.afterVersion}`,
        }, actor);
      },
    };
  }

  function resolveTask(target: TaskTarget, actor: Actor): Resolution {
    const project = store.require<Project>('project', target.projectId);
    const task = store.require<Task>('task', target.taskId);
    assert(task.projectId === project.id, 'Task does not belong to the supplied project');
    assertTaskAccess(store, actor, task);
    assert(task.candidate && typeof task.candidate === 'object' && !Array.isArray(task.candidate), 'Task has no result candidate to review');
    const spec = store.require<Spec>('spec', task.specId);
    assert(spec.projectId === project.id && spec.hash === task.specHash, 'Task specification binding is invalid');
    const candidateHash = hash(canonical(task.candidate));
    const acceptedRequirements = spec.acceptedRequirementIds ?? spec.requirementIds;
    const canonicalHash = currentFileHash(project, spec.path);
    const specificationValid = spec.status === 'Accepted'
      && spec.hash === task.specHash
      && task.requirements.every(requirement => acceptedRequirements.includes(requirement))
      && canonicalHash === spec.hash;
    const accepted = task.state === 'Accepted';
    const canAccept = task.state === 'Needs result review' && specificationValid;
    const reason = accepted
      ? 'This exact task result is already accepted.'
      : canAccept ? null
        : task.state !== 'Needs result review'
          ? `This task is ${task.state} and is not ready for result acceptance.`
          : 'The task specification or canonical document changed and must be reviewed before accepting this result.';
    const binding = {
      kind: 'task', projectId: project.id, projectRev: project.rev, taskId: task.id, taskRev: task.rev,
      state: task.state, candidate: task.candidate, candidateHash,
      sourceCandidate: task.sourceCandidate ?? null,
      spec: { id: spec.id, rev: spec.rev, hash: spec.hash, status: spec.status },
      canonicalHash,
    };
    const resolvedTarget = {
      ...target, candidate: structuredClone(task.candidate), candidateHash,
      sourceCandidate: task.sourceCandidate ? structuredClone(task.sourceCandidate) : null,
      specId: spec.id, specHash: spec.hash,
    };
    return {
      target,
      subject: `${project.name}: ${task.objective}`,
      binding,
      resolvedTarget,
      canAccept,
      accepted,
      reason,
      accept: () => domain.call('task.review', {
        taskId: task.id,
        expectedRev: task.rev,
        candidate: task.candidate,
        decision: 'accept',
        source: 'review.submit',
      }, actor),
    };
  }

  async function resolveTarget(target: Target, actor: Actor): Promise<Resolution> {
    return target.kind === 'document' ? resolveDocument(target, actor) : resolveTask(target, actor);
  }

  async function prepare(input: Json, actor: Actor) {
    const target = normalizeTarget(input.target);
    const resolution = await resolveTarget(target, actor);
    return {
      fingerprint: fingerprint(resolution.binding),
      canAccept: actor.role === 'owner' && resolution.canAccept,
      canRequest: actor.role === 'owner',
      acceptLabel: resolution.accepted ? 'Accepted' : 'Accept changes',
      reason: resolution.reason,
      subject: resolution.subject,
      target: resolution.resolvedTarget,
      feedback: feedbackFor(store, resolution),
      accepted: resolution.accepted,
    };
  }

  async function submit(input: Json, actor: Actor) {
    const target = normalizeTarget(input.target);
    assert(typeof input.fingerprint === 'string' && input.fingerprint.length > 0, 'fingerprint is required');
    assert(['accept', 'request_changes'].includes(input.decision), 'decision must be accept or request_changes');
    assert(typeof input.note === 'string', 'note must be a string');
    assert(typeof input.submissionId === 'string' && input.submissionId.trim(), 'submissionId is required');
    const note = input.note.trim();
    assert(note.length <= maxNoteLength, `note must be at most ${maxNoteLength} characters`);
    if (input.decision === 'request_changes') assert(note.length > 0, 'A note is required when requesting changes');
    const submissionKey = hash(canonical({ actor: { id: actor.id, role: actor.role }, submissionId: input.submissionId.trim() }));
    const signature = hash(canonical({ target, fingerprint: input.fingerprint, decision: input.decision, note }));
    const cached = store.get<any>('feedbackSubmission', submissionKey);
    if (cached) {
      assert(cached.signature === signature, 'submissionId was reused with different review content');
      return cached.result;
    }

    const prepared = await resolveTarget(target, actor);
    return store.tx(() => {
      const replay = store.get<any>('feedbackSubmission', submissionKey);
      if (replay) {
        assert(replay.signature === signature, 'submissionId was reused with different review content');
        return replay.result;
      }
      const current = target.kind === 'document'
        ? revalidateDocument(prepared, actor)
        : resolveTask(target, actor);
      assert(fingerprint(current.binding) === input.fingerprint, 'Review target changed. Prepare the decision again.');
      if (input.decision === 'accept') {
        assert(current.canAccept, current.reason ?? 'This target cannot be accepted.');
        current.accept();
      } else if (target.kind === 'task') {
        const task = store.require<Task>('task', target.taskId);
        if (task.state === 'Needs result review' && current.canAccept) {
          domain.call('task.review', {
            taskId: task.id,
            expectedRev: task.rev,
            candidate: task.candidate,
            decision: 'reject',
            source: 'review.submit',
            notes: note,
          }, actor);
        }
      }
      const feedback = store.put('feedback', {
        id: id('feedback'),
        projectId: target.projectId,
        decision: input.decision,
        target: current.resolvedTarget,
        subject: current.subject,
        actor: { id: actor.id, role: actor.role },
        at: now(),
        ...(note ? { note } : {}),
      });
      if (input.decision === 'request_changes') {
        domain.call('inbox.create', {
          projectId: target.projectId,
          kind: 'review change request',
          summary: `${current.subject}: ${note}`,
          data: { note, target: current.resolvedTarget, feedbackId: feedback.id, ...(target.kind === 'task' ? { taskId: target.taskId } : {}) },
        }, actor);
      }
      const result = {
        message: input.decision === 'accept' ? `${current.subject} accepted.` : `Changes requested for ${current.subject}. The note was saved in the project inbox.`,
        feedback,
      };
      store.put('feedbackSubmission', { id: submissionKey, signature, actor: { id: actor.id, role: actor.role }, result, at: now() });
      return result;
    });
  }

  function revalidateDocument(prepared: Resolution, actor: Actor): Resolution {
    const target = prepared.target as DocumentTarget;
    const project = store.require<Project>('project', target.projectId);
    const prior = prepared.binding;
    let selectedSpec: Spec | undefined;
    if (prior.selectedSpec?.id) selectedSpec = store.get<Spec>('spec', prior.selectedSpec.id);
    const latestSpec = store.list<Spec>('spec').filter(spec => spec.projectId === project.id && spec.path === target.path).at(-1);
    const binding = {
      ...prior,
      projectRev: project.rev,
      canonicalHash: currentFileHash(project, target.path),
      latestSpec: latestSpec ? { id: latestSpec.id, rev: latestSpec.rev, hash: latestSpec.hash, status: latestSpec.status } : null,
      selectedSpec: selectedSpec ? {
        id: selectedSpec.id, rev: selectedSpec.rev, hash: selectedSpec.hash, status: selectedSpec.status,
        requirementIds: selectedSpec.requirementIds, acceptedRequirementIds: selectedSpec.acceptedRequirementIds ?? null,
      } : null,
    };
    return { ...prepared, binding, accept: () => prepared.accept() };
  }

  return {
    actions: () => actions,
    call: async (name: string, input: Json, actor: Actor) => {
      if (name === 'review.prepare') {
        assert(['owner', 'guide', 'worker'].includes(actor.role), `Role ${actor.role} may not call ${name}`);
        return prepare(input, actor);
      }
      assert(name === 'review.submit', `Unknown feedback action: ${name}`);
      assert(actor.role === 'owner', `Role ${actor.role} may not call ${name}`);
      return submit(input, actor);
    },
  };
}
