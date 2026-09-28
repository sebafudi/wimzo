import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkerDependencies } from '../src/worker-dependencies.ts';

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-worker-dependencies-')); const canonical = join(root, 'canonical');
  mkdirSync(canonical, { recursive: true }); writeFileSync(join(canonical, '.gitignore'), 'node_modules\n'); writeFileSync(join(canonical, 'package-lock.json'), '{"lockfileVersion":3}\n'); writeFileSync(join(canonical, 'package.json'), '{"name":"fixture"}\n'); mkdirSync(join(canonical, 'node_modules/package'), { recursive: true }); writeFileSync(join(canonical, 'node_modules/package/index.js'), 'module.exports = 1;\n');
  git(canonical, 'init', '-q'); git(canonical, 'config', 'user.email', 'fixture@example.invalid'); git(canonical, 'config', 'user.name', 'Fixture'); git(canonical, 'config', 'commit.gpgsign', 'false'); git(canonical, 'add', '.gitignore', 'package-lock.json', 'package.json'); git(canonical, 'commit', '-qm', 'fixture');
  const target = join(root, 'target'); git(canonical, 'worktree', 'add', '--detach', target, 'HEAD'); return { root, canonical, target, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('links only an exact-lock canonical donor and declares its real read-only root', () => {
  const value = fixture();
  try {
    const result = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical });
    assert.equal(result.status, 'linked'); assert.equal(result.donor, 'canonical-project'); assert.equal(result.reason, null);
    assert.equal(result.dependencyRoot, realpathSync(join(value.canonical, 'node_modules'))); assert.equal(lstatSync(join(value.target, 'node_modules')).isSymbolicLink(), true); assert.equal(realpathSync(join(value.target, 'node_modules')), result.dependencyRoot);
    const resumed = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical }); assert.deepEqual(resumed, result);
  } finally { value.close(); }
});

test('refuses a mismatch, an unignored target, a foreign runtime donor, and a donor node_modules symlink without mutating the target', () => {
  const value = fixture();
  try {
    writeFileSync(join(value.target, 'package-lock.json'), '{"lockfileVersion":4}\n');
    const mismatch = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical }); assert.equal(mismatch.status, 'unavailable'); assert.equal(existsSync(join(value.target, 'node_modules')), false, 'target dependencies remain absent');
    rmSync(join(value.target, 'node_modules'), { recursive: true, force: true }); writeFileSync(join(value.target, '.gitignore'), 'other\n');
    const unignored = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical }); assert.match(unignored.reason ?? '', /does not ignore/); assert.equal(existsSync(join(value.target, 'node_modules')), false);
    writeFileSync(join(value.target, '.gitignore'), 'node_modules\n'); writeFileSync(join(value.target, 'package-lock.json'), readFileSync(join(value.canonical, 'package-lock.json')));
    const foreign = mkdtempSync(join(tmpdir(), 'wimzo-foreign-runtime-')); writeFileSync(join(foreign, 'package-lock.json'), readFileSync(join(value.canonical, 'package-lock.json'))); mkdirSync(join(foreign, 'node_modules'), { recursive: true }); git(foreign, 'init', '-q');
    const foreignResult = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.target, runtimeCheckout: foreign }); assert.equal(foreignResult.status, 'unavailable'); assert.equal(existsSync(join(value.target, 'node_modules')), false);
    rmSync(foreign, { recursive: true, force: true });
  } finally { value.close(); }
});

test('preserves an existing target dependency directory and rejects a donor node_modules link', () => {
  const value = fixture();
  try {
    mkdirSync(join(value.target, 'node_modules'), { recursive: true }); const existing = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical }); assert.equal(existing.status, 'present');
    rmSync(join(value.target, 'node_modules'), { recursive: true, force: true }); rmSync(join(value.canonical, 'node_modules'), { recursive: true, force: true }); const external = join(value.root, 'external'); mkdirSync(external); symlinkSync(external, join(value.canonical, 'node_modules'), 'dir');
    const linkedDonor = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical }); assert.equal(linkedDonor.status, 'unavailable'); assert.equal(lstatSync(join(value.target, 'node_modules'), { throwIfNoEntry: false }), undefined);
  } finally { value.close(); }
});

test('uses the current runtime checkout only when it is an exact-lock worktree of the same repository', () => {
  const value = fixture();
  try {
    const runtime = join(value.root, 'runtime'); git(value.canonical, 'worktree', 'add', '--detach', runtime, 'HEAD'); mkdirSync(join(runtime, 'node_modules/runtime-package'), { recursive: true }); writeFileSync(join(runtime, 'node_modules/runtime-package/index.js'), 'module.exports = 2;\n');
    rmSync(join(value.canonical, 'node_modules'), { recursive: true, force: true });
    const result = prepareWorkerDependencies({ worktree: value.target, canonicalProject: value.canonical, runtimeCheckout: runtime });
    assert.equal(result.status, 'linked'); assert.equal(result.donor, 'runtime-checkout'); assert.equal(result.dependencyRoot, realpathSync(join(runtime, 'node_modules')));
  } finally { value.close(); }
});

test('a fresh worktree with a directory-only node_modules/ ignore mirrors an exact-lock donor without exposing untracked source', () => {
  const value = fixture();
  try {
    writeFileSync(join(value.canonical, '.gitignore'), 'node_modules/\n'); git(value.canonical, 'commit', '-qam', 'Directory-only ignore');
    const fresh = join(value.root, 'fresh'); git(value.canonical, 'worktree', 'add', '--detach', fresh, 'HEAD');
    mkdirSync(join(value.canonical, 'node_modules', '.bin'), { recursive: true }); mkdirSync(join(value.canonical, 'node_modules', '@scope', 'pkg'), { recursive: true }); writeFileSync(join(value.canonical, 'node_modules', '@scope', 'pkg', 'index.js'), 'module.exports = 3;\n');
    assert.equal(existsSync(join(fresh, 'node_modules')), false);
    assert.deepEqual(readFileSync(join(fresh, 'package-lock.json')), readFileSync(join(value.canonical, 'package-lock.json')));
    const result = prepareWorkerDependencies({ worktree: fresh, canonicalProject: value.canonical });
    assert.equal(result.status, 'linked', result.reason ?? ''); assert.equal(result.donor, 'canonical-project'); assert.equal(result.dependencyRoot, realpathSync(join(value.canonical, 'node_modules')));
    const modules = lstatSync(join(fresh, 'node_modules')); assert.equal(modules.isDirectory(), true); assert.equal(modules.isSymbolicLink(), false);
    assert.equal(readFileSync(join(fresh, 'node_modules', '@scope', 'pkg', 'index.js'), 'utf8'), 'module.exports = 3;\n');
    assert.equal(realpathSync(join(fresh, 'node_modules', '@scope')), join(result.dependencyRoot!, '@scope'));
    assert.equal(git(fresh, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.deepEqual(prepareWorkerDependencies({ worktree: fresh, canonicalProject: value.canonical }), result);
    const unrelated = join(value.root, 'unrelated'); git(value.canonical, 'worktree', 'add', '--detach', unrelated, 'HEAD'); mkdirSync(join(unrelated, 'node_modules'));
    assert.equal(prepareWorkerDependencies({ worktree: unrelated, canonicalProject: value.canonical }).status, 'present');
  } finally { value.close(); }
});
