import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type WorkerDependencySetup = {
  status: 'linked' | 'present' | 'unavailable';
  dependencyRoot: string | null;
  donor: 'canonical-project' | 'runtime-checkout' | null;
  reason: string | null;
};

export type WorkerDependencyInput = {
  worktree: string;
  canonicalProject: string;
  runtimeCheckout?: string;
};

type Donor = { root: string; donor: 'canonical-project' | 'runtime-checkout' };

function directory(value: unknown, label: string) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const path = realpathSync(value);
  if (!lstatSync(path).isDirectory()) throw new Error(`${label} must be a directory`);
  return path;
}

function metadata(path: string) {
  try { return lstatSync(path); } catch { return null; }
}

function regularFile(path: string) {
  const value = metadata(path);
  return !!value && value.isFile() && !value.isSymbolicLink();
}

function commonDirectory(root: string) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) return null;
  try { return realpathSync(resolve(root, result.stdout.trim())); } catch { return null; }
}

function ignoredByGit(root: string, path: string) {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', path], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return result.status === 0;
}

const MIRROR_MARKER = '.wimzo-dependency-root';

/**
 * `node_modules` ignores both a directory and a link; `node_modules/` ignores only a directory,
 * so a link would appear as untracked source and the dependencies are mirrored inside a real directory instead.
 */
function ignoreMode(root: string): 'link' | 'mirror' | null {
  if (ignoredByGit(root, 'node_modules')) return 'link';
  return ignoredByGit(root, 'node_modules/') ? 'mirror' : null;
}

function mirroredRoot(targetModules: string) {
  const marker = join(targetModules, MIRROR_MARKER);
  return regularFile(marker) ? readFileSync(marker, 'utf8').trim() : null;
}

function mirrorDependencies(dependencyRoot: string, targetModules: string) {
  mkdirSync(targetModules);
  try {
    for (const entry of readdirSync(dependencyRoot)) if (entry !== MIRROR_MARKER) symlinkSync(join(dependencyRoot, entry), join(targetModules, entry));
    writeFileSync(join(targetModules, MIRROR_MARKER), `${dependencyRoot}\n`, { mode: 0o600 });
  } catch (error) { rmSync(targetModules, { recursive: true, force: true }); throw error; }
}

function donorDependencyRoot(root: string) {
  const expected = join(root, 'node_modules');
  const value = metadata(expected);
  if (!value?.isDirectory() || value.isSymbolicLink()) return null;
  try { return realpathSync(expected) === expected ? expected : null; } catch { return null; }
}

function unavailable(reason: string): WorkerDependencySetup { return { status: 'unavailable', dependencyRoot: null, donor: null, reason }; }

/**
 * Reuse dependencies for an isolated worker only when the target and donor
 * are worktrees of the same Git repository and their package locks are byte-equal.
 */
export function prepareWorkerDependencies(input: WorkerDependencyInput): WorkerDependencySetup {
  const worktree = directory(input.worktree, 'worktree');
  const canonicalProject = directory(input.canonicalProject, 'canonicalProject');
  const runtimeCheckout = input.runtimeCheckout === undefined ? null : directory(input.runtimeCheckout, 'runtimeCheckout');
  const targetLock = join(worktree, 'package-lock.json');
  const targetModules = join(worktree, 'node_modules');
  if (!regularFile(targetLock)) return unavailable('Worker worktree has no regular package-lock.json.');
  const mode = ignoreMode(worktree);
  if (!mode) return unavailable('Worker worktree does not ignore node_modules in Git.');
  const common = commonDirectory(worktree);
  if (!common) return unavailable('Worker worktree is not a usable Git checkout.');
  const targetLockBytes = readFileSync(targetLock); const existing = metadata(targetModules);
  let existingDependencyRoot: string | null = existing?.isDirectory() && !existing.isSymbolicLink() ? mirroredRoot(targetModules) : null;
  if (existing && !existing.isSymbolicLink() && !existingDependencyRoot) return { status: 'present', dependencyRoot: null, donor: null, reason: 'Worker worktree already has node_modules; it was preserved.' };
  if (existing?.isSymbolicLink()) { try { existingDependencyRoot = realpathSync(targetModules); } catch { return unavailable('Worker worktree has a broken node_modules link; it was preserved.'); } }
  const candidates: Donor[] = [{ root: canonicalProject, donor: 'canonical-project' }, ...(runtimeCheckout ? [{ root: runtimeCheckout, donor: 'runtime-checkout' as const }] : [])];
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (visited.has(candidate.root)) continue;
    visited.add(candidate.root);
    if (commonDirectory(candidate.root) !== common) continue;
    const donorLock = join(candidate.root, 'package-lock.json');
    if (!regularFile(donorLock) || !readFileSync(donorLock).equals(targetLockBytes)) continue;
    const dependencyRoot = donorDependencyRoot(candidate.root);
    if (!dependencyRoot) continue;
    if (existingDependencyRoot) {
      if (existingDependencyRoot === dependencyRoot) return { status: 'linked', dependencyRoot, donor: candidate.donor, reason: null };
      continue;
    }
    try { if (mode === 'link') symlinkSync(dependencyRoot, targetModules, 'dir'); else mirrorDependencies(dependencyRoot, targetModules); }
    catch { return unavailable('Worker dependency link could not be created without replacing existing files.'); }
    return { status: 'linked', dependencyRoot, donor: candidate.donor, reason: null };
  }
  return unavailable(existingDependencyRoot ? 'Worker worktree has a node_modules link outside the exact allowed donor roots; it was preserved.' : 'No allowed same-repository donor has an exact package-lock.json and a real node_modules directory.');
}
