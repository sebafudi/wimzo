import { assert, now, type RecordValue, type Store } from './store.ts';
import { baseRuntime } from './worker-profile.ts';

type Role = 'owner' | 'guide' | 'worker' | 'system';
type Actor = { role: Role; id: string; taskId?: string };
type ExecutionApi = { call(action: string, input: Record<string, any>, actor: Actor): Promise<any> };

type Project = RecordValue & { name: string };
type Task = RecordValue & {
  projectId: string; objective?: string; state?: string; runtime?: string; runId?: string; deadline?: string;
  worktree?: string | boolean; permissions?: string[]; budget?: Record<string, any>; phase?: { name?: string; note?: string; at?: string };
  candidate?: Record<string, any>;
};
type Run = RecordValue & {
  taskId?: string; projectId?: string; runtime?: string; runType?: 'technical' | 'script' | 'gui';
  status?: string; state?: string; purpose?: string; startedAt?: string; finishedAt?: string; endedAt?: string;
  deadline?: string; worktree?: string; workerProfile?: Record<string, any>; usage?: Record<string, any>; sdkUsage?: Record<string, any>;
  contextTelemetry?: Record<string, any>; sdkSessionId?: string; sessionId?: string; lastProgress?: string | Record<string, any>;
  waitingReason?: string; paths?: Record<string, string>;
};

const activeStatuses = new Set(['running', 'awaiting_session', 'cancel_requested', 'canceling', 'pause_requested']);
const terminalRunStates = new Set(['completed', 'failed', 'paused', 'canceled', 'cancelled']);
const runtimeLabels: Record<string, string> = {
  script: 'Local script', codex: 'Codex CLI', claude: 'Claude CLI', pi: 'Pi', 'pi-profile': 'Pi SDK', 'codex-app': 'Codex desktop', 'codex-profile': 'Codex SDK', 'claude-profile': 'Claude SDK',
};

function nullableString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function nullableNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function compact(value: unknown, limit = 500): string | null {
  const text = nullableString(value);
  return text ? text.replace(/[\r\n\t]+/g, ' ').slice(0, limit) : null;
}
function iso(value: unknown): string | null { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; }
function timestamp(value: unknown): number | null { const parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function runStatus(run: Run): string {
  if (typeof run.status === 'string') return run.status;
  if (run.state === 'Running') return 'running';
  return String(run.state ?? 'unknown').toLowerCase();
}
function isExecutionRun(run: Run): boolean { return typeof run.status === 'string' || typeof (run as any).adapterVersion === 'number'; }
function isActive(run: Run): boolean { return activeStatuses.has(runStatus(run)); }
function isTerminal(run: Run): boolean { return terminalRunStates.has(runStatus(run)); }
function endAt(run: Run | undefined): string | null { return iso(run?.finishedAt) ?? iso(run?.endedAt); }

function runtimeProfile(run: Run | undefined, task: Task) {
  const profile = run?.workerProfile && typeof run.workerProfile === 'object'
    ? run.workerProfile
    : task.budget?.workerProfile && typeof task.budget.workerProfile === 'object' ? task.budget.workerProfile : undefined;
  const runtime = nullableString(run?.runtime) ?? nullableString(task.runtime);
  if (profile) {
    return {
      runtime,
      provider: nullableString(profile.provider) ?? nullableString((run as any)?.provider) ?? 'openai',
      model: nullableString(profile.model),
      thinking: nullableString(profile.thinking),
      contextWindow: nullableNumber(profile.contextWindow),
      authRoute: nullableString(profile.authRoute),
      profileSource: nullableString(profile.source) ?? 'approved task profile',
    };
  }
  if (runtime === 'codex') return { runtime, provider: 'codex', model: 'adapter default', thinking: 'adapter default', contextWindow: null, authRoute: 'subscription', profileSource: 'adapter default' };
  if (runtime === 'codex-app') return { runtime, provider: 'codex-app', model: null, thinking: null, contextWindow: null, authRoute: null, profileSource: 'native app unknown' };
  return { runtime, provider: runtime, model: null, thinking: null, contextWindow: null, authRoute: null, profileSource: null };
}

function contextFor(run: Run | undefined, runtimeLimit: any) {
  const telemetry = run?.contextTelemetry && typeof run.contextTelemetry === 'object' ? run.contextTelemetry : {};
  const sdkUsage = run?.sdkUsage && typeof run.sdkUsage === 'object' ? run.sdkUsage : {};
  const usage = run?.usage && typeof run.usage === 'object' ? run.usage : {};
  const limit = runtimeLimit && typeof runtimeLimit === 'object' ? runtimeLimit : {};
  const telemetryContext = telemetry.context && typeof telemetry.context === 'object' ? telemetry.context : telemetry;
  const sdkContext = sdkUsage.context && typeof sdkUsage.context === 'object' ? sdkUsage.context : {};
  const context = usage.context && typeof usage.context === 'object' ? usage.context : {};
  const limitContext = limit.context && typeof limit.context === 'object' ? limit.context : {};
  return {
    used: nullableNumber(telemetryContext.used) ?? nullableNumber(telemetryContext.tokens) ?? nullableNumber(sdkContext.used) ?? nullableNumber(sdkContext.tokens) ?? nullableNumber(usage.contextUsed) ?? nullableNumber(context.used) ?? nullableNumber(limitContext.used),
    capacity: nullableNumber(telemetryContext.capacity) ?? nullableNumber(telemetryContext.contextWindow) ?? nullableNumber(sdkContext.capacity) ?? nullableNumber(sdkContext.contextWindow) ?? nullableNumber(usage.contextCapacity) ?? nullableNumber(context.capacity) ?? nullableNumber(limitContext.capacity),
    estimated: typeof telemetryContext.estimated === 'boolean' ? telemetryContext.estimated : typeof sdkContext.estimated === 'boolean' ? sdkContext.estimated : typeof usage.contextEstimated === 'boolean' ? usage.contextEstimated : typeof context.estimated === 'boolean' ? context.estimated : null,
    source: nullableString(telemetryContext.source) ?? nullableString(sdkContext.source) ?? nullableString(usage.contextSource) ?? nullableString(context.source) ?? nullableString(limit.source),
    observedAt: iso(telemetryContext.observedAt) ?? iso(telemetryContext.at) ?? iso(sdkContext.observedAt) ?? iso(usage.observedAt) ?? iso(context.observedAt) ?? iso(limit.observedAt),
  };
}

function progressFor(run: Run | undefined, task: Task) {
  const reported = run?.lastProgress;
  if (typeof reported === 'string') return { at: iso((run as any)?.updatedAt) ?? iso(run?.startedAt), summary: compact(reported) };
  if (reported && typeof reported === 'object') {
    const summary = compact(reported.summary ?? reported.message ?? reported.note);
    if (summary) return { at: iso(reported.at) ?? iso(reported.observedAt) ?? iso((run as any)?.updatedAt) ?? iso(run?.startedAt), summary };
  }
  const phase = task.state === 'Running' && typeof task.phase?.name === 'string' ? task.phase.name : null;
  return phase ? { at: iso(task.phase?.at), summary: compact(task.phase?.note) ?? phase } : null;
}

function safeLimits(value: any) {
  const limits = value?.limits && typeof value.limits === 'object' ? value.limits : {};
  const provider = limits.provider && typeof limits.provider === 'object' ? limits.provider : {};
  const context = limits.context && typeof limits.context === 'object' ? limits.context : {};
  const task = limits.task && typeof limits.task === 'object' ? limits.task : {};
  return {
    provider: { status: nullableString(provider.status), remaining: nullableNumber(provider.remaining), unit: nullableString(provider.unit) },
    context: { status: nullableString(context.status), used: nullableNumber(context.used), capacity: nullableNumber(context.capacity) },
    task: { status: nullableString(task.status), timeoutMs: nullableNumber(task.timeoutMs) },
    stopNewWork: limits.stopNewWork === true,
    source: nullableString(limits.source),
    observedAt: iso(limits.observedAt),
  };
}

export function Workers(store: Store, execution: ExecutionApi) {
  const actions = () => [
    { name: 'worker.status', description: 'Show a safe, read-only snapshot of durable worker runs, capacity, runtime availability, and queued work.', roles: ['owner', 'guide', 'system'], inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } } } },
  ];

  function project(projectId: string) { return store.require<Project>('project', projectId); }
  function taskTitle(task: Task): string { return compact(task.objective, 280) ?? task.id; }

  function runProjection(run: Run | undefined, task: Task, projectValue: Project, limits: Map<string, any>, overrides: Partial<any> = {}) {
    const profile = runtimeProfile(run, task);
    const runtimeKey = profile.runtime ? baseRuntime(profile.runtime) : profile.runtime;
    const startedAt = iso(run?.startedAt);
    const finishedAt = endAt(run);
    const start = timestamp(startedAt);
    const end = timestamp(finishedAt) ?? (isActive(run ?? {} as Run) ? Date.now() : null);
    const phase = task.state === 'Running' && typeof task.phase?.name === 'string' ? task.phase.name : null;
    const progress = progressFor(run, task);
    const result = store.list<any>('result').filter(value => value.taskId === task.id).at(-1);
    return {
      id: overrides.id ?? run?.id ?? `queue:${task.id}`,
      taskId: task.id,
      taskTitle: taskTitle(task),
      projectId: task.projectId,
      projectName: projectValue.name,
      status: overrides.status ?? (run ? runStatus(run) : 'queued'),
      phase,
      runtime: profile.runtime,
      provider: profile.provider,
      model: profile.model,
      thinking: profile.thinking,
      contextWindow: profile.contextWindow,
      authRoute: profile.authRoute,
      profileSource: profile.profileSource,
      startedAt,
      finishedAt,
      elapsedMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      deadline: iso(run?.deadline) ?? iso(task.deadline),
      worktree: nullableString(run?.worktree) ?? (typeof task.worktree === 'string' ? task.worktree : null),
      permissions: Array.isArray(task.permissions) ? task.permissions.filter(value => typeof value === 'string') : [],
      context: contextFor(run, limits.get(runtimeKey ?? '')),
      lastProgress: progress,
      resultSummary: compact(result?.summary) ?? compact((task as any).resultSummary),
      sessionId: nullableString(run?.sdkSessionId) ?? nullableString(run?.sessionId),
      outputAvailable: Boolean(run?.paths?.result || run?.paths?.stdout || result),
      waitingReasons: overrides.waitingReasons ?? [compact(run?.resumeBlockedReason), compact(run?.waitingReason)].filter(Boolean),
    };
  }

  async function status(input: Record<string, any> = {}, actor: Actor) {
    assert(!input.projectId || typeof input.projectId === 'string', 'projectId must be a string');
    if (input.projectId) project(input.projectId);
    const [runtimeRows, queueRows] = await Promise.all([
      execution.call('runtime.capabilities', {}, actor),
      execution.call('execution.queue', input.projectId ? { projectId: input.projectId } : {}, actor),
    ]);
    const runtimes = Array.isArray(runtimeRows) ? runtimeRows.map(value => ({
      id: nullableString(value?.name) ?? 'unknown', label: runtimeLabels[nullableString(value?.name) ?? ''] ?? nullableString(value?.name) ?? 'Unknown runtime',
      available: value?.available === true, eligible: value?.eligible === true, access: nullableString(value?.access), reason: nullableString(value?.reason),
      version: nullableString(value?.installedVersion) ?? nullableString(value?.version) ?? nullableNumber(value?.version), limits: safeLimits(value),
    })) : [];
    const limits = new Map((Array.isArray(runtimeRows) ? runtimeRows : []).map(value => [String(value?.name ?? ''), value?.limits]));
    const projects = new Map(store.list<Project>('project').map(value => [value.id, value]));
    const tasks = store.list<Task>('task').filter(value => !input.projectId || value.projectId === input.projectId);
    const taskById = new Map(tasks.map(value => [value.id, value]));
    const allRuns = store.list<Run>('run').filter(value => taskById.has(String(value.taskId)));
    const selected = new Map<string, Run>();
    for (const run of allRuns) {
      if (!run.taskId) continue;
      const existing = selected.get(run.taskId);
      if (!existing || (isExecutionRun(run) && !isExecutionRun(existing)) || (isExecutionRun(run) === isExecutionRun(existing) && (timestamp(run.startedAt) ?? 0) > (timestamp(existing.startedAt) ?? 0))) selected.set(run.taskId, run);
    }
    const projections = [...selected.values()]
      .map(run => {
        const task = taskById.get(run.taskId!);
        const projectValue = task ? projects.get(task.projectId) : undefined;
        return task && projectValue ? runProjection(run, task, projectValue, limits) : undefined;
      })
      .filter(Boolean) as any[];
    const active = projections.filter(value => isActive(selected.get(value.taskId)!)).sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
    const recent = projections.filter(value => isTerminal(selected.get(value.taskId)!)).sort((a, b) => String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? ''))).slice(0, 20);
    const queued = (Array.isArray(queueRows) ? queueRows : []).map(row => {
      const task = taskById.get(String(row?.taskId));
      const projectValue = task ? projects.get(task.projectId) : undefined;
      return task && projectValue ? runProjection(undefined, task, projectValue, limits, { id: nullableString(row?.id) ?? `queue:${task.id}`, status: 'queued', waitingReasons: Array.isArray(row?.reasons) ? row.reasons.map((reason: unknown) => compact(reason, 180)).filter(Boolean) : row?.reason ? [compact(row.reason, 180)] : [] }) : undefined;
    }).filter(Boolean);
    const activeRuns = active.map(value => selected.get(value.taskId)!);
    return {
      observedAt: now(),
      capacity: { activeTechnical: activeRuns.filter(run => run.runType === 'technical').length, maxTechnical: 2, activeGui: activeRuns.filter(run => run.runType === 'gui').length, maxGui: 1 },
      runtimes,
      active,
      recent,
      queued,
    };
  }

  async function call(action: string, input: Record<string, any> = {}, actor: Actor) {
    const descriptor = actions().find(value => value.name === action);
    assert(descriptor, `Unknown worker action: ${action}`);
    assert(descriptor.roles.includes(actor?.role), `Role ${actor?.role} cannot call ${action}`);
    return status(input, actor);
  }

  return { actions, call, status };
}
