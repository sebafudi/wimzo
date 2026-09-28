import { Store, assert, now } from './store.ts';

export type RunOutcome = 'in_progress' | 'completed' | 'failed' | 'blocked' | 'paused' | 'canceled' | 'interrupted';

const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const text = (value: unknown, max = 2000) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const texts = (value: unknown, max = 10) => (Array.isArray(value) ? value : [value]).map(item => text(item, 600)).filter((item): item is string => Boolean(item)).slice(0, max);

export function workerChangelog(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const account = { changed: text(input.changed), possibleNow: text(input.possibleNow), availability: text(input.availability), limits: texts(input.limits) };
  return account.changed || account.possibleNow || account.availability || account.limits.length ? account : null;
}

function outcomeOf(run: any, task: any): RunOutcome {
  if (run.status === 'completed' || run.state === 'Completed') return 'completed';
  if (run.status === 'canceled' || run.state === 'Canceled') return 'canceled';
  if (run.status === 'failed' || run.state === 'Failed') return task?.stopped?.runId === run.id && task.stopped.state === 'Blocked' ? 'blocked' : 'failed';
  if (run.status === 'paused' || run.state === 'Paused') return run.launchState === 'outcome-unknown' ? 'interrupted' : 'paused';
  return 'in_progress';
}

function availabilityOf(outcome: RunOutcome, task: any): string {
  if (outcome === 'in_progress') return 'Work is still in progress. Nothing from this run is available to use yet.';
  if (outcome !== 'completed') return 'This run did not deliver a usable change. Any saved progress stays in its checkpoint for review.';
  if (task?.state === 'Accepted') return 'The owner accepted this result. It becomes usable in the active product only after activation.';
  return 'The result exists only as a candidate awaiting verification and owner review. It is not active in the product.';
}

const headline: Record<RunOutcome, string> = {
  in_progress: 'The run is still in progress.',
  completed: 'The run finished and reported a result.',
  failed: 'The run failed before delivering a result.',
  blocked: 'The run could not start or continue and is blocked.',
  paused: 'The run was paused with its progress saved.',
  canceled: 'The run was canceled.',
  interrupted: 'The run stopped abruptly without a final report.',
};

export function buildRunChangelog(store: Store, runId: string) {
  const run = store.require<any>('run', runId);
  const task = run.taskId ? store.get<any>('task', run.taskId) : undefined;
  const outcome = outcomeOf(run, task);
  const progress = store.list<any>('worker_checkpoint').filter(item => item.runId === run.id);
  const account = [...progress].reverse().map(item => item.changelog).find(Boolean) ?? null;
  const attempts = run.taskId ? store.list<any>('run').filter(item => item.taskId === run.taskId) : [run];
  const attempt = attempts.findIndex(item => item.id === run.id);
  const limits = [...(account?.limits ?? []), ...texts([task?.stopped?.runId === run.id ? task.stopped.reason : undefined, run.error, run.resumeBlockedReason, run.candidateCaptureError])];
  const unknowns = outcome === 'in_progress' ? ['The final outcome is not known yet.']
    : outcome === 'interrupted' ? ['The run stopped without a final report. Anything after the last saved checkpoint is unknown.']
    : !account && outcome !== 'completed' ? ['The worker did not save a user-facing account before stopping.'] : [];
  const results = store.list<any>('result').filter(item => item.runId === run.id);
  const checks = [...progress.flatMap(item => item.checks ?? []), ...(run.checks ?? []), ...results.flatMap(item => item.checks ?? [])].slice(-20);
  return {
    id: run.id, runId: run.id, taskId: run.taskId ?? null, projectId: run.projectId ?? task?.projectId ?? null,
    runtime: run.runtime ?? null, runType: run.runType ?? null, purpose: run.purpose ?? null, objective: text(task?.objective, 400) ?? null,
    outcome, headline: headline[outcome],
    changed: account?.changed ?? (outcome === 'completed' ? 'No user-facing change was reported for this run.' : 'No user-facing change was completed in this run.'),
    possibleNow: account?.possibleNow ?? 'Nothing new is available to use yet.',
    availability: availabilityOf(outcome, task), workerAvailability: account?.availability ?? null,
    limits: [...new Set(limits)].slice(0, 10), unknowns,
    progress: progress.slice(-5).map(item => ({ at: item.at, summary: text(item.summary, 600) })),
    checked: checks,
    attempt: attempt + 1, earlierAttempts: attempts.slice(0, Math.max(attempt, 0)).map(item => ({ runId: item.id, outcome: outcomeOf(item, task) })),
    evidence: { logs: run.paths ? { stdout: run.paths.stdout, stderr: run.paths.stderr, status: run.paths.status } : null, checkpoints: [...store.list<any>('checkpoint').filter(item => item.runId === run.id).map(item => item.id), ...progress.map(item => item.id)], results: results.map(item => item.id) },
  };
}

function persistRunChangelog(store: Store, runId: string, reason: string) {
  return store.tx(() => {
    const entry = buildRunChangelog(store, runId);
    const prior = store.get<any>('run_changelog', runId);
    const { rev: _rev, savedAt: _savedAt, reason: _reason, ...previous } = prior ?? {};
    if (prior && canonical(previous) === canonical(entry)) return prior;
    const saved = store.put('run_changelog', { ...entry, reason, savedAt: now() }, prior?.rev);
    store.event('run.changelog.saved', entry.projectId, { runId, taskId: entry.taskId, outcome: entry.outcome, reason });
    return saved;
  });
}

/** Saves the changelog for a run; concurrent writers retry, and a changelog write never fails the caller's run transition. */
export function saveRunChangelog(store: Store, runId: string, reason: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return persistRunChangelog(store, runId, reason); }
    catch (error) { if (!/Stale run_changelog revision/.test(String((error as Error)?.message))) break; }
  }
  return store.get<any>('run_changelog', runId) ?? buildRunChangelog(store, runId);
}

export function runChangelogs(store: Store, input: { projectId?: string; taskId?: string; runId?: string; limit?: number }) {
  assert(input.projectId || input.taskId || input.runId, 'projectId, taskId or runId is required');
  const runs = input.runId ? [store.require<any>('run', input.runId)] : store.list<any>('run').filter(run => (!input.taskId || run.taskId === input.taskId) && (!input.projectId || run.projectId === input.projectId));
  const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20) || 20));
  return { entries: runs.reverse().slice(0, limit).map(run => saveRunChangelog(store, run.id, 'retrieved')) };
}
