import { assert } from './store.ts';
import { isProfileRuntime, profileForTask } from './worker-profile.ts';

// Unassigned tasks can select a model runtime, so they need the same approval bounds.
export function assertTechnicalTask(task: any) {
  if (isProfileRuntime(task.runtime)) profileForTask(task);
  if (task.runtime && !['codex', 'claude', 'pi'].includes(task.runtime) && !isProfileRuntime(task.runtime)) return;
  const source = task.sourceCandidate?.commit ?? task.sourceCandidate?.sha ?? task.sourceCandidate?.id;
  assert(typeof source === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(source), 'Technical task requires an exact sourceCandidate commit');
  const writes = task.permissions?.some((value: string) => ['write', 'workspace-write', 'filesystem:write'].includes(value));
  assert(!writes || task.worktree !== false, 'Technical writer requires an isolated worktree');
  assert(typeof task.deadline === 'string' && Number.isFinite(Date.parse(task.deadline)) && Date.parse(task.deadline) > Date.now(), 'Technical task requires a valid future deadline');
}
