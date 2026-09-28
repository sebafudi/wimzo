import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Actor } from './domain.ts';
import { Store, assert, type RecordValue } from './store.ts';

const execFileAsync = promisify(execFile);
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const gitTimeoutMs = 5_000;
const totalGitTimeoutMs = 15_000;
const maxGitMetadataBytes = 1_000_000;
const maxFiles = 100;
const maxPatchBytes = 200_000;
const maxTotalPatchBytes = 1_000_000;
const maxSpecBytes = 1_000_000;
const maxSpecLines = 2_000;
const maxMarkdownBytes = 200_000;
const maxTotalMarkdownBytes = 1_000_000;

type Json = Record<string, any>;
type Project = RecordValue & { name: string; root: string };
type Task = RecordValue & { projectId: string; specId: string; specHash: string; objective: string; state: string; sourceCandidate?: Json; candidate?: Json };
type Spec = RecordValue & { projectId: string; path: string; hash: string; content: string; status: string; previousId?: string; sourceRevision?: string };
type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type-changed' | 'unmerged' | 'unknown';
type MarkdownSnapshots = { before: string | null; after: string | null };
type ReviewFile = { path: string; status: FileStatus; patch: string; unavailableReason?: string; markdown?: MarkdownSnapshots; markdownUnavailableReason?: string };

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(cwd: string, args: string[], maxBuffer: number, timeout = gitTimeoutMs): Promise<Buffer> {
  const result = await execFileAsync('git', ['--no-optional-locks', ...args], {
    cwd,
    timeout,
    maxBuffer,
    encoding: 'buffer',
    env: gitEnvironment(),
  });
  return result.stdout as Buffer;
}

function exactCommit(value: unknown): { commit?: string; reason?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'No exact commit was persisted.' };
  const candidate = value as Json;
  if (candidate.dirty === true && !candidate.materializedCommit) return { reason: 'The persisted candidate is a dirty worktree snapshot, not an exact commit.' };
  const selected = candidate.materializedCommit ?? candidate.commit ?? candidate.sha ?? candidate.id;
  if (typeof selected !== 'string' || !commitPattern.test(selected)) return { reason: 'The persisted candidate does not contain a full commit ID.' };
  return { commit: selected };
}

function gitFailure(error: unknown): string {
  const value = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  if (value.killed || value.signal) return 'Git inspection exceeded its time limit.';
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git inspection exceeded its output limit.';
  return 'Git inspection is unavailable.';
}

function assertAccess(store: Store, actor: Actor, projectId: string, taskId?: string) {
  if (actor.role !== 'worker') return;
  assert(!!actor.taskId, 'Worker actor must be task-bound');
  if (taskId) assert(actor.taskId === taskId, 'Worker may access only its task');
  const bound = store.require<Task>('task', actor.taskId);
  assert(bound.projectId === projectId, 'Worker may access only its project');
}

function taskIdentity(task: Task) {
  return {
    taskId: task.id,
    projectId: task.projectId,
    specId: task.specId,
    specHash: task.specHash,
    sourceCandidate: task.sourceCandidate ?? null,
    candidate: task.candidate ?? null,
  };
}

function specIdentity(spec: Spec, previous?: Spec) {
  return {
    specId: spec.id,
    projectId: spec.projectId,
    path: spec.path,
    hash: spec.hash,
    previousSpecId: spec.previousId ?? null,
    previousHash: previous?.hash ?? null,
    sourceRevision: spec.sourceRevision ?? null,
  };
}

function statusName(code: string): FileStatus {
  switch (code[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

function parseNameStatus(output: Buffer): Array<{ path: string; oldPath?: string; status: FileStatus }> {
  const values = output.toString('utf8').split('\0');
  if (values.at(-1) === '') values.pop();
  const files: Array<{ path: string; oldPath?: string; status: FileStatus }> = [];
  for (let index = 0; index < values.length;) {
    const code = values[index++];
    assert(code, 'Git returned an invalid file status record');
    const status = statusName(code);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = values[index++], path = values[index++];
      assert(oldPath !== undefined && path !== undefined, 'Git returned an incomplete rename record');
      files.push({ path, oldPath, status });
    } else {
      const path = values[index++];
      assert(path !== undefined, 'Git returned an incomplete file status record');
      files.push({ path, status });
    }
  }
  return files;
}

function contentLines(content: string): { lines: string[]; finalNewline: boolean } {
  if (content === '') return { lines: [], finalNewline: false };
  const finalNewline = content.endsWith('\n');
  return { lines: (finalNewline ? content.slice(0, -1) : content).split('\n'), finalNewline };
}

function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function markdownBytes(snapshots: MarkdownSnapshots): number {
  let total = 0;
  for (const content of [snapshots.before, snapshots.after]) {
    if (content === null) continue;
    assert(!content.includes('\0'), 'Binary content cannot be rendered as Markdown.');
    const bytes = Buffer.byteLength(content);
    assert(bytes <= maxMarkdownBytes, `Markdown snapshot exceeds the ${maxMarkdownBytes} byte limit.`);
    assert(contentLines(content).lines.length <= maxSpecLines, `Markdown snapshot exceeds the ${maxSpecLines} line limit.`);
    total += bytes;
  }
  return total;
}

type LineOp = { type: 'context' | 'add' | 'delete'; text: string; oldLine?: number; newLine?: number; oldNoNewline?: boolean; newNoNewline?: boolean };

export function lineOperations(before: string, after: string): LineOp[] {
  const oldValue = contentLines(before), newValue = contentLines(after);
  const oldLines = oldValue.lines, newLines = newValue.lines;
  assert(oldLines.length <= maxSpecLines && newLines.length <= maxSpecLines, `Specification diff exceeds the ${maxSpecLines} line limit`);
  const width = newLines.length + 1;
  const lengths = new Uint16Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const cell = oldIndex * width + newIndex;
      lengths[cell] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(lengths[(oldIndex + 1) * width + newIndex], lengths[cell + 1]);
    }
  }
  const operations: LineOp[] = [];
  let oldIndex = 0, newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const newlineOnlyChange = oldIndex === oldLines.length - 1 && newIndex === newLines.length - 1 && oldValue.finalNewline !== newValue.finalNewline;
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex] && newlineOnlyChange) {
      operations.push({ type: 'delete', text: oldLines[oldIndex], oldLine: oldIndex + 1, oldNoNewline: !oldValue.finalNewline });
      operations.push({ type: 'add', text: newLines[newIndex], newLine: newIndex + 1, newNoNewline: !newValue.finalNewline });
      oldIndex++; newIndex++;
    } else if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ type: 'context', text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1, oldNoNewline: oldIndex === oldLines.length - 1 && !oldValue.finalNewline, newNoNewline: newIndex === newLines.length - 1 && !newValue.finalNewline });
      oldIndex++; newIndex++;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || lengths[oldIndex * width + newIndex + 1] >= lengths[(oldIndex + 1) * width + newIndex])) {
      operations.push({ type: 'add', text: newLines[newIndex], newLine: newIndex + 1, newNoNewline: newIndex === newLines.length - 1 && !newValue.finalNewline });
      newIndex++;
    } else {
      operations.push({ type: 'delete', text: oldLines[oldIndex], oldLine: oldIndex + 1, oldNoNewline: oldIndex === oldLines.length - 1 && !oldValue.finalNewline });
      oldIndex++;
    }
  }
  return operations;
}

export function unifiedPatch(path: string, before: string | undefined, after: string | undefined): string {
  assert(Buffer.byteLength(before ?? '') <= maxSpecBytes && Buffer.byteLength(after ?? '') <= maxSpecBytes, `Specification diff exceeds the ${maxSpecBytes} byte input limit`);
  const initial = before === undefined;
  const deleted = after === undefined;
  const operations = lineOperations(before ?? '', after ?? '');
  const changed = operations.flatMap((operation, index) => operation.type === 'context' ? [] : [index]);
  const header = [`diff --git a/${path} b/${path}`, `--- ${initial ? '/dev/null' : `a/${path}`}`, `+++ ${deleted ? '/dev/null' : `b/${path}`}`];
  if (!changed.length) return `${header.join('\n')}\n`;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3), end = Math.min(operations.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const body: string[] = [];
  for (const range of ranges) {
    const beforeRange = operations.slice(0, range.start);
    const hunk = operations.slice(range.start, range.end);
    const oldBefore = beforeRange.filter(operation => operation.type !== 'add').length;
    const newBefore = beforeRange.filter(operation => operation.type !== 'delete').length;
    const oldCount = hunk.filter(operation => operation.type !== 'add').length;
    const newCount = hunk.filter(operation => operation.type !== 'delete').length;
    const oldStart = oldCount ? oldBefore + 1 : oldBefore;
    const newStart = newCount ? newBefore + 1 : newBefore;
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of hunk) {
      body.push(`${operation.type === 'context' ? ' ' : operation.type === 'add' ? '+' : '-'}${operation.text}`);
      if ((operation.type !== 'add' && operation.oldNoNewline) || (operation.type !== 'delete' && operation.newNoNewline)) body.push('\\ No newline at end of file');
    }
  }
  return `${[...header, ...body].join('\n')}\n`;
}

export function Review(store: Store) {
  const actions = [{
    name: 'review.diff',
    description: 'Read a bounded before-and-after diff for one persisted task candidate or specification snapshot.',
    roles: ['owner', 'guide', 'worker', 'system'],
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Persisted task ID.' },
        specId: { type: 'string', description: 'Persisted specification snapshot ID.' },
      },
      additionalProperties: false,
      oneOf: [
        { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', description: 'Persisted task ID.' } }, additionalProperties: false },
        { type: 'object', required: ['specId'], properties: { specId: { type: 'string', description: 'Persisted specification snapshot ID.' } }, additionalProperties: false },
      ],
    },
  }];

  async function taskDiff(taskId: string, actor: Actor) {
    const task = store.require<Task>('task', taskId);
    assertAccess(store, actor, task.projectId, task.id);
    const project = store.require<Project>('project', task.projectId);
    const identity = taskIdentity(task);
    const unavailable = (warning: string) => ({ kind: 'task' as const, title: task.objective, status: task.state, baseLabel: 'Approved source', afterLabel: 'Candidate result', files: [] as ReviewFile[], warnings: [warning], identity });
    const run = task.runId ? store.get('run', task.runId) : null;
    if (run && run.taskId !== task.id) return unavailable('The saved worker run belongs to a different task.');
    const source = exactCommit(run?.resolvedWorkflowSource?.commit ? { commit: run.resolvedWorkflowSource.commit } : task.sourceCandidate);
    if (!source.commit) return unavailable(`Source unavailable: ${source.reason}`);
    if (!task.candidate) return unavailable(`No finalized candidate is available while the task status is ${task.state}.`);
    const candidate = exactCommit(task.candidate);
    if (!candidate.commit) return unavailable(`Candidate unavailable: ${candidate.reason}`);
    if (!existsSync(project.root)) return unavailable('Registered project repository is unavailable.');

    let repository: string;
    const gitDeadline = Date.now() + totalGitTimeoutMs;
    const readGit = (args: string[], maxBuffer: number) => {
      const remaining = gitDeadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('Git time limit'), { killed: true });
      return git(repository, args, maxBuffer, Math.min(gitTimeoutMs, remaining));
    };
    try {
      repository = realpathSync(project.root);
      const topLevel = (await readGit(['rev-parse', '--show-toplevel'], maxGitMetadataBytes)).toString('utf8').trim();
      if (realpathSync(topLevel) !== repository) return unavailable('Registered project root is not the Git repository root.');
      for (const [label, commit] of [['source', source.commit], ['candidate', candidate.commit]] as const) {
        const resolved = (await readGit(['rev-parse', '--verify', `${commit}^{commit}`], maxGitMetadataBytes)).toString('utf8').trim();
        if (resolved.toLowerCase() !== commit.toLowerCase()) return unavailable(`Persisted ${label} reference is not an exact commit.`);
      }
    } catch (error) { return unavailable(gitFailure(error)); }

    const warnings: string[] = [];
    let changed: Array<{ path: string; oldPath?: string; status: FileStatus }>;
    try {
      const output = await readGit(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', '--find-copies', source.commit, candidate.commit, '--'], maxGitMetadataBytes);
      changed = parseNameStatus(output);
    } catch (error) { return unavailable(gitFailure(error)); }
    if (changed.length > maxFiles) warnings.push(`Showing the first ${maxFiles} of ${changed.length} changed files.`);
    const files: ReviewFile[] = [];
    let totalPatchBytes = 0;
    for (const changedFile of changed.slice(0, maxFiles)) {
      if (totalPatchBytes >= maxTotalPatchBytes) {
        files.push({ path: changedFile.path, status: changedFile.status, patch: '', unavailableReason: `Total patch output exceeded ${maxTotalPatchBytes} bytes.` });
        continue;
      }
      try {
        const paths = changedFile.oldPath ? [changedFile.oldPath, changedFile.path] : [changedFile.path];
        const output = await readGit(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--find-copies', source.commit, candidate.commit, '--', ...paths], maxPatchBytes + 1);
        const patch = output.toString('utf8');
        const bytes = Buffer.byteLength(patch);
        if (/^Binary files .* differ$/m.test(patch)) {
          const reason = 'Binary content changed; no text preview is available.';
          warnings.push(`${changedFile.path}: ${reason}`);
          files.push({ path: changedFile.path, status: changedFile.status, patch: '', unavailableReason: reason });
        } else if (bytes > maxPatchBytes || totalPatchBytes + bytes > maxTotalPatchBytes) {
          const reason = bytes > maxPatchBytes ? `Patch exceeded the ${maxPatchBytes} byte file limit.` : `Patch exceeded the ${maxTotalPatchBytes} byte total limit.`;
          warnings.push(`${changedFile.path}: ${reason}`);
          files.push({ path: changedFile.path, status: changedFile.status, patch: '', unavailableReason: reason });
        } else {
          totalPatchBytes += bytes;
          files.push({ path: changedFile.path, status: changedFile.status, patch });
        }
      } catch (error) {
        const reason = gitFailure(error).replace('Git inspection exceeded its output limit.', `Patch exceeded the ${maxPatchBytes} byte file limit.`);
        warnings.push(`${changedFile.path}: ${reason}`);
        files.push({ path: changedFile.path, status: changedFile.status, patch: '', unavailableReason: reason });
      }
    }
    let totalMarkdownBytes = 0;
    for (const [index, file] of files.entries()) {
      if (!isMarkdown(file.path)) continue;
      const changedFile = changed[index];
      try {
        assert(!file.unavailableReason?.startsWith('Binary content'), 'Binary content cannot be rendered as Markdown.');
        assert(totalMarkdownBytes < maxTotalMarkdownBytes, `Markdown snapshots exceed the ${maxTotalMarkdownBytes} byte total limit.`);
        const readSnapshot = async (commit: string, path: string): Promise<string> => {
          const output = await readGit(['cat-file', 'blob', `${commit}:${path}`], maxMarkdownBytes + 1);
          assert(!output.includes(0), 'Binary content cannot be rendered as Markdown.');
          try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output); }
          catch { throw new Error('Binary or invalid UTF-8 content cannot be rendered as Markdown.'); }
        };
        const before = file.status === 'added' ? null : await readSnapshot(source.commit, changedFile.oldPath ?? file.path);
        const after = file.status === 'deleted' ? null : await readSnapshot(candidate.commit, file.path);
        const snapshots = { before, after };
        const bytes = markdownBytes(snapshots);
        assert(totalMarkdownBytes + bytes <= maxTotalMarkdownBytes, `Markdown snapshots exceed the ${maxTotalMarkdownBytes} byte total limit.`);
        totalMarkdownBytes += bytes;
        file.markdown = snapshots;
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        const reason = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? `Markdown snapshot exceeds the ${maxMarkdownBytes} byte limit.`
          : failure.code || failure.killed || failure.signal
            ? gitFailure(error) : (error as Error).message;
        file.markdownUnavailableReason = reason;
      }
    }
    return { kind: 'task' as const, title: task.objective, status: task.state, baseLabel: 'Approved source', afterLabel: 'Candidate result', files, warnings, identity };
  }

  function specDiff(specId: string, actor: Actor) {
    const spec = store.require<Spec>('spec', specId);
    assertAccess(store, actor, spec.projectId);
    const project = store.require<Project>('project', spec.projectId);
    const previous = spec.previousId ? store.get<Spec>('spec', spec.previousId) : undefined;
    const identity = specIdentity(spec, previous);
    const initial = !previous;
    const warnings: string[] = [];
    if (spec.previousId && !previous) {
      const reason = 'The previous specification snapshot is unavailable.';
      return { kind: 'spec' as const, title: `${project.name}: ${spec.path}`, status: spec.status, baseLabel: 'Previous snapshot unavailable', afterLabel: 'Current proposal', files: [{ path: spec.path, status: 'modified' as const, patch: '', unavailableReason: reason }], warnings: [reason], identity };
    }
    if (previous && (previous.projectId !== spec.projectId || previous.path !== spec.path)) {
      const reason = 'The previous specification snapshot does not match this project and path.';
      return { kind: 'spec' as const, title: `${project.name}: ${spec.path}`, status: spec.status, baseLabel: 'Previous snapshot unavailable', afterLabel: 'Current proposal', files: [{ path: spec.path, status: 'modified' as const, patch: '', unavailableReason: reason }], warnings: [reason], identity };
    }
    let file: ReviewFile;
    try {
      const patch = unifiedPatch(spec.path, previous?.content, spec.content);
      if (Buffer.byteLength(patch) > maxPatchBytes) {
        const reason = `Patch exceeded the ${maxPatchBytes} byte file limit.`;
        warnings.push(reason);
        file = { path: spec.path, status: initial ? 'added' : 'modified', patch: '', unavailableReason: reason };
      } else file = { path: spec.path, status: initial ? 'added' : 'modified', patch };
    } catch (error) {
      const reason = (error as Error).message;
      warnings.push(reason);
      file = { path: spec.path, status: initial ? 'added' : 'modified', patch: '', unavailableReason: reason };
    }
    if (isMarkdown(spec.path)) {
      try {
        const snapshots = { before: previous?.content ?? null, after: spec.content };
        markdownBytes(snapshots);
        file.markdown = snapshots;
      } catch (error) { file.markdownUnavailableReason = (error as Error).message; }
    }
    return {
      kind: 'spec' as const,
      title: `${project.name}: ${spec.path}`,
      status: spec.status,
      baseLabel: initial ? 'No previous snapshot' : 'Previous snapshot',
      afterLabel: initial ? 'Initial proposal' : 'Current proposal',
      files: [file],
      warnings,
      identity,
    };
  }

  return {
    actions: () => actions,
    call: async (name: string, input: Json, actor: Actor) => {
      assert(name === 'review.diff', `Unknown review action: ${name}`);
      return input.taskId !== undefined ? taskDiff(input.taskId, actor) : specDiff(input.specId, actor);
    },
  };
}
