import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const CODEX_WORKSPACE_PERMISSION_PROFILE = 'wimzo-workspace-v1';

export type CodexWorkspacePermissionInput = {
  workspace: string;
  write?: boolean;
  gitCommonDir?: string;
  gitWorktreeDir?: string;
  runtimeReadPaths?: string[];
  scratchDir?: string;
};

type TomlValue = string | boolean | { [key: string]: TomlValue };

function requiredAbsolutePath(value: unknown, label: string) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const path = resolve(value);
  if (path === '/') throw new Error(`${label} must not be the filesystem root`);
  return path;
}

function descendant(path: string, ancestor: string) {
  const part = relative(ancestor, path);
  return part.length > 0 && !part.startsWith('..') && !isAbsolute(part);
}

function sharedTemporaryDirectories(scratchDir: string | null): string[] {
  const paths = new Set(['/tmp', '/private/tmp', tmpdir()]);
  for (const path of [...paths]) try { paths.add(realpathSync(path)); } catch {}
  return [...paths].map(path => resolve(path)).filter(path => path !== scratchDir);
}

function toml(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
}

function installedCodexLauncher(command: string): string {
  if (isAbsolute(command)) return requiredAbsolutePath(command, 'Codex executable');
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return requiredAbsolutePath(candidate, 'Codex executable');
  }
  throw new Error('Installed Codex executable is unavailable');
}

/**
 * Return only the selected launcher and its versioned installed bundle. This
 * deliberately excludes the project checkout and the entire package-manager
 * prefix while allowing Codex's bundled helper binaries and resources.
 */
export function codexRuntime(command = process.env.WIMZO_CODEX_BINARY ?? 'codex') {
  const launcher = installedCodexLauncher(command);
  const target = realpathSync(launcher);
  const binaryDirectory = dirname(target);
  const candidateBundle = basename(binaryDirectory) === 'bin' ? dirname(binaryDirectory) : null;
  const bundle = candidateBundle && /[\\/]Caskroom[\\/]codex[\\/][^\\/]+$/.test(candidateBundle) ? candidateBundle : null;
  return { executable: target, readPaths: [...new Set([target, bundle].filter((value): value is string => value !== null))] };
}

export function codexRuntimeReadPaths(command = process.env.WIMZO_CODEX_BINARY ?? 'codex'): string[] {
  return codexRuntime(command).readPaths;
}

/**
 * Codex SDK config for one isolated worktree. The caller must preserve the
 * returned omission of sandboxMode and networkAccessEnabled on ThreadOptions,
 * because either legacy setting disables permission profile enforcement.
 */
export function codexWorkspacePermissionProfile(input: CodexWorkspacePermissionInput) {
  const workspace = requiredAbsolutePath(input.workspace, 'workspace');
  const write = input.write ?? true;
  if (typeof write !== 'boolean') throw new Error('write must be a boolean');
  if ((input.gitCommonDir === undefined) !== (input.gitWorktreeDir === undefined)) throw new Error('gitCommonDir and gitWorktreeDir must be supplied together');
  const gitCommonDir = input.gitCommonDir === undefined ? null : requiredAbsolutePath(input.gitCommonDir, 'gitCommonDir');
  const gitWorktreeDir = input.gitWorktreeDir === undefined ? null : requiredAbsolutePath(input.gitWorktreeDir, 'gitWorktreeDir');
  const scratchDir = input.scratchDir === undefined ? null : requiredAbsolutePath(input.scratchDir, 'scratchDir');
  if (scratchDir && (scratchDir === workspace || descendant(scratchDir, workspace) || descendant(workspace, scratchDir))) throw new Error('scratchDir must be outside the workspace');
  if (scratchDir && sharedTemporaryDirectories(null).some(path => scratchDir === path || descendant(scratchDir, path))) throw new Error('scratchDir must be outside shared temporary directories');
  if (gitCommonDir && gitWorktreeDir && gitWorktreeDir !== gitCommonDir && !descendant(gitWorktreeDir, gitCommonDir)) throw new Error('gitWorktreeDir must be a descendant of gitCommonDir or equal to it for an isolated ordinary repository');
  const runtimeReadPaths = [...new Set((input.runtimeReadPaths ?? []).map((path, index) => requiredAbsolutePath(path, `runtimeReadPaths[${index}]`)))].filter(path => path !== workspace && path !== gitCommonDir && path !== gitWorktreeDir);
  const filesystem: { [key: string]: TomlValue } = {
    ':root': 'deny',
    ':minimal': 'read',
    ':tmpdir': 'deny',
    ':slash_tmp': 'deny',
    ':workspace_roots': {
      '.': write ? 'write' : 'read',
      '.git': 'read',
      '.codex': 'deny',
      '.wimzo': 'deny',
      '.env': 'deny',
      '**/*.env': 'deny',
    },
  };
  if (scratchDir) for (const path of sharedTemporaryDirectories(scratchDir)) filesystem[path] = 'deny';
  if (gitCommonDir) filesystem[gitCommonDir] = 'read';
  if (gitWorktreeDir) filesystem[gitWorktreeDir] = write ? 'write' : 'read';
  if (scratchDir) filesystem[scratchDir] = 'write';
  for (const path of runtimeReadPaths) filesystem[path] = 'read';
  const profile = {
    description: 'Wimzo isolated worktree commands only.',
    extends: write ? ':workspace' : ':read-only',
    workspace_roots: { [workspace]: true },
    filesystem,
    network: { enabled: false },
  };
  return {
    profile: CODEX_WORKSPACE_PERMISSION_PROFILE,
    config: { default_permissions: CODEX_WORKSPACE_PERMISSION_PROFILE },
    configOverrides: [`permissions.${CODEX_WORKSPACE_PERMISSION_PROFILE}=${toml(profile)}`],
    threadOptions: { workingDirectory: workspace, approvalPolicy: 'never', webSearchMode: 'disabled' as const },
  };
}
