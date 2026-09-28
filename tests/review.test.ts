import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'review-owner' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Review Fixture',
      GIT_AUTHOR_EMAIL: 'review@example.invalid',
      GIT_COMMITTER_NAME: 'Review Fixture',
      GIT_COMMITTER_EMAIL: 'review@example.invalid',
    },
  }).trim();
}

async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-review-'));
  const projectRoot = join(temp, 'project');
  mkdirSync(join(projectRoot, 'spec'), { recursive: true });
  writeFileSync(join(projectRoot, 'spec/PRD.md'), '**H-001 Review diff.**\nShow a clear proposal.\n');
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-q', '-m', 'Initial specification');
  const initialCommit = git(projectRoot, 'rev-parse', 'HEAD');
  const app = new App(join(temp, 'state'));
  const project = await app.call('project.register', { id: 'review-project', name: 'Review fixture', root: projectRoot, purpose: 'Review API test' }, owner);
  const draft = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md', sourceRevision: initialCommit }, owner);
  const spec = (await app.call('spec.accept', { specId: draft.id, hash: draft.hash, expectedRev: draft.rev, decision: 'Fixture acceptance', source: 'isolated test' }, owner)).spec;
  const close = async () => { await app.close(); rmSync(temp, { recursive: true, force: true }); };
  return { temp, projectRoot, app, project, spec, initialCommit, close };
}

async function createTask(context: Awaited<ReturnType<typeof fixture>>, id: string, source: string, candidate?: string) {
  let task = await context.app.call('task.create', {
    id,
    projectId: context.project.id,
    specId: context.spec.id,
    specHash: context.spec.hash,
    requirements: ['H-001'],
    objective: `Review ${id}`,
    criteria: ['Diff is exact'],
    scope: 'Fixture repository only',
    permissions: [],
    budget: {},
    runtime: 'script',
    sourceCandidate: { id: source, commit: source },
  }, owner);
  if (candidate) task = context.app.store.put('task', { ...task, state: 'Needs result review', candidate: { id: candidate, commit: candidate, specHash: context.spec.hash } }, task.rev);
  return task;
}

test('task diff compares only persisted commits and preserves rename, binary, and literal filenames', async () => {
  const context = await fixture();
  try {
    const action = context.app.actions(owner).find(value => value.name === 'review.diff');
    assert.equal(action?.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(action?.inputSchema.properties ?? {}).sort(), ['specId', 'taskId']);
    assert.equal(action?.inputSchema.additionalProperties, false);
    writeFileSync(join(context.projectRoot, 'old name.txt'), 'same rename content\n');
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Task source');
    const source = git(context.projectRoot, 'rev-parse', 'HEAD');
    git(context.projectRoot, 'mv', 'old name.txt', 'renamed file.txt');
    writeFileSync(join(context.projectRoot, ':literal name.txt'), 'literal path\n');
    writeFileSync(join(context.projectRoot, 'binary file.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 4]));
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Task candidate');
    const candidate = git(context.projectRoot, 'rev-parse', 'HEAD');
    const task = await createTask(context, 'exact-task', source, candidate);

    const result = await context.app.call('review.diff', { taskId: task.id }, owner);
    assert.equal(result.kind, 'task');
    assert.equal(result.identity.sourceCandidate.commit, source);
    assert.equal(result.identity.candidate.commit, candidate);
    assert.equal(result.files.find((file: any) => file.path === 'renamed file.txt')?.status, 'renamed');
    assert.match(result.files.find((file: any) => file.path === 'renamed file.txt').patch, /rename from old name\.txt/);
    const binary = result.files.find((file: any) => file.path === 'binary file.bin');
    assert.equal(binary.patch, '');
    assert.match(binary.unavailableReason, /Binary content changed/);
    assert.match(result.files.find((file: any) => file.path === ':literal name.txt').patch, /literal path/);
    assert.match(result.warnings.join('\n'), /binary file\.bin: Binary content changed/);

    const foreign = await createTask(context, 'foreign-task', source);
    await assert.rejects(context.app.call('review.diff', { taskId: task.id }, { role: 'worker', id: 'foreign-worker', taskId: foreign.id }), /only its task/);
  } finally { await context.close(); }
});

test('task diff reports missing, dirty, and unavailable candidates without falling back to HEAD', async () => {
  const context = await fixture();
  try {
    const missing = await createTask(context, 'missing-candidate', context.initialCommit);
    const noCandidate = await context.app.call('review.diff', { taskId: missing.id }, owner);
    assert.deepEqual(noCandidate.files, []);
    assert.match(noCandidate.warnings[0], /No finalized candidate/);

    const dirty = context.app.store.put('task', { ...missing, candidate: { id: `sha256:${'b'.repeat(64)}`, baseCommit: context.initialCommit, dirty: true, specHash: context.spec.hash } }, missing.rev);
    const dirtyResult = await context.app.call('review.diff', { taskId: dirty.id }, owner);
    assert.deepEqual(dirtyResult.files, []);
    assert.match(dirtyResult.warnings[0], /dirty worktree snapshot/);

    const absentCommit = 'f'.repeat(40);
    const unavailable = context.app.store.put('task', { ...dirty, candidate: { id: absentCommit, commit: absentCommit, specHash: context.spec.hash } }, dirty.rev);
    const unavailableResult = await context.app.call('review.diff', { taskId: unavailable.id }, owner);
    assert.deepEqual(unavailableResult.files, []);
    assert.equal(unavailableResult.warnings[0], 'Git inspection is unavailable.');
    assert.ok(!unavailableResult.warnings[0].includes(absentCommit));

    await assert.rejects(context.app.call('review.diff', {}, owner), /exactly one/);
    await assert.rejects(context.app.call('review.diff', { taskId: missing.id, specId: context.spec.id }, owner), /exactly one/);
  } finally { await context.close(); }
});

test('spec diff uses captured snapshots for initial, changed, and newline-only proposals', async () => {
  const context = await fixture();
  try {
    const initial = await context.app.call('review.diff', { specId: context.spec.id }, owner);
    assert.equal(initial.kind, 'spec');
    assert.equal(initial.baseLabel, 'No previous snapshot');
    assert.equal(initial.afterLabel, 'Initial proposal');
    assert.equal(initial.files[0].status, 'added');
    assert.match(initial.files[0].patch, /--- \/dev\/null/);
    assert.match(initial.files[0].patch, /\+\*\*H-001 Review diff/);
    assert.deepEqual(initial.files[0].markdown, { before: null, after: context.spec.content });

    writeFileSync(join(context.projectRoot, 'spec/PRD.md'), '**H-001 Review diff.**\nShow the changed proposal.\n');
    const changed = await context.app.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    const changedResult = await context.app.call('review.diff', { specId: changed.id }, owner);
    assert.equal(changedResult.identity.previousSpecId, context.spec.id);
    assert.deepEqual(changedResult.files[0].markdown, { before: context.spec.content, after: changed.content });
    assert.match(changedResult.files[0].patch, /-Show a clear proposal\./);
    assert.match(changedResult.files[0].patch, /\+Show the changed proposal\./);

    writeFileSync(join(context.projectRoot, 'spec/PRD.md'), '**H-001 Review diff.**\nShow the changed proposal.');
    const newlineOnly = await context.app.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    const newlineResult = await context.app.call('review.diff', { specId: newlineOnly.id }, owner);
    assert.match(newlineResult.files[0].patch, /-Show the changed proposal\./);
    assert.match(newlineResult.files[0].patch, /\+Show the changed proposal\./);
    assert.match(newlineResult.files[0].patch, /\\ No newline at end of file/);

    const foreignRoot = join(context.temp, 'foreign');
    mkdirSync(join(foreignRoot, 'spec'), { recursive: true });
    writeFileSync(join(foreignRoot, 'spec/PRD.md'), '**H-001 Foreign.**\n');
    const foreignProject = await context.app.call('project.register', { id: 'foreign-project', name: 'Foreign', root: foreignRoot, purpose: 'Foreign fixture' }, owner);
    const boundTask = await createTask(context, 'bound-worker-task', context.initialCommit);
    const foreignSpec = await context.app.call('spec.capture', { projectId: foreignProject.id, path: 'spec/PRD.md' }, owner);
    await assert.rejects(context.app.call('review.diff', { specId: foreignSpec.id }, { role: 'worker', id: 'bound-worker', taskId: boundTask.id }), /only its project/);
  } finally { await context.close(); }
});

test('spec diff rejects missing and cross-project predecessor records', async () => {
  const context = await fixture();
  try {
    const missing = context.app.store.put('spec', { ...context.spec, id: 'missing-predecessor', previousId: 'not-present', status: 'Draft' });
    const missingResult = await context.app.call('review.diff', { specId: missing.id }, owner);
    assert.equal(missingResult.baseLabel, 'Previous snapshot unavailable');
    assert.equal(missingResult.files[0].markdown, undefined);
    assert.match(missingResult.files[0].unavailableReason, /previous specification snapshot is unavailable/);

    const foreignRoot = join(context.temp, 'foreign-predecessor');
    mkdirSync(join(foreignRoot, 'spec'), { recursive: true });
    writeFileSync(join(foreignRoot, 'spec/PRD.md'), '**H-001 Foreign private text.**\n');
    const foreignProject = await context.app.call('project.register', { id: 'foreign-predecessor-project', name: 'Foreign', root: foreignRoot, purpose: 'Foreign predecessor' }, owner);
    const foreign = await context.app.call('spec.capture', { projectId: foreignProject.id, path: 'spec/PRD.md' }, owner);
    const corrupt = context.app.store.put('spec', { ...context.spec, id: 'cross-project-predecessor', previousId: foreign.id, status: 'Draft' });
    const corruptResult = await context.app.call('review.diff', { specId: corrupt.id }, owner);
    assert.match(corruptResult.files[0].unavailableReason, /does not match this project and path/);
    assert.ok(!JSON.stringify(corruptResult).includes('Foreign private text'));
    assert.equal(corruptResult.files[0].markdown, undefined);
  } finally { await context.close(); }
});

test('task and specification diffs enforce file, patch, and line limits', async () => {
  const context = await fixture();
  try {
    const source = context.initialCommit;
    writeFileSync(join(context.projectRoot, '00-huge.txt'), `${'large line\n'.repeat(25_000)}`);
    for (let index = 0; index < 105; index++) writeFileSync(join(context.projectRoot, `file-${String(index).padStart(3, '0')}.txt`), `file ${index}\n`);
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Large candidate');
    const candidate = git(context.projectRoot, 'rev-parse', 'HEAD');
    const task = await createTask(context, 'bounded-task', source, candidate);
    const result = await context.app.call('review.diff', { taskId: task.id }, owner);
    assert.equal(result.files.length, 100);
    assert.match(result.warnings.join('\n'), /first 100 of 106 changed files/);
    const huge = result.files.find((file: any) => file.path === '00-huge.txt');
    assert.equal(huge.patch, '');
    assert.match(huge.unavailableReason, /200000 byte file limit/);

    writeFileSync(join(context.projectRoot, 'spec/PRD.md'), Array.from({ length: 2_001 }, (_, index) => `line ${index}`).join('\n'));
    const oversized = await context.app.call('spec.capture', { projectId: context.project.id, path: 'spec/PRD.md' }, owner);
    const oversizedResult = await context.app.call('review.diff', { specId: oversized.id }, owner);
    assert.equal(oversizedResult.files[0].patch, '');
    assert.match(oversizedResult.files[0].unavailableReason, /2000 line limit/);
    assert.equal(oversizedResult.files[0].markdown, undefined);
    assert.match(oversizedResult.files[0].markdownUnavailableReason, /2000 line limit/);
  } finally { await context.close(); }
});


test('Markdown task snapshots contain exact full committed documents for edits, renames, additions and deletions', async () => {
  const context = await fixture();
  try {
    const before = '\uFEFF# Full document\n' + Array.from({ length: 30 }, (_, index) => `Paragraph ${index}.\n`).join('');
    const after = before.replace('Paragraph 15.', 'Revised paragraph 15.');
    const renamed = '# Renamed\n\nThe full unchanged document.\n';
    const removed = '# Deleted document\nUnique removed contents.\n';
    const added = '# Added document\nUnique newly added contents.\n';
    writeFileSync(join(context.projectRoot, 'edit.md'), before);
    writeFileSync(join(context.projectRoot, 'old.markdown'), renamed);
    writeFileSync(join(context.projectRoot, 'removed.md'), removed);
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Markdown source');
    const source = git(context.projectRoot, 'rev-parse', 'HEAD');
    writeFileSync(join(context.projectRoot, 'edit.md'), after);
    git(context.projectRoot, 'mv', 'old.markdown', 'renamed.MD');
    git(context.projectRoot, 'rm', 'removed.md');
    writeFileSync(join(context.projectRoot, ':added.markdown'), added);
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Markdown candidate');
    const candidate = git(context.projectRoot, 'rev-parse', 'HEAD');
    const task = await createTask(context, 'markdown-exact', source, candidate);
    writeFileSync(join(context.projectRoot, 'edit.md'), '# Later HEAD contents\n');
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Later unrelated commit');
    writeFileSync(join(context.projectRoot, 'edit.md'), '# Uncommitted contents\n');
    const result = await context.app.call('review.diff', { taskId: task.id }, owner);
    const files = new Map(result.files.map((file: any) => [file.path, file])) as Map<string, any>;
    assert.deepEqual(files.get('edit.md').markdown, { before, after });
    assert.ok(!files.get('edit.md').patch.includes('Paragraph 0.'));
    assert.deepEqual(files.get('renamed.MD').markdown, { before: renamed, after: renamed });
    assert.equal(files.get('renamed.MD').status, 'renamed');
    assert.deepEqual(files.get(':added.markdown').markdown, { before: null, after: added });
    assert.deepEqual(files.get('removed.md').markdown, { before: removed, after: null });
    assert.ok(!JSON.stringify(result).includes('Uncommitted contents'));
    assert.ok(!JSON.stringify(result).includes('Later HEAD contents'));
  } finally { await context.close(); }
});

test('Markdown snapshots reject binary, byte and line limits while retaining available raw patches', async () => {
  const context = await fixture();
  try {
    const byteBefore = '# Large document\n' + 'a'.repeat(200_000) + '\n';
    const lineBefore = Array.from({ length: 2_001 }, (_, index) => `line ${index}`).join('\n');
    writeFileSync(join(context.projectRoot, 'byte-limit.md'), byteBefore);
    writeFileSync(join(context.projectRoot, 'line-limit.md'), lineBefore);
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Large Markdown source');
    const source = git(context.projectRoot, 'rev-parse', 'HEAD');
    writeFileSync(join(context.projectRoot, 'byte-limit.md'), byteBefore.replace('# Large', '# Changed'));
    writeFileSync(join(context.projectRoot, 'line-limit.md'), lineBefore.replace('line 1000', 'changed line 1000'));
    writeFileSync(join(context.projectRoot, 'binary.md'), Buffer.from([35, 32, 0, 255]));
    writeFileSync(join(context.projectRoot, 'invalid-utf8.md'), Buffer.from([35, 32, 255, 10]));
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Large Markdown candidate');
    const task = await createTask(context, 'markdown-bounds', source, git(context.projectRoot, 'rev-parse', 'HEAD'));
    const result = await context.app.call('review.diff', { taskId: task.id }, owner);
    const files = new Map(result.files.map((file: any) => [file.path, file])) as Map<string, any>;
    assert.match(files.get('byte-limit.md').markdownUnavailableReason, /200000 byte limit/);
    assert.match(files.get('line-limit.md').markdownUnavailableReason, /2000 line limit/);
    assert.match(files.get('line-limit.md').patch, /changed line 1000/);
    assert.match(files.get('binary.md').markdownUnavailableReason, /Binary/);
    assert.match(files.get('invalid-utf8.md').markdownUnavailableReason, /invalid UTF-8/);
    for (const file of result.files) assert.equal(file.markdown, undefined);
  } finally { await context.close(); }
});

test('Markdown snapshot output has a cumulative byte limit', async () => {
  const context = await fixture();
  try {
    const before = '# Small edit\n' + 'text '.repeat(36_000) + '\n';
    for (let index = 0; index < 4; index++) writeFileSync(join(context.projectRoot, `total-${index}.md`), before);
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Total Markdown source');
    const source = git(context.projectRoot, 'rev-parse', 'HEAD');
    for (let index = 0; index < 4; index++) writeFileSync(join(context.projectRoot, `total-${index}.md`), before.replace('# Small edit', '# Changed'));
    git(context.projectRoot, 'add', '.');
    git(context.projectRoot, 'commit', '-q', '-m', 'Total Markdown candidate');
    const task = await createTask(context, 'markdown-total', source, git(context.projectRoot, 'rev-parse', 'HEAD'));
    const result = await context.app.call('review.diff', { taskId: task.id }, owner);
    assert.equal(result.files.filter((file: any) => file.markdown).length, 2);
    assert.match(result.files[2].markdownUnavailableReason, /1000000 byte total limit/);
    const bytes = result.files.reduce((sum: number, file: any) => sum + (file.markdown ? Buffer.byteLength(file.markdown.before ?? '') + Buffer.byteLength(file.markdown.after ?? '') : 0), 0);
    assert.ok(bytes <= 1_000_000);
  } finally { await context.close(); }
});


test('Markdown specification snapshots preserve full saved content and refuse binary or oversized snapshots', async () => {
  const context = await fixture();
  try {
    const before = '# Saved document\n' + Array.from({ length: 40 }, (_, index) => `Saved paragraph ${index}.\n`).join('');
    const after = before.replace('Saved paragraph 20.', 'Changed paragraph 20.');
    const oldSpec = context.app.store.put('spec', { ...context.spec, id: 'saved-old', content: before });
    const newSpec = context.app.store.put('spec', { ...context.spec, id: 'saved-new', previousId: oldSpec.id, content: after });
    writeFileSync(join(context.projectRoot, 'spec/PRD.md'), '# Unrelated working file\n');
    const result = await context.app.call('review.diff', { specId: newSpec.id }, owner);
    assert.deepEqual(result.files[0].markdown, { before, after });
    assert.ok(!result.files[0].patch.includes('Saved paragraph 0.'));
    const binary = context.app.store.put('spec', { ...context.spec, id: 'saved-binary', content: '# Binary\0document\n' });
    const binaryResult = await context.app.call('review.diff', { specId: binary.id }, owner);
    assert.equal(binaryResult.files[0].markdown, undefined);
    assert.match(binaryResult.files[0].markdownUnavailableReason, /Binary/);
    const large = context.app.store.put('spec', { ...context.spec, id: 'saved-large', content: 'a'.repeat(200_001) });
    const largeResult = await context.app.call('review.diff', { specId: large.id }, owner);
    assert.equal(largeResult.files[0].markdown, undefined);
    assert.match(largeResult.files[0].markdownUnavailableReason, /200000 byte limit/);
  } finally { await context.close(); }
});
