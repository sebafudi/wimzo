import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';

const owner = { role: 'owner' as const, id: 'product-tree-owner' };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Product Tree Fixture',
      GIT_AUTHOR_EMAIL: 'product-tree@example.invalid',
      GIT_COMMITTER_NAME: 'Product Tree Fixture',
      GIT_COMMITTER_EMAIL: 'product-tree@example.invalid',
    },
  }).trim();
}

test('product tree excludes legacy decisions while exact history remains readable', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-product-tree-'));
  const root = join(temp, 'project');
  mkdirSync(join(root, 'spec/orchestrator'), { recursive: true });
  mkdirSync(join(root, 'spec/workers'), { recursive: true });
  mkdirSync(join(root, 'spec/decisions'), { recursive: true });
  writeFileSync(join(root, 'spec/orchestrator/PRD.md'), '# Orchestrator requirements\n');
  writeFileSync(join(root, 'spec/workers/runtime.md'), '# Worker runtime requirements\n');
  writeFileSync(join(root, 'spec/deleted.md'), '# Removed product requirements\n');
  writeFileSync(join(root, 'spec/decisions/current.md'), '# Current decision record\n');
  writeFileSync(join(root, 'spec/decisions/historical.md'), '# Historical decision record\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Add product requirements and decisions');
  git(root, 'rm', '-q', 'spec/deleted.md', 'spec/decisions/historical.md');
  git(root, 'commit', '-q', '-m', 'Move historical records out of product docs');

  const app = new App(join(temp, 'state'));
  try {
    const project = await app.call('project.register', {
      id: 'product-tree-project',
      name: 'Product tree fixture',
      root,
      purpose: 'Product requirements tree filtering',
      canonicalPaths: [
        'spec/orchestrator/PRD.md',
        'spec/decisions/current.md',
        'spec/decisions/registered-only.md',
      ],
    }, owner);
    const decisionSnapshot = await app.call('spec.capture', {
      projectId: project.id,
      path: 'spec/decisions/current.md',
    }, owner);

    const tree = await app.call('review.tree', { projectId: project.id }, owner);
    const paths = tree.files.map((file: any) => file.path);
    assert.deepEqual(paths, [
      'spec/deleted.md',
      'spec/orchestrator/PRD.md',
      'spec/workers/runtime.md',
    ]);
    assert.ok(!paths.some((path: string) => path.split('/').includes('decisions')));

    const currentDecision = await app.call('review.history', {
      projectId: project.id,
      path: 'spec/decisions/current.md',
    }, owner);
    assert.ok(currentDecision.versions.some((version: any) => version.id === `spec:${decisionSnapshot.id}`));
    assert.ok(currentDecision.versions.some((version: any) => version.source === 'git'));

    const historicalDecision = await app.call('review.history', {
      projectId: project.id,
      path: 'spec/decisions/historical.md',
    }, owner);
    assert.equal(historicalDecision.versions.length, 2);
    const historicalComparison = await app.call('review.compare', {
      projectId: project.id,
      path: 'spec/decisions/historical.md',
      beforeVersion: historicalDecision.versions[1].id,
      afterVersion: historicalDecision.versions[0].id,
    }, owner);
    assert.deepEqual(historicalComparison.files[0].markdown, {
      before: '# Historical decision record\n',
      after: null,
    });

    const registeredOnly = await app.call('review.history', {
      projectId: project.id,
      path: 'spec/decisions/registered-only.md',
    }, owner);
    assert.deepEqual(registeredOnly.versions, []);
  } finally {
    await app.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
