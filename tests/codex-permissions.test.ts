import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODEX_WORKSPACE_PERMISSION_PROFILE, codexRuntime, codexRuntimeReadPaths, codexWorkspacePermissionProfile } from '../src/codex-permissions.ts';

test('Codex workspace permission profile allows only the worktree, task git directory, and named runtime paths', () => {
  const profile = codexWorkspacePermissionProfile({
    workspace: '/worktrees/task',
    gitCommonDir: '/repo/.git',
    gitWorktreeDir: '/repo/.git/worktrees/task',
    runtimeReadPaths: ['/opt/wimzo/codex-sdk-cli.mjs'],
    scratchDir: '/runs/task/scratch',
  });
  assert.equal(profile.profile, CODEX_WORKSPACE_PERMISSION_PROFILE);
  assert.deepEqual(profile.config, { default_permissions: CODEX_WORKSPACE_PERMISSION_PROFILE });
  assert.deepEqual(profile.threadOptions, { workingDirectory: '/worktrees/task', approvalPolicy: 'never', webSearchMode: 'disabled' });
  assert.equal('sandboxMode' in profile.threadOptions, false);
  assert.equal('networkAccessEnabled' in profile.threadOptions, false);
  const raw = profile.configOverrides[0];
  assert.match(raw, /":root"="deny"/);
  assert.match(raw, /":minimal"="read"/);
  assert.match(raw, /":tmpdir"="deny"/);
  assert.match(raw, /":slash_tmp"="deny"/);
  assert.match(raw, /"\/tmp"="deny"/);
  assert.match(raw, /"\/private\/tmp"="deny"/);
  assert.match(raw, /":workspace_roots"=\{"\."="write","\.git"="read","\.codex"="deny","\.wimzo"="deny","\.env"="deny","\*\*\/\*\.env"="deny"\}/);
  assert.match(raw, /"\/repo\/\.git"="read"/);
  assert.match(raw, /"\/repo\/\.git\/worktrees\/task"="write"/);
  assert.match(raw, /"\/opt\/wimzo\/codex-sdk-cli\.mjs"="read"/);
  assert.match(raw, /"\/runs\/task\/scratch"="write"/);
  assert.match(raw, /"network"=\{"enabled"=false\}/);
});

test('Codex workspace permission profile rejects broad and shared git write grants', () => {
  assert.throws(() => codexWorkspacePermissionProfile({ workspace: '/' }), /filesystem root/);
  assert.throws(() => codexWorkspacePermissionProfile({ workspace: '/worktrees/task', gitCommonDir: '/repo/.git' }), /supplied together/);
  assert.throws(() => codexWorkspacePermissionProfile({ workspace: '/worktrees/task', gitCommonDir: '/repo/.git', gitWorktreeDir: '/other/.git/worktrees/task' }), /descendant/);
  assert.throws(() => codexWorkspacePermissionProfile({ workspace: '/worktrees/task', scratchDir: '/worktrees/task/scratch' }), /outside the workspace/);
  assert.throws(() => codexWorkspacePermissionProfile({ workspace: '/worktrees/task', scratchDir: '/private/tmp/wimzo-scratch' }), /outside shared temporary directories/);
});

test('Codex read-only profile keeps the isolated workspace and git metadata readable with only its scratch writable', () => {
  const profile = codexWorkspacePermissionProfile({ workspace: '/repo', write: false, gitCommonDir: '/repo/.git', gitWorktreeDir: '/repo/.git', scratchDir: '/runs/verify/scratch' });
  const raw = profile.configOverrides[0];
  assert.match(raw, /"extends"=":read-only"/);
  assert.match(raw, /":workspace_roots"=\{"\."="read"/);
  assert.match(raw, /"\/repo\/\.git"="read"/);
  assert.match(raw, /"\/runs\/verify\/scratch"="write"/);
});

test('Codex runtime allowlist contains the launcher and its exact installed bundle only', () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-codex-runtime-'));
  const bundle = join(root, 'Caskroom', 'codex', '0.154.0');
  const binary = join(bundle, 'bin', 'codex');
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, 'fixture');
  const launcher = join(root, 'bin', 'codex');
  mkdirSync(dirname(launcher));
  symlinkSync(binary, launcher);
  const paths = codexRuntimeReadPaths(launcher);
  assert.ok(paths.includes(realpathSync(binary)));
  assert.ok(paths.includes(realpathSync(bundle)));
  assert.equal(paths.some(path => path === root || path === dirname(root)), false);
  assert.ok(paths.every(existsSync));
  assert.equal(codexRuntime(launcher).executable, realpathSync(binary));
  const direct = join(root, 'direct', 'bin', 'codex');
  mkdirSync(dirname(direct), { recursive: true });
  writeFileSync(direct, 'fixture');
  assert.deepEqual(codexRuntimeReadPaths(direct), [realpathSync(direct)]);
});
