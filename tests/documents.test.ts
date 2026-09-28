import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'document-owner' };

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Document Fixture',
      GIT_AUTHOR_EMAIL: 'documents@example.invalid',
      GIT_COMMITTER_NAME: 'Document Fixture',
      GIT_COMMITTER_EMAIL: 'documents@example.invalid',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim();
}

async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-documents-'));
  const root = join(temp, 'project');
  mkdirSync(join(root, 'spec/notes'), { recursive: true });
  writeFileSync(join(root, 'VISION.md'), '# Product vision\n');
  writeFileSync(join(root, 'spec/PRD.md'), '# Product v1\n\nInitial behavior.\n');
  writeFileSync(join(root, 'spec/deleted.md'), '# Deleted requirement\n\nHistorical behavior.\n');
  writeFileSync(join(root, 'spec/notes/choice.md'), '# Architecture choice\n\nA durable decision.\n');
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Initial product requirements'], '2026-01-01T10:00:00Z');
  const initialCommit = git(root, ['rev-parse', 'HEAD']);

  writeFileSync(join(root, 'spec/PRD.md'), '# Product v2\n\nSecond behavior.\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Clarify second behavior'], '2026-01-02T10:00:00Z');
  const secondCommit = git(root, ['rev-parse', 'HEAD']);

  writeFileSync(join(root, 'spec/PRD.md'), '# Product v3\n\nThird behavior.\n');
  git(root, ['rm', '-q', 'spec/deleted.md']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Remove obsolete requirement'], '2026-01-03T10:00:00Z');
  const deletionCommit = git(root, ['rev-parse', 'HEAD']);

  const app = new App(join(temp, 'state'));
  const project = await app.call('project.register', {
    id: 'documents-project', name: 'Documents fixture', root, purpose: 'Requirements history tests', canonicalPaths: ['VISION.md', 'spec/PRD.md'],
  }, owner);
  const capture = async (content: string, capturedAt: string) => {
    writeFileSync(join(root, 'spec/PRD.md'), content);
    const spec = await app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
    return app.store.put('spec', { ...spec, capturedAt }, spec.rev);
  };
  const snapshot1 = await capture('# Snapshot one\n\nSaved exact text one.\n', '2026-01-04T10:00:00.000Z');
  const snapshot2 = await capture('# Snapshot two\n\nSaved exact text two.\n', '2026-01-05T10:00:00.000Z');
  const snapshot3 = await capture('# Snapshot three\n\nSaved exact text three.\n', '2026-01-06T10:00:00.000Z');

  const close = async () => { await app.close(); rmSync(temp, { recursive: true, force: true }); };
  return { temp, root, app, project, initialCommit, secondCommit, deletionCommit, snapshot1, snapshot2, snapshot3, close };
}

test('requirement tree includes nested, captured, and deleted specification documents only', async () => {
  const context = await fixture();
  try {
    mkdirSync(join(context.root, 'src'), { recursive: true });
    writeFileSync(join(context.root, 'src/unrelated.md'), '# Unrelated source document\n');
    writeFileSync(join(context.temp, 'outside.md'), '# Outside\n');
    symlinkSync(join(context.temp, 'outside.md'), join(context.root, 'spec/link.md'));

    const result = await context.app.call('review.tree', { projectId: context.project.id }, owner);
    assert.equal(result.projectId, context.project.id);
    assert.deepEqual(result.files.map((file: any) => file.path), [
      'spec/deleted.md', 'spec/notes/choice.md', 'spec/PRD.md', 'VISION.md',
    ]);
    assert.equal(result.files.find((file: any) => file.path === 'spec/PRD.md').snapshotCount, 3);
    assert.equal(result.files.find((file: any) => file.path === 'spec/PRD.md').title, 'Snapshot three');
    assert.equal(result.files.find((file: any) => file.path === 'spec/PRD.md').status, 'Draft');
    assert.equal(result.files.find((file: any) => file.path === 'spec/deleted.md').snapshotCount, 0);
    assert.match(result.warnings.join('\n'), /symbolic link spec\/link\.md/);
    assert.ok(!result.files.some((file: any) => file.path === 'src/unrelated.md' || file.path === 'spec/link.md'));
  } finally { await context.close(); }
});

test('requirement tree reports real staged, unstaged, untracked, deleted, and renamed Git changes', async () => {
  const context = await fixture();
  try {
    const cleanPath = 'spec/clean.md';
    const deletePath = 'spec/to delete.md';
    const renameFrom = 'spec/rename original.md';
    const renameTo = 'spec/renamed źródło.md';
    const untrackedPath = 'spec/new requirement\tź.md';
    writeFileSync(join(context.root, cleanPath), '# Clean requirement\n');
    writeFileSync(join(context.root, deletePath), '# Delete requirement\n');
    writeFileSync(join(context.root, renameFrom), '# Rename requirement\n');
    git(context.root, ['add', cleanPath, deletePath, renameFrom]);
    git(context.root, ['commit', '-q', '-m', 'Add status fixtures'], '2026-01-07T10:00:00Z');

    writeFileSync(join(context.root, 'spec/notes/choice.md'), '# Architecture choice\n\nA staged change.\n');
    git(context.root, ['add', 'spec/notes/choice.md']);
    writeFileSync(join(context.root, 'VISION.md'), '# Product vision\n\nAn unstaged canonical change.\n');
    rmSync(join(context.root, deletePath));
    git(context.root, ['mv', renameFrom, renameTo]);
    writeFileSync(join(context.root, untrackedPath), '# New requirement\n');

    const result = await context.app.call('review.tree', { projectId: context.project.id }, owner);
    const changes = new Map(result.files.map((file: any) => [file.path, file.workingChange]));
    assert.equal(changes.get('spec/PRD.md'), 'M');
    assert.equal(changes.get('VISION.md'), 'M');
    assert.equal(changes.get('spec/notes/choice.md'), 'M');
    assert.equal(changes.get(deletePath), 'D');
    assert.equal(changes.get(untrackedPath), 'A');
    assert.equal(changes.get(renameFrom), 'D');
    assert.equal(changes.get(renameTo), 'A');
    assert.equal(changes.get(cleanPath), undefined);
    assert.equal(changes.get('spec/deleted.md'), undefined);
    const counts = new Map(result.files.map((file: any) => [file.path, file.workingDiff]));
    assert.deepEqual(counts.get('spec/PRD.md'), { additions: 2, deletions: 2 });
    assert.deepEqual(counts.get('VISION.md'), { additions: 2, deletions: 0 });
    assert.deepEqual(counts.get('spec/notes/choice.md'), { additions: 1, deletions: 1 });
    assert.deepEqual(counts.get(deletePath), { additions: 0, deletions: 1 });
    assert.deepEqual(counts.get(untrackedPath), { additions: 1, deletions: 0 });
    assert.deepEqual(counts.get(renameFrom), { additions: 0, deletions: 1 });
    assert.deepEqual(counts.get(renameTo), { additions: 1, deletions: 0 });
    assert.equal(counts.get(cleanPath), undefined);
  } finally { await context.close(); }
});

test('history is newest first, paginated, and compares arbitrary Git and snapshot versions exactly', async () => {
  const context = await fixture();
  try {
    const first = await context.app.call('review.history', { projectId: context.project.id, path: 'spec/PRD.md', limit: 2 }, owner);
    assert.deepEqual(first.versions.map((version: any) => version.id), [`spec:${context.snapshot3.id}`, `spec:${context.snapshot2.id}`]);
    assert.equal(first.versions[0].previousVersionId, `spec:${context.snapshot2.id}`);
    assert.equal(first.versions[1].previousVersionId, `spec:${context.snapshot1.id}`);
    assert.equal(first.nextOffset, 2);
    const second = await context.app.call('review.history', { projectId: context.project.id, path: 'spec/PRD.md', offset: first.nextOffset, limit: 10 }, owner);
    assert.equal(second.nextOffset, null);
    const versions = [...first.versions, ...second.versions];
    assert.equal(versions.length, 6);
    assert.deepEqual(versions.slice(3).map((version: any) => version.id), [
      `git:${context.deletionCommit}`, `git:${context.secondCommit}`, `git:${context.initialCommit}`,
    ]);
    assert.equal(versions[3].label, 'Remove obsolete requirement');
    assert.equal(versions[3].status, undefined);
    assert.ok(!versions[3].label.includes(context.deletionCommit));
    assert.deepEqual(versions.map((version: any) => version.previousVersionId), [
      `spec:${context.snapshot2.id}`,
      `spec:${context.snapshot1.id}`,
      `git:${context.deletionCommit}`,
      `git:${context.secondCommit}`,
      `git:${context.initialCommit}`,
      null,
    ]);
    assert.ok(versions.every((version: any) => version.previousVersionKnown === undefined));

    const nonadjacent = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/PRD.md',
      beforeVersion: `git:${context.initialCommit}`,
      afterVersion: `git:${context.deletionCommit}`,
    }, owner);
    assert.equal(nonadjacent.kind, 'document');
    assert.equal(nonadjacent.status, 'Git history');
    assert.deepEqual(nonadjacent.files[0].markdown, {
      before: '# Product v1\n\nInitial behavior.\n',
      after: '# Product v3\n\nThird behavior.\n',
    });

    const mixed = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/PRD.md',
      beforeVersion: `git:${context.secondCommit}`,
      afterVersion: `spec:${context.snapshot3.id}`,
    }, owner);
    assert.equal(mixed.status, 'Draft');
    assert.equal(mixed.files[0].markdown.before, '# Product v2\n\nSecond behavior.\n');
    assert.equal(mixed.files[0].markdown.after, context.snapshot3.content);

    const reversed = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/PRD.md',
      beforeVersion: `spec:${context.snapshot3.id}`,
      afterVersion: `git:${context.initialCommit}`,
    }, owner);
    assert.equal(reversed.files[0].markdown.before, context.snapshot3.content);
    assert.equal(reversed.files[0].markdown.after, '# Product v1\n\nInitial behavior.\n');

    const same = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/PRD.md',
      beforeVersion: `spec:${context.snapshot2.id}`,
      afterVersion: `spec:${context.snapshot2.id}`,
    }, owner);
    assert.deepEqual(same.files[0].markdown, { before: context.snapshot2.content, after: context.snapshot2.content });
    assert.doesNotMatch(same.files[0].patch, /^@@/m);

    const initial = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/PRD.md',
      beforeVersion: null,
      afterVersion: `git:${context.initialCommit}`,
    }, owner);
    assert.equal(initial.files[0].status, 'added');
    assert.equal(initial.files[0].markdown.before, null);
  } finally { await context.close(); }
});

test('Git deletion, validation, bounds, and project access remain explicit and isolated', async () => {
  const context = await fixture();
  try {
    const deletedHistory = await context.app.call('review.history', { projectId: context.project.id, path: 'spec/deleted.md' }, owner);
    assert.equal(deletedHistory.versions.length, 2);
    assert.equal(deletedHistory.versions[0].id, `git:${context.deletionCommit}`);
    const deleted = await context.app.call('review.compare', {
      projectId: context.project.id,
      path: 'spec/deleted.md',
      beforeVersion: deletedHistory.versions[1].id,
      afterVersion: deletedHistory.versions[0].id,
    }, owner);
    assert.equal(deleted.files[0].status, 'deleted');
    assert.deepEqual(deleted.files[0].markdown, { before: '# Deleted requirement\n\nHistorical behavior.\n', after: null });
    assert.match(deleted.files[0].patch, /\+\+\+ \/dev\/null/);

    await assert.rejects(context.app.call('review.history', { projectId: context.project.id, path: '../secret.md' }, owner), /invalid/);
    await assert.rejects(context.app.call('review.history', { projectId: context.project.id, path: '/tmp/secret.md' }, owner), /relative/);
    await assert.rejects(context.app.call('review.history', { projectId: context.project.id, path: 'docs/foreign.md' }, owner), /Unknown project requirement/);
    await assert.rejects(context.app.call('review.history', { projectId: context.project.id, path: 'spec/PRD.md', limit: 101 }, owner), /between 1 and 100/);
    await assert.rejects(context.app.call('review.compare', {
      projectId: context.project.id, path: 'spec/PRD.md', beforeVersion: null, afterVersion: `git:${'f'.repeat(40)}`,
    }, owner), /Unknown saved afterVersion/);

    const foreignRoot = join(context.temp, 'foreign');
    mkdirSync(join(foreignRoot, 'spec'), { recursive: true });
    writeFileSync(join(foreignRoot, 'spec/PRD.md'), '# Foreign private requirement\n');
    const foreign = await context.app.call('project.register', {
      id: 'foreign-documents-project', name: 'Foreign', root: foreignRoot, purpose: 'Isolation', canonicalPaths: ['spec/PRD.md'],
    }, owner);
    const foreignSpec = await context.app.call('spec.capture', { projectId: foreign.id, path: 'spec/PRD.md' }, owner);
    context.app.store.put('task', { id: 'documents-bound-task', projectId: context.project.id });
    const worker = { role: 'worker' as const, id: 'document-worker', taskId: 'documents-bound-task' };
    await assert.rejects(context.app.call('review.tree', { projectId: foreign.id }, worker), /only its project/);
    await assert.rejects(context.app.call('review.compare', {
      projectId: context.project.id, path: 'spec/PRD.md', beforeVersion: null, afterVersion: `spec:${foreignSpec.id}`,
    }, owner), /Unknown saved afterVersion/);

    const huge = context.app.store.put('spec', {
      id: 'oversized-document-snapshot', projectId: context.project.id, path: 'spec/PRD.md', content: `# Huge\n${'x'.repeat(200_000)}`,
      status: 'Draft', capturedAt: '2026-01-07T10:00:00.000Z', hash: 'fixture', requirementIds: [],
    });
    const bounded = await context.app.call('review.compare', {
      projectId: context.project.id, path: 'spec/PRD.md', beforeVersion: null, afterVersion: `spec:${huge.id}`,
    }, owner);
    assert.equal(bounded.files[0].markdown, undefined);
    assert.match(bounded.files[0].unavailableReason, /200000 byte limit/);
    assert.match(bounded.warnings.join('\n'), /200000 byte limit/);
  } finally { await context.close(); }
});

test('unavailable Git history warns and does not describe the oldest visible snapshot as initial', async () => {
  const context = await fixture();
  try {
    const root = join(context.temp, 'not-a-repository');
    mkdirSync(join(root, 'spec'), { recursive: true });
    writeFileSync(join(root, 'spec/PRD.md'), '# Ungit requirement\n');
    const project = await context.app.call('project.register', {
      id: 'ungit-documents-project', name: 'Ungit', root, purpose: 'Unavailable Git tests', canonicalPaths: ['spec/PRD.md'],
    }, owner);
    const saved = await context.app.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);

    const tree = await context.app.call('review.tree', { projectId: project.id }, owner);
    assert.equal(tree.files[0].workingChange, undefined);
    assert.match(tree.warnings.join('\n'), /Git inspection is unavailable/);

    const history = await context.app.call('review.history', { projectId: project.id, path: 'spec/PRD.md' }, owner);
    assert.equal(history.versions[0].id, `spec:${saved.id}`);
    assert.equal(history.versions[0].previousVersionId, null);
    assert.equal(history.versions[0].previousVersionKnown, false);
    assert.match(history.warnings.join('\n'), /Git inspection is unavailable/);
  } finally { await context.close(); }
});

test('Unicode renamed documents retain exact earlier Git content and stable same-time ordering', async () => {
  const context = await fixture();
  try {
    const oldPath='spec/wymagania źródłowe.md',newPath='spec/nowe wymagania.md';
    writeFileSync(join(context.root,oldPath),'# Założenia\n\nPierwsza wersja.\n');
    git(context.root,['add','.']);git(context.root,['commit','-q','-m','Add original requirements'],'2026-02-01T10:00:00Z');
    const first=git(context.root,['rev-parse','HEAD']);
    git(context.root,['mv',oldPath,newPath]);git(context.root,['commit','-q','-m','Rename requirements'],'2026-02-01T10:00:00Z');
    const renamed=git(context.root,['rev-parse','HEAD']);
    writeFileSync(join(context.root,newPath),'# Założenia\n\nDruga wersja.\n');
    git(context.root,['add','.']);git(context.root,['commit','-q','-m','Revise requirements'],'2026-02-01T10:00:00Z');
    const latest=git(context.root,['rev-parse','HEAD']);
    const history=await context.app.call('review.history',{projectId:context.project.id,path:newPath},owner);
    assert.deepEqual(history.versions.map((v:any)=>v.id),[latest,renamed,first].map(id=>'git:'+id));
    const diff=await context.app.call('review.compare',{projectId:context.project.id,path:newPath,beforeVersion:'git:'+first,afterVersion:'git:'+latest},owner);
    assert.equal(diff.files[0].markdown.before,'# Założenia\n\nPierwsza wersja.\n');
    assert.equal(diff.files[0].markdown.after,'# Założenia\n\nDruga wersja.\n');
    const tree=await context.app.call('review.tree',{projectId:context.project.id},owner);
    assert.ok(tree.files.some((f:any)=>f.path===oldPath));
  } finally {await context.close();}
});


test('working line counts use net HEAD changes and disclose binary or oversized new files', async () => {
  const context = await fixture();
  try {
    writeFileSync(join(context.root, 'VISION.md'), '# Intermediate staged title\n');
    git(context.root, ['add', 'VISION.md']);
    writeFileSync(join(context.root, 'VISION.md'), '# Product vision\nExtra behavior.\n');
    writeFileSync(join(context.root, 'spec/no newline.md'), 'one\ntwo');
    writeFileSync(join(context.root, 'spec/empty.md'), '');
    writeFileSync(join(context.root, 'spec/binary.md'), Buffer.from([0, 1, 2]));
    writeFileSync(join(context.root, 'spec/huge.md'), 'x'.repeat(200_001));
    writeFileSync(join(context.root, 'spec/notes/choice.md'), Buffer.from([0, 1, 2]));
    const result = await context.app.call('review.tree', { projectId: context.project.id }, owner);
    const files = new Map<string, any>(result.files.map((file: any) => [file.path, file]));
    assert.deepEqual(files.get('VISION.md').workingDiff, { additions: 1, deletions: 0 });
    assert.deepEqual(files.get('spec/no newline.md').workingDiff, { additions: 2, deletions: 0 });
    assert.deepEqual(files.get('spec/empty.md').workingDiff, { additions: 0, deletions: 0 });
    for (const path of ['spec/binary.md', 'spec/huge.md', 'spec/notes/choice.md']) {
      assert.equal(files.get(path).workingDiff, null);
      assert.match(files.get(path).workingDiffUnavailable, /Binary|size limit/);
    }
  } finally { await context.close(); }
});
