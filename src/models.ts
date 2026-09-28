import { assert, hash, now, type Store } from './store.ts';

export type ModelRecord = {
  id: string;
  provider: string;
  harnesses: string[];
  authRoutes: string[];
  description: string;
  source: string;
  updatedAt: string;
  rev: number;
  revision?: number;
  discovery?: ModelDiscovery;
  updatedBy?: Author & { at: string; requestedBy?: string };
};

export type ModelDiscovery = {
  available: boolean;
  thinkingLevels: string[] | null;
  contextWindow: number | null;
  lastSeen: string | null;
};

export type Author = { id: string; role: string };

export type WorkerPolicy = {
  providers?: string[];
  authRoutes?: string[];
  harnesses?: string[];
  models?: string[];
};

export type ExecutionPolicyInput = {
  harness: string;
  provider: string;
  model?: string;
  authRoute: string;
};

type Runtime = { name?: unknown; models?: unknown; modelMetadata?: unknown; provider?: unknown; authRoute?: unknown };

const LEGACY_CODEX_ROUTE = { harness: 'codex', provider: 'openai', authRoute: 'subscription' };

function compact(value: unknown, limit: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
}

function cleanList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  assert(Array.isArray(value), `${field} must be an array when supplied`);
  const result = value.map(item => compact(item, 160)).filter(Boolean);
  assert(result.length === value.length, `${field} contains an invalid value`);
  return [...new Set(result)];
}

function policyValue(value: unknown): WorkerPolicy {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    providers: cleanList(candidate.providers, 'providers'),
    authRoutes: cleanList(candidate.authRoutes, 'authRoutes'),
    harnesses: cleanList(candidate.harnesses, 'harnesses'),
    models: cleanList(candidate.models, 'models'),
  };
}

const FAMILY_DESCRIPTIONS: Array<[string, string]> = [
  ['astra', 'Frontier model for ambiguous, high-risk planning, debugging and complex review; highest cost and latency, so reserve it for work that justifies deeper verification.'],
  ['sol', 'Workhorse for routine implementation and maintenance after a clear plan; moderate cost. Escalate to Astra or Opus for unclear requirements or repeated failed checks.'],
  ['terra', 'Balanced model for straightforward implementation and integration; moderate cost between the Luna and Sol roles.'],
  ['luna', 'Fast, affordable model for small edits, extraction and focused checks; lowest cost and latency. Escalate to Sol when the change spans several files.'],
  ['mini', 'Fast, affordable model for small edits, extraction and focused checks; lowest cost and latency. Escalate when the change spans several files.'],
  ['spark', 'Fast, affordable model for small edits, extraction and focused checks; lowest cost and latency. Escalate when the change spans several files.'],
  ['opus', 'Claude model for difficult planning, architecture and judgment-heavy review; highest Claude cost and latency, so hand clear bounded implementation to a cheaper model.'],
  ['sonnet', 'Claude model for routine implementation and focused review; balanced cost and latency. Escalate to Opus for ambiguity or cross-cutting design.'],
  ['haiku', 'Claude model for fast, low-cost extraction, small edits and simple checks. Escalate to Sonnet when checks fail or scope grows.'],
];

function discoveredDescription(id: string, harness: string): string {
  const name = id.toLowerCase();
  const tokens = name.split(/[^a-z0-9.]+/).filter(Boolean);
  const family = FAMILY_DESCRIPTIONS.find(([label]) => tokens.includes(label))?.[1];
  if (!family) return `Use for bounded ${harness} work after planning, with verification matched to the approved scope. Strengths and cost are not yet described.`;
  if (/^gpt-6(?:-|$)/.test(name)) return `GPT-6 generation, stronger than the GPT-5.6 model with the same role. ${family}`;
  if (/^gpt-5\.6(?:-|$)/.test(name)) return `Older GPT-5.6 generation. ${family} Prefer the GPT-6 model with the same role when it is available.`;
  return family;
}

type ModelRow = Omit<ModelRecord, 'updatedAt' | 'rev' | 'revision' | 'discovery'> & { facts: Pick<ModelDiscovery, 'thinkingLevels' | 'contextWindow'> };

function thinkingLevels(source: Record<string, unknown>): string[] | null {
  const list = [source.thinkingLevels, source.thinking, source.reasoningEfforts, source.thinkingSupport].find(Array.isArray) as unknown[] | undefined;
  if (!list) return null;
  return [...new Set(list.slice(0, 16).map(item => compact(typeof item === 'string' ? item : (item as any)?.effort ?? (item as any)?.id, 80)).filter(Boolean))];
}

function modelRows(runtimes: Runtime[]): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const runtime of runtimes) {
    const harness = compact(runtime.name, 80);
    if (!harness || harness.endsWith('-profile')) continue;
    const metadata = Array.isArray(runtime.models) ? runtime.models : Array.isArray(runtime.modelMetadata) ? runtime.modelMetadata : [];
    const provider = compact(runtime.provider, 80) || (harness === 'codex' ? 'openai' : harness);
    const authRoute = compact(runtime.authRoute, 80) || (harness === 'codex' ? 'subscription' : 'unavailable');
    for (const value of metadata.slice(0, 64)) {
      const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const id = typeof value === 'string' ? compact(value, 160) : compact(source.id, 160);
      if (!id) continue;
      const supplied = compact(source.description, 360);
      rows.push({
        id,
        provider,
        harnesses: [harness],
        authRoutes: [authRoute],
        description: supplied || discoveredDescription(id, harness),
        source: `runtime-capability:${harness}`,
        facts: { thinkingLevels: thinkingLevels(source), contextWindow: typeof source.contextWindow === 'number' && Number.isFinite(source.contextWindow) ? source.contextWindow : null },
      });
    }
  }
  const merged = new Map<string, ModelRow>();
  for (const row of rows) {
    const key = `${row.provider}:${row.id}`;
    const previous = merged.get(key);
    const levels = previous && (previous.facts.thinkingLevels || row.facts.thinkingLevels) ? [...new Set([...previous.facts.thinkingLevels ?? [], ...row.facts.thinkingLevels ?? []])] : row.facts.thinkingLevels;
    merged.set(key, previous ? { ...previous, harnesses: [...new Set([...previous.harnesses, ...row.harnesses])], authRoutes: [...new Set([...previous.authRoutes, ...row.authRoutes])], facts: { thinkingLevels: levels, contextWindow: previous.facts.contextWindow ?? row.facts.contextWindow } } : row);
  }
  return [...merged.values()];
}

export function validateExecutionPolicy(store: Store, projectId: string, input: ExecutionPolicyInput): { projectId: string; policy: WorkerPolicy; revision: number } {
  store.require('project', projectId);
  const policyRecord = store.get<any>('project_worker_policy', projectId);
  const policy = policyValue(policyRecord?.policy);
  const request = {
    harness: compact(input.harness, 80),
    provider: compact(input.provider, 80),
    model: input.model === undefined ? undefined : compact(input.model, 160),
    authRoute: compact(input.authRoute, 80),
  };
  assert(request.harness && request.provider && request.authRoute, 'Execution policy requires harness, provider, and authentication route');
  // Project allowlists narrow locally approved coding routes. They cannot turn a
  // paid API credential into an approved coding route. TypeSafe is deliberately
  // outside this execution policy because it only supplies recommendations.
  assert(request.authRoute === 'subscription', 'Paid coding API authentication routes are not permitted');
  const fields: Array<[keyof WorkerPolicy, string | undefined, string]> = [
    ['harnesses', request.harness, 'harness'],
    ['providers', request.provider, 'provider'],
    ['authRoutes', request.authRoute, 'authentication route'],
  ];
  for (const [field, value, label] of fields) {
    const allowed = policy[field];
    if (allowed !== undefined) {
      assert(allowed.includes(value!), `Project worker policy denies ${label}: ${value}`);
      continue;
    }
    const defaultValue = field === 'harnesses' ? LEGACY_CODEX_ROUTE.harness : field === 'providers' ? LEGACY_CODEX_ROUTE.provider : LEGACY_CODEX_ROUTE.authRoute;
    assert(value === defaultValue, `Project worker policy has no permitted installed ${label}: ${value}`);
  }
  if (policy.models !== undefined) {
    assert(typeof request.model === 'string' && policy.models.includes(request.model), `Project worker policy denies model: ${request.model ?? 'account default'}`);
  }
  return { projectId, policy, revision: policyRecord?.rev ?? 0 };
}

export function Models(store: Store) {
  function sync(runtimes: Runtime[]): ModelRecord[] {
    const seenAt = now();
    const seen = new Set<string>();
    for (const { facts, ...row } of modelRows(runtimes)) {
      const id = `${row.provider}:${row.id}`;
      seen.add(id);
      if (!store.get<ModelRecord>('worker_model', id)) store.put<ModelRecord>('worker_model', { ...row, id, updatedAt: seenAt });
      store.put('worker_model_discovery', { id, available: true, ...facts, lastSeen: seenAt });
    }
    for (const record of store.list<ModelRecord>('worker_model')) {
      if (seen.has(record.id)) continue;
      const previous = store.get<any>('worker_model_discovery', record.id);
      if (previous?.available !== false) store.put('worker_model_discovery', { id: record.id, available: false, thinkingLevels: previous?.thinkingLevels ?? null, contextWindow: previous?.contextWindow ?? null, lastSeen: previous?.lastSeen ?? null });
    }
    return list();
  }

  function discovery(id: string): ModelDiscovery {
    const value = store.get<any>('worker_model_discovery', id);
    return { available: value?.available === true, thinkingLevels: Array.isArray(value?.thinkingLevels) ? value.thinkingLevels : null, contextWindow: typeof value?.contextWindow === 'number' ? value.contextWindow : null, lastSeen: typeof value?.lastSeen === 'string' ? value.lastSeen : null };
  }

  function list(): ModelRecord[] {
    return store.list<ModelRecord>('worker_model').map(record => ({ ...record, revision: record.rev, discovery: discovery(record.id) } as ModelRecord));
  }

  function find(provider: string, model: string): ModelRecord | undefined {
    return store.get<ModelRecord>('worker_model', `${provider}:${model}`);
  }

  function describe(input: { provider?: unknown; model?: unknown; id?: unknown; description?: unknown; source?: unknown; expectedRev?: unknown; requestedBy?: unknown }, author: Author = { id: 'owner', role: 'owner' }): ModelRecord {
    const provider = compact(input.provider, 80) || 'openai';
    const model = compact(input.model ?? input.id, 160);
    assert(model, 'model is required');
    const existing = store.require<ModelRecord>('worker_model', `${provider}:${model}`);
    const description = compact(input.description, 360);
    const source = compact(input.source, 180);
    assert(description, 'description is required');
    assert(source, 'source is required');
    assert(Number.isInteger(input.expectedRev) && Number(input.expectedRev) >= 1, 'expectedRev is required');
    assert(author.role === 'owner' || author.role === 'guide', 'Only the owner or guide can edit model descriptions');
    const requestedBy = compact(input.requestedBy, 1000);
    assert(author.role !== 'guide' || requestedBy, 'requestedBy must record the owner request for a guide edit');
    const updatedBy = { id: compact(author.id, 160), role: author.role, at: now(), ...(requestedBy ? { requestedBy } : {}) };
    const updated = store.put<ModelRecord>('worker_model', { ...existing, description, source, updatedAt: updatedBy.at, updatedBy }, Number(input.expectedRev));
    store.event('model.description.updated', null, { provider, model, source, revision: updated.rev, actor: { id: updatedBy.id, role: updatedBy.role }, requestedBy: requestedBy || null }, `model-description:${provider}:${model}:${updated.rev}`);
    return { ...updated, revision: updated.rev, discovery: discovery(updated.id) } as ModelRecord;
  }

  type PolicyView = { projectId: string; policy: WorkerPolicy; revision: number; updatedAt: string | null; updatedBy: Author | null };

  function getWorkerPolicy(projectId: string): PolicyView {
    store.require('project', projectId);
    const record = store.get<any>('project_worker_policy', projectId);
    return { projectId, policy: policyValue(record?.policy), revision: record?.rev ?? 0, updatedAt: record?.updatedAt ?? null, updatedBy: record?.updatedBy ?? null };
  }

  function setWorkerPolicy(projectId: string, policyInput: unknown, expectedRev?: unknown, author: Author = { id: 'owner', role: 'owner' }): PolicyView {
    store.require('project', projectId);
    assert(Number.isInteger(expectedRev) && Number(expectedRev) >= 0, 'expectedRev is required');
    const policy = policyValue(policyInput);
    const updatedBy = { id: compact(author.id, 160), role: compact(author.role, 40) };
    const updated = store.put<any>('project_worker_policy', { id: projectId, projectId, policy, updatedAt: now(), updatedBy }, Number(expectedRev));
    store.event('project.worker_policy.updated', projectId, { revision: updated.rev, policy, actor: updatedBy }, `project-worker-policy:${projectId}:${updated.rev}`);
    return { projectId, policy, revision: updated.rev, updatedAt: updated.updatedAt, updatedBy };
  }

  function revision(runtimes: Runtime[] = [], candidates?: Iterable<string>): string {
    const keys = candidates ? new Set(candidates) : undefined;
    const active = modelRows(runtimes).filter(row => !keys || keys.has(`${row.provider}:${row.id}`)).map(row => {
      const saved = find(row.provider, row.id);
      return { id: row.id, provider: row.provider, harnesses: row.harnesses, authRoutes: row.authRoutes, description: saved?.description ?? row.description, source: saved?.source ?? row.source, revision: saved?.rev ?? 0 };
    });
    return hash(JSON.stringify(active.sort((a, b) => `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`))));
  }

  return { sync, list, find, describe, getWorkerPolicy, setWorkerPolicy, revision };
}
