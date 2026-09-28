import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Actor } from './domain.ts';
import { productMap, documentProvenance } from './product-map.ts';
import { unifiedPatch } from './review.ts';
import { Store, assert, type RecordValue } from './store.ts';

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 5_000;
const totalGitTimeoutMs = 15_000;
const maxGitOutputBytes = 2_000_000;
const maxGitVersions = 1_000;
const maxTreeFiles = 1_000;
const maxTreeEntries = 10_000;
const maxTreeDepth = 32;
const maxMarkdownBytes = 200_000;
const maxMarkdownLines = 2_000;
const defaultHistoryLimit = 50;
const maxHistoryLimit = 100;
const fullCommitPattern = /^[0-9a-f]{40}$/i;
const skippedSegments = new Set(['.git', '.wimzo', 'node_modules']);

type Json = Record<string, any>;
type Project = RecordValue & { name: string; root: string; canonicalPaths: string[] };
type Task = RecordValue & { projectId: string };
type Spec = RecordValue & { projectId: string; path: string; content: string; status: string; capturedAt: string };
type VersionSource = 'snapshot' | 'git';
type WorkingChange = 'M' | 'A' | 'D';
type PublicVersion = {
  id: string;
  label: string;
  at: string;
  source: VersionSource;
  status?: string;
  previousVersionId?: string | null;
  previousVersionKnown?: boolean;
};
type InternalVersion = PublicVersion & { content?: string | null; historicalPath?: string; spec?: Spec; deleted?: boolean };

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

class GitReader {
  readonly root: string;
  private deadline = Date.now() + totalGitTimeoutMs;
  private remainingBytes = maxGitOutputBytes;

  private constructor(root: string) { this.root = root; }

  static async open(projectRoot: string): Promise<GitReader> {
    const root = realpathSync(projectRoot);
    const reader = new GitReader(root);
    const top = (await reader.run(['rev-parse', '--show-toplevel'], 100_000)).toString('utf8').trim();
    assert(realpathSync(top) === root, 'Registered project root is not the Git repository root.');
    await reader.run(['rev-parse', '--verify', 'HEAD^{commit}'], 100_000);
    return reader;
  }

  async run(args: string[], limit: number): Promise<Buffer> {
    const remainingMs = this.deadline - Date.now();
    assert(remainingMs > 0, 'Git inspection exceeded its time limit.');
    assert(this.remainingBytes > 0, 'Git inspection exceeded its total output limit.');
    const maxBuffer = Math.min(limit, this.remainingBytes) + 1;
    try {
      const result = await execFileAsync('git', ['--no-optional-locks', ...args], {
        cwd: this.root,
        timeout: Math.min(gitTimeoutMs, remainingMs),
        maxBuffer,
        encoding: 'buffer',
        env: gitEnvironment(),
      });
      const output = result.stdout as Buffer;
      assert(output.length <= limit, 'Git inspection exceeded its output limit.');
      this.remainingBytes -= output.length;
      return output;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (failure.killed || failure.signal) throw new Error('Git inspection exceeded its time limit.');
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git inspection exceeded its output limit.');
      throw new Error('Git inspection is unavailable.');
    }
  }
}

function assertAccess(store: Store, actor: Actor, projectId: string) {
  if (actor.role !== 'worker') return;
  assert(!!actor.taskId, 'Worker actor must be task-bound');
  const task = store.require<Task>('task', actor.taskId);
  assert(task.projectId === projectId, 'Worker may access only its project');
}

function projectFor(store: Store, actor: Actor, projectId: unknown): Project {
  assert(typeof projectId === 'string' && projectId.length > 0, 'projectId is required');
  const project = store.require<Project>('project', projectId);
  assertAccess(store, actor, project.id);
  assert(existsSync(project.root), 'Registered project root is unavailable');
  assert(realpathSync(project.root) === project.root, 'Registered project root has changed');
  return project;
}

function normalizePath(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0, 'path is required');
  assert(!isAbsolute(value), 'Document path must be relative');
  assert(!value.includes('\0') && !/[\r\n]/.test(value), 'Document path contains invalid characters');
  const parts = value.split('/');
  assert(parts.every(part => part.length > 0 && part !== '.' && part !== '..'), 'Document path is invalid');
  assert(!parts.some(part => skippedSegments.has(part)), 'Document path is outside project document roots');
  return parts.join('/');
}

function assertNoSymlink(project: Project, path: string) {
  let current = project.root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (!existsSync(current)) break;
    assert(!lstatSync(current).isSymbolicLink(), 'Document path may not contain symlinks');
  }
  const lexical = relative(project.root, resolve(project.root, path));
  assert(lexical === path && !lexical.startsWith('..') && !isAbsolute(lexical), 'Document path escapes project root');
}

function isMarkdown(path: string): boolean { return /\.(?:md|markdown)$/i.test(path); }

function specPath(path: string): boolean {
  return path.startsWith('spec/') && isMarkdown(path) && !path.split('/').some(part => skippedSegments.has(part));
}

function legacyDecisionPath(path: string): boolean {
  const parts = path.split('/');
  return parts[0] === 'spec' && parts.slice(1, -1).includes('decisions');
}

function discoverCurrentSpecFiles(project: Project, warnings: string[]): string[] {
  const root = resolve(project.root, 'spec');
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) {
    warnings.push('Skipped spec because it is a symbolic link.');
    return [];
  }
  const found: string[] = [];
  let visited = 0;
  let exhausted = false;
  const visit = (directory: string, depth: number) => {
    if (exhausted) return;
    if (depth > maxTreeDepth) {
      warnings.push(`Stopped spec discovery at the ${maxTreeDepth} directory depth limit.`);
      exhausted = true;
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited++;
      if (visited > maxTreeEntries) {
        warnings.push(`Stopped spec discovery after ${maxTreeEntries} filesystem entries.`);
        exhausted = true;
        return;
      }
      if (skippedSegments.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(project.root, absolute).split('\\').join('/');
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link ${path}.`);
      } else if (entry.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (entry.isFile() && specPath(path)) {
        found.push(path);
      }
      if (found.length > maxTreeFiles) {
        exhausted = true;
        return;
      }
    }
  };
  visit(root, 0);
  return found;
}

async function discoverGitSpecFiles(project: Project, warnings: string[]): Promise<string[]> {
  try {
    const git = await GitReader.open(project.root);
    const output = await git.run(['--literal-pathspecs', 'log', 'HEAD', '--format=', '-z', '--name-only', '--', 'spec'], 1_000_000);
    const paths = output.toString('utf8').split('\0').filter(path => path.length > 0 && specPath(path));
    return [...new Set(paths)];
  } catch (error) {
    warnings.push((error as Error).message);
    return [];
  }
}

function recordWorkingChange(changes: Map<string, WorkingChange>, path: string | undefined, change: WorkingChange) {
  if (!path) return;
  try { changes.set(normalizePath(path), change); } catch {}
}

function parseGitStatus(output: Buffer): Map<string, WorkingChange> {
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output); }
  catch { throw new Error('Git working status contains an invalid UTF-8 path.'); }
  const records = value.split('\0');
  const changes = new Map<string, WorkingChange>();
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record) continue;
    assert(record.length >= 4 && record[2] === ' ', 'Git working status is malformed.');
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code === '!!') continue;
    if (code.includes('R') || code.includes('C')) {
      const previousPath = records[index++];
      recordWorkingChange(changes, path, 'A');
      if (code.includes('R')) recordWorkingChange(changes, previousPath, 'D');
      continue;
    }
    const [indexCode, worktreeCode] = code;
    const change: WorkingChange = code === '??' || indexCode === 'A'
      ? 'A'
      : indexCode === 'D' || worktreeCode === 'D'
        ? 'D'
        : 'M';
    recordWorkingChange(changes, path, change);
  }
  return changes;
}

type LineCounts = { additions: number; deletions: number };

async function workingChanges(project: Project, paths: string[], warnings: string[]) {
  const changes = new Map<string, WorkingChange>();
  const counts = new Map<string, LineCounts>();
  const unavailable = new Map<string, string>();
  try {
    const git = await GitReader.open(project.root);
    const status = await git.run([
      '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ], 1_000_000);
    const known = new Set(paths);
    for (const [path, change] of parseGitStatus(status)) if (known.has(path)) changes.set(path, change);
    if (!changes.size) return { changes, counts, unavailable };
    try {
      // HEAD to working tree gives the net change, without double-counting staged edits.
      const output = await git.run([
        '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', 'HEAD', '--', ...changes.keys(),
      ], 1_000_000);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
      for (const record of text.split('\0').filter(Boolean)) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
        assert(match, 'Git line counts are malformed.');
        const [, added, removed, path] = match;
        if (!changes.has(path)) continue;
        if (added === '-' || removed === '-') unavailable.set(path, 'Binary file: line counts unavailable');
        else counts.set(path, { additions: Number(added), deletions: Number(removed) });
      }
      let remainingBytes = maxGitOutputBytes;
      for (const [path, change] of changes) {
        if (counts.has(path) || unavailable.has(path)) continue;
        // Git diff omits untracked files. Count their bounded text as additions.
        const absolute = resolve(project.root, path);
        if (change === 'A' && existsSync(absolute)) {
          try {
            assertNoSymlink(project, path);
            const stat = statSync(absolute);
            assert(stat.isFile() && stat.size <= maxMarkdownBytes && stat.size <= remainingBytes, 'File exceeds the line-count size limit');
            remainingBytes -= stat.size;
            const bytes = readFileSync(absolute);
            assert(!bytes.includes(0), 'Binary file: line counts unavailable');
            const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            counts.set(path, { additions: content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0, deletions: 0 });
          } catch (error) { unavailable.set(path, (error as Error).message); }
        } else counts.set(path, { additions: 0, deletions: 0 });
      }
    } catch (error) {
      for (const path of changes.keys()) { counts.delete(path); unavailable.set(path, 'Line counts unavailable: ' + (error as Error).message); }
    }
  } catch (error) { warnings.push((error as Error).message); }
  return { changes, counts, unavailable };
}

function snapshots(store: Store, projectId: string, path?: string): Spec[] {
  return store.list<Spec>('spec').filter(spec => spec.projectId === projectId && (path === undefined || spec.path === path));
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'unknown date' : date.toISOString().slice(0, 10);
}

function heading(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const match = content.slice(0, maxMarkdownBytes).match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  return match?.[1]?.trim() || undefined;
}

function validateMarkdown(content: string | null): string | null {
  if (content === null) return null;
  assert(!content.includes('\0'), 'Binary content cannot be rendered as Markdown.');
  assert(Buffer.byteLength(content) <= maxMarkdownBytes, `Markdown snapshot exceeds the ${maxMarkdownBytes} byte limit.`);
  const lines = content === '' ? 0 : content.split('\n').length;
  assert(lines <= maxMarkdownLines, `Markdown snapshot exceeds the ${maxMarkdownLines} line limit.`);
  return content;
}

async function catalog(store: Store, project: Project, includeLegacyDecisions = false): Promise<{ paths: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const paths = new Set<string>();
  for (const source of project.canonicalPaths) {
    try {
      const path = normalizePath(source);
      assertNoSymlink(project, path);
      paths.add(path);
    } catch (error) { warnings.push(`${source}: ${(error as Error).message}`); }
  }
  for (const spec of snapshots(store, project.id)) {
    try {
      const path = normalizePath(spec.path);
      assertNoSymlink(project, path);
      paths.add(path);
    } catch (error) { warnings.push(`${spec.path}: ${(error as Error).message}`); }
  }
  for (const path of discoverCurrentSpecFiles(project, warnings)) paths.add(path);
  for (const path of await discoverGitSpecFiles(project, warnings)) {
    try {
      assertNoSymlink(project, path);
      paths.add(path);
    } catch (error) { warnings.push(`${path}: ${(error as Error).message}`); }
  }
  const sorted = [...paths].filter(path => includeLegacyDecisions || !legacyDecisionPath(path)).sort((left, right) => left.localeCompare(right));
  if (sorted.length > maxTreeFiles) {
    warnings.push(`Showing the first ${maxTreeFiles} of ${sorted.length} requirement documents.`);
    return { paths: sorted.slice(0, maxTreeFiles), warnings };
  }
  return { paths: sorted, warnings };
}

function parseGitLog(output: string, requestedPath: string, warnings: string[]): { versions: InternalVersion[]; truncated: boolean } {
  const records = output.split('\x1e').filter(Boolean);
  const truncated = records.length > maxGitVersions;
  if (truncated) warnings.push(`Showing the newest ${maxGitVersions} Git versions.`);
  let historicalPath = requestedPath;
  const versions: InternalVersion[] = [];
  for (const record of records.slice(0, maxGitVersions)) {
    const trimmed = record.replace(/^\n+/, '');
    const boundary = trimmed.indexOf('\0');
    const metadata = (boundary === -1 ? trimmed : trimmed.slice(0, boundary)).split('\x1f');
    const [commit, at, rawSubject = ''] = metadata;
    if (!fullCommitPattern.test(commit ?? '') || !at) continue;
    let commitPath = historicalPath;
    let deleted = false;
    const fields = boundary === -1 ? [] : trimmed.slice(boundary + 1).split('\0');
    for (let index = 0; index < fields.length;) {
      const code = fields[index++].replace(/^\n+/, '');
      if (!code) continue;
      const firstPath = fields[index++];
      if (code.startsWith('R') || code.startsWith('C')) {
        const secondPath = fields[index++];
        if (secondPath === historicalPath) {
          commitPath = secondPath;
          historicalPath = firstPath;
        }
      } else if (firstPath === historicalPath) {
        commitPath = firstPath;
        deleted = code.startsWith('D');
      }
    }
    const subject = rawSubject.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    versions.push({
      id: `git:${commit.toLowerCase()}`,
      label: subject || `Git version, ${readableDate(at)}`,
      at,
      source: 'git',
      historicalPath: commitPath,
      deleted,
    });
  }
  return { versions, truncated };
}

async function gitVersions(project: Project, path: string, warnings: string[]): Promise<{ git?: GitReader; versions: InternalVersion[]; historyComplete: boolean }> {
  try {
    const git = await GitReader.open(project.root);
    const output = await git.run([
      '--literal-pathspecs', 'log', 'HEAD', '--follow', `--max-count=${maxGitVersions + 1}`,
      '--format=%x1e%H%x1f%cI%x1f%s', '--name-status', '-z', '--', path,
    ], 1_000_000);
    const parsed = parseGitLog(output.toString('utf8'), path, warnings);
    return { git, versions: parsed.versions, historyComplete: !parsed.truncated };
  } catch (error) {
    warnings.push((error as Error).message);
    return { versions: [], historyComplete: false };
  }
}

async function allVersions(store: Store, project: Project, path: string, warnings: string[]): Promise<{ versions: InternalVersion[]; git?: GitReader; historyComplete: boolean }> {
  const snapshotVersions: InternalVersion[] = snapshots(store, project.id, path).map(spec => ({
    id: `spec:${spec.id}`,
    label: `${spec.status} snapshot, ${readableDate(spec.capturedAt)}`,
    at: spec.capturedAt,
    source: 'snapshot',
    status: spec.status,
    content: spec.content,
    spec,
  }));
  const gitResult = await gitVersions(project, path, warnings);
  const versions = [...snapshotVersions, ...gitResult.versions].sort((left, right) => {
    const byDate = Date.parse(right.at) - Date.parse(left.at);
    return Number.isNaN(byDate) || byDate === 0 ? 0 : byDate;
  });
  return { versions, git: gitResult.git, historyComplete: gitResult.historyComplete };
}

async function assertKnownPath(store: Store, project: Project, rawPath: unknown): Promise<string> {
  const path = normalizePath(rawPath);
  assertNoSymlink(project, path);
  const available = await catalog(store, project, true);
  assert(available.paths.includes(path), 'Unknown project requirement document path');
  return path;
}

async function readVersionContent(git: GitReader | undefined, version: InternalVersion): Promise<string | null> {
  if (version.source === 'snapshot') return version.content ?? null;
  if (version.deleted) return null;
  assert(git && version.historicalPath, 'Git version content is unavailable.');
  const commit = version.id.slice(4);
  assert(fullCommitPattern.test(commit), 'Unknown Git revision');
  const output = await git.run(['cat-file', 'blob', `${commit}:${version.historicalPath}`], maxMarkdownBytes);
  assert(!output.includes(0), 'Binary content cannot be rendered as Markdown.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output); }
  catch { throw new Error('Binary or invalid UTF-8 content cannot be rendered as Markdown.'); }
}

export function Documents(store: Store) {
  const roles = ['owner', 'guide', 'worker', 'system'];
  const actions = [
    {name:'review.map',description:'Read the project feature map from requirement folders and explicit PRD links.',roles,inputSchema:{type:'object',required:['projectId'],additionalProperties:false,properties:{projectId:{type:'string'}}}},
    {name:'review.provenance',description:'Attribute document lines to accepted specification snapshots and their originating requests when recorded.',roles,inputSchema:{type:'object',required:['projectId','path'],additionalProperties:false,properties:{projectId:{type:'string'},path:{type:'string'},versionId:{type:'string'}}}},
    {
      name: 'review.tree',
      description: 'Read the bounded requirement-document tree for one managed project.',
      roles,
      inputSchema: {
        type: 'object', required: ['projectId'], additionalProperties: false,
        properties: { projectId: { type: 'string', description: 'Stable managed-project ID.' } },
      },
    },
    {
      name: 'review.history',
      description: 'Read saved snapshot and local Git history for one project requirement document.',
      roles,
      inputSchema: {
        type: 'object', required: ['projectId', 'path'], additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Stable managed-project ID.' },
          path: { type: 'string', description: 'Project-relative requirement document path.' },
          offset: { type: 'integer', description: 'Zero-based version offset.' },
          limit: { type: 'integer', description: `Page size, at most ${maxHistoryLimit}.` },
        },
      },
    },
    {
      name: 'review.compare',
      description: 'Compare any two listed saved versions of one project requirement document.',
      roles,
      inputSchema: {
        type: 'object', required: ['projectId', 'path', 'beforeVersion', 'afterVersion'], additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Stable managed-project ID.' },
          path: { type: 'string', description: 'Project-relative requirement document path.' },
          beforeVersion: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Listed saved version ID, or null for an empty document.' },
          afterVersion: { type: 'string', description: 'Listed saved version ID.' },
        },
      },
    },
  ];

  async function tree(input: Json, actor: Actor) {
    const project = projectFor(store, actor, input.projectId);
    const found = await catalog(store, project);
    const { changes, counts, unavailable } = await workingChanges(project, found.paths, found.warnings);
    const projectSnapshots = snapshots(store, project.id);
    const files = found.paths.map(path => {
      const values = projectSnapshots.filter(spec => spec.path === path).sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
      let content = values[0]?.content;
      const absolute = resolve(project.root, path);
      if (!content && existsSync(absolute) && !lstatSync(absolute).isSymbolicLink() && statSync(absolute).size <= maxMarkdownBytes) {
        try { content = readFileSync(absolute, 'utf8'); } catch {}
      }
      return {
        path,
        ...(heading(content) ? { title: heading(content) } : {}),
        ...(values[0]?.status ? { status: values[0].status } : {}),
        ...(changes.get(path) ? { workingChange: changes.get(path), workingDiff: counts.get(path) ?? null, ...(unavailable.has(path) ? { workingDiffUnavailable: unavailable.get(path) } : {}) } : {}),
        snapshotCount: values.length,
      };
    });
    return { projectId: project.id, files, warnings: [...new Set(found.warnings)] };
  }

  async function history(input: Json, actor: Actor) {
    const project = projectFor(store, actor, input.projectId);
    const path = await assertKnownPath(store, project, input.path);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? defaultHistoryLimit;
    assert(Number.isInteger(offset) && offset >= 0, 'offset must be a nonnegative integer');
    assert(Number.isInteger(limit) && limit >= 1 && limit <= maxHistoryLimit, `limit must be between 1 and ${maxHistoryLimit}`);
    const warnings: string[] = [];
    const { versions, historyComplete } = await allVersions(store, project, path, warnings);
    const listed = versions.map(({ id, label, at, source, status }, index): PublicVersion => ({
      id,
      label,
      at,
      source,
      ...(status ? { status } : {}),
      previousVersionId: versions[index + 1]?.id ?? null,
      ...(!historyComplete && index === versions.length - 1 ? { previousVersionKnown: false } : {}),
    }));
    const page = listed.slice(offset, offset + limit);
    const nextOffset = offset + page.length < versions.length ? offset + page.length : null;
    return { projectId: project.id, path, versions: page, nextOffset, warnings: [...new Set(warnings)] };
  }

  async function compare(input: Json, actor: Actor) {
    const project = projectFor(store, actor, input.projectId);
    const path = await assertKnownPath(store, project, input.path);
    assert(input.beforeVersion === null || typeof input.beforeVersion === 'string', 'beforeVersion must be a saved version ID or null');
    assert(typeof input.afterVersion === 'string' && input.afterVersion.length > 0, 'afterVersion is required');
    const warnings: string[] = [];
    const { versions, git } = await allVersions(store, project, path, warnings);
    const indexed = new Map(versions.map(version => [version.id, version]));
    const before = input.beforeVersion === null ? undefined : indexed.get(input.beforeVersion);
    const after = indexed.get(input.afterVersion);
    assert(input.beforeVersion === null || before, 'Unknown saved beforeVersion for this project document');
    assert(after, 'Unknown saved afterVersion for this project document');
    const identity = {
      projectId: project.id,
      path,
      beforeVersion: input.beforeVersion,
      afterVersion: input.afterVersion,
    };
    const status = after.status ?? 'Git history';
    const fileStatus = input.beforeVersion === null ? 'added' : after.deleted ? 'deleted' : 'modified';
    try {
      const beforeContent = before ? validateMarkdown(await readVersionContent(git, before)) : null;
      const afterContent = validateMarkdown(await readVersionContent(git, after));
      const patch = unifiedPatch(path, beforeContent === null ? undefined : beforeContent, afterContent === null ? undefined : afterContent);
      assert(Buffer.byteLength(patch) <= maxMarkdownBytes, `Patch exceeded the ${maxMarkdownBytes} byte file limit.`);
      return {
        kind: 'document' as const,
        title: `${project.name}: ${path}`,
        status,
        baseLabel: before?.label ?? 'Empty document',
        afterLabel: after.label,
        files: [{ path, status: fileStatus, patch, markdown: { before: beforeContent, after: afterContent } }],
        warnings: [...new Set(warnings)],
        identity,
      };
    } catch (error) {
      const reason = (error as Error).message;
      return {
        kind: 'document' as const,
        title: `${project.name}: ${path}`,
        status,
        baseLabel: before?.label ?? 'Empty document',
        afterLabel: after.label,
        files: [{ path, status: fileStatus, patch: '', unavailableReason: reason }],
        warnings: [...new Set([...warnings, reason])],
        identity,
      };
    }
  }

  return {
    actions: () => actions,
    call: async (name: string, input: Json, actor: Actor) => {
      if (name === 'review.tree') return tree(input, actor);
      if (name === 'review.map') {const result=await tree(input,actor);return {...productMap(store,result.projectId,result.files),warnings:result.warnings};}
      if (name === 'review.provenance') {const project=projectFor(store,actor,input.projectId),path=await assertKnownPath(store,project,input.path);return documentProvenance(store,project.id,path,input.versionId);}
      if (name === 'review.history') return history(input, actor);
      assert(name === 'review.compare', `Unknown document review action: ${name}`);
      return compare(input, actor);
    },
  };
}
