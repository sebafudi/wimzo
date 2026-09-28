import { readFileSync } from 'node:fs';
import { hash, now, type Store } from './store.ts';
import { CLAUDE_PROFILE_RUNTIME, dispatchRuntime, runtimeProvider, type WorkerProfile } from './worker-profile.ts';
import { Models, validateExecutionPolicy } from './models.ts';

type RuntimeSource = { call(action: string, input?: Record<string, any>, actor?: any): Promise<any> };
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RecommendationInput = {
  projectId: string;
  subject: string;
  scope: string;
  criteria: string[];
  requirements?: string[];
  specHash?: string;
  permissions?: string[];
  phase?: string;
};

type RecommendationOptions = {
  stateDir?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const MAX_JEV_PROFILES = 64;
const MAX_JEV_REQUEST_BYTES = 48 * 1024;

function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function compact(value: unknown, limit: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
}

function strings(value: unknown, limit: number, itemLimit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map(item => compact(item, itemLimit)).filter(Boolean);
}

function failureCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'request timed out';
  return 'service connection failed';
}

function environmentKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  const file = env.WIMZO_TYPESAFE_ENV_FILE?.trim();
  if (!file) return undefined;
  try {
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(value => /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(value));
    if (!line) return undefined;
    const value = line.replace(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    return value || undefined;
  } catch { return undefined; }
}

export function externalRecommendationConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const optedIn = env.WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS === '1';
  const keyConfigured = Boolean(environmentKey(env));
  return { provider: 'typesafe', optedIn, keyConfigured, enabled: optedIn && keyConfigured };
}

function modelProfiles(runtime: any, models: ReturnType<typeof Models>): WorkerProfile[] {
  const metadata = Array.isArray(runtime?.models) ? runtime.models : Array.isArray(runtime?.modelMetadata) ? runtime.modelMetadata : [];
  const profiles: WorkerProfile[] = [];
  for (const row of metadata.slice(0, 24)) {
    const model = typeof row === 'string' ? row : typeof row?.id === 'string' ? row.id : undefined;
    if (!model) continue;
    const efforts = Array.isArray(row?.thinking) ? row.thinking : Array.isArray(row?.reasoningEfforts) ? row.reasoningEfforts : [undefined];
    for (const effort of efforts.slice(0, 8)) {
      const thinking = typeof effort === 'string' ? effort : effort?.effort;
      if (thinking !== undefined && typeof thinking !== 'string') continue;
      const id = `codex:${model}:${thinking ?? 'default'}`;
      const saved = models.find('openai', model);
      profiles.push({ id, runtime: 'codex', provider: 'openai', authRoute: 'subscription', model, thinking, contextWindow: typeof row?.contextWindow === 'number' ? row.contextWindow : undefined, modelDescription: saved?.description ?? (typeof row?.description === 'string' ? compact(row.description, 220) : undefined), thinkingDescription: typeof effort === 'object' && typeof effort?.description === 'string' ? compact(effort.description, 180) : undefined, label: thinking ? `Codex ${row?.displayName ?? model}, ${thinking}` : `Codex ${row?.displayName ?? model}`, source: 'local-metadata', verified: runtime?.eligible === true });
    }
  }
  const unique = profiles.filter((profile, index, list) => list.findIndex(other => other.id === profile.id) === index);
  return unique.length ? unique : [{ id: 'codex-default', runtime: 'codex', provider: 'openai', authRoute: 'subscription', label: 'Codex account default', source: 'codex-default', verified: runtime?.eligible === true }];
}

function piProfiles(runtime: any, models: ReturnType<typeof Models>): WorkerProfile[] {
  if (runtime?.eligible !== true || runtime?.authRoute !== 'subscription') return [];
  const metadata = Array.isArray(runtime?.models) ? runtime.models : [];
  const profiles: WorkerProfile[] = [];
  for (const row of metadata.slice(0, 24)) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || typeof row.contextWindow !== 'number' || !Number.isFinite(row.contextWindow) || row.contextWindow <= 0) continue;
    // The Pi registry identifies these models as openai-codex. The execution
    // policy groups that supported subscription route under the local OpenAI
    // provider, which is also how runtime capabilities persist it.
    const provider = typeof runtime?.provider === 'string' && runtime.provider.trim() ? runtime.provider.trim() : 'openai';
    const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : [];
    for (const effort of efforts.slice(0, 8)) {
      const thinking = typeof effort === 'string' ? effort : effort?.effort;
      if (typeof thinking !== 'string' || !thinking) continue;
      const saved = models.find(provider, row.id);
      profiles.push({
        id: `pi:${provider}:${row.id}:${thinking}`,
        runtime: 'pi', provider, authRoute: 'subscription', model: row.id, thinking, contextWindow: row.contextWindow,
        modelDescription: saved?.description ?? (typeof row.description === 'string' ? compact(row.description, 220) : undefined),
        thinkingDescription: typeof effort === 'object' && typeof effort?.description === 'string' ? compact(effort.description, 180) : undefined,
        label: `Pi ${row.displayName ?? row.id}, ${thinking}`,
        source: 'pi-sdk', verified: true,
      });
    }
  }
  return profiles.filter((profile, index, list) => list.findIndex(other => other.id === profile.id) === index);
}

function claudeProfiles(runtime: any, models: ReturnType<typeof Models>): WorkerProfile[] {
  if (runtime?.eligible !== true || runtime?.provider !== 'anthropic' || runtime?.authRoute !== 'subscription') return [];
  const profiles: WorkerProfile[] = [];
  for (const row of (Array.isArray(runtime.models) ? runtime.models : []).slice(0, 24)) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) continue;
    for (const effort of (Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : []).slice(0, 8)) {
      const thinking = typeof effort === 'string' ? effort : effort?.effort;
      if (typeof thinking !== 'string' || !thinking) continue;
      profiles.push({
        id: `claude:${row.id}:${thinking}`, runtime: 'claude', provider: 'anthropic', authRoute: 'subscription', model: row.id, thinking,
        contextWindow: typeof row.contextWindow === 'number' ? row.contextWindow : undefined,
        modelDescription: models.find('anthropic', row.id)?.description ?? (typeof row.description === 'string' ? compact(row.description, 220) : undefined),
        label: `Claude ${row.displayName ?? row.id}, ${thinking}`, source: 'claude-sdk', verified: true,
      });
    }
  }
  return profiles.filter((profile, index, list) => list.findIndex(other => other.id === profile.id) === index);
}

function profilePolicyInput(profile: WorkerProfile) {
  return { harness: profile.runtime, provider: profile.provider ?? runtimeProvider(profile.runtime), model: profile.model, authRoute: profile.authRoute ?? 'subscription' };
}

export function Recommendations(store: Store, execution: RuntimeSource, options: RecommendationOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 12_000, 30_000));
  const inFlight = new Map<string, Promise<any>>();
  const models = Models(store);

  async function optionsForWorker(projectId?: string) {
    if (projectId) store.require('project', projectId);
    const runtimes = await execution.call('runtime.capabilities', {}, { role: 'system', id: 'worker-recommendations' });
    const codex = runtimes.find((runtime: any) => runtime.name === 'codex');
    const pi = runtimes.find((runtime: any) => runtime.name === 'pi');
    const claude = runtimes.find((runtime: any) => runtime.name === CLAUDE_PROFILE_RUNTIME);
    models.sync(runtimes);
    const profiles = [...modelProfiles(codex, models), ...piProfiles(pi, models), ...claudeProfiles(claude, models)].filter(profile => {
      if (!projectId) return true;
      try { validateExecutionPolicy(store, projectId, profilePolicyInput(profile)); return true; }
      catch { return false; }
    });
    const workerPolicy = projectId ? models.getWorkerPolicy(projectId) : undefined;
    return {
      profiles,
      catalog: {
        runtime: 'codex', available: codex?.available === true, eligible: profiles.some(profile => profile.verified),
        installedVersion: codex?.installedVersion, modelMetadata: profiles.some(profile => profile.source === 'local-metadata'),
        reason: codex?.reason, revision: models.revision(runtimes, profiles.map(profile => `${profile.provider ?? runtimeProvider(profile.runtime)}:${profile.model}`)), workerPolicy,
        runtimes: {
          codex: { available: codex?.available === true, eligible: codex?.eligible === true, installedVersion: codex?.installedVersion, reason: codex?.reason },
          pi: { available: pi?.available === true, eligible: pi?.eligible === true, installedVersion: pi?.installedVersion, reason: pi?.reason, provider: pi?.provider, authRoute: pi?.authRoute, models: Array.isArray(pi?.models) ? pi.models.map((model: any) => ({ id: compact(model?.id, 160), provider: compact(model?.provider, 80), contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : null, thinking: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.map((effort: any) => typeof effort === 'string' ? effort : compact(effort?.effort, 80)).filter(Boolean) : [] })) : [] },
          claude: { available: claude?.available === true, eligible: claude?.eligible === true, installedVersion: claude?.installedVersion, reason: claude?.reason, provider: claude?.provider, authRoute: claude?.authRoute, modelSource: claude?.modelSource, authorized: Boolean(claude?.authorization) },
        },
      },
    };
  }

  async function validateProfile(profileInput: unknown, permissions?: string[], projectId?: string) {
    const requested = typeof profileInput === 'string' ? profileInput : (profileInput as any)?.id;
    const available = await optionsForWorker(projectId);
    const profile = available.profiles.find(item => item.id === requested);
    if (!profile || !profile.verified) throw new Error('Selected worker profile is not supported by the current local runtime');
    if (projectId) validateExecutionPolicy(store, projectId, profilePolicyInput(profile));
    return { ...profile, dispatchRuntime: dispatchRuntime(profile), permissions: strings(permissions, 30, 80) };
  }

  async function recommend(input: RecommendationInput) {
    const request = {
      projectId: compact(input.projectId, 120), subject: compact(input.subject, 280), scope: compact(input.scope, 1200),
      criteria: strings(input.criteria, 20, 180), requirements: strings(input.requirements, 50, 40),
      specHash: compact(input.specHash, 128) || undefined, permissions: strings(input.permissions, 30, 80), phase: compact(input.phase, 80) || undefined,
    };
    if (!request.projectId) throw new Error('projectId is required');
    store.require('project', request.projectId);
    const available = await optionsForWorker(request.projectId);
    const configuration = externalRecommendationConfiguration(env);
    const fingerprint = hash(canonicalJson({ request, profiles: available.profiles, catalog: available.catalog, configuration }));
    const cached = store.get<any>('worker_recommendation', fingerprint);
    if (cached && (!cached.result?.retryable || Date.now() - Date.parse(cached.createdAt) < 60_000)) return cached.result;
    const existing = inFlight.get(fingerprint);
    if (existing) return existing;
    const work = (async () => {
      let result: any;
      const eligible = available.profiles.filter(profile => profile.verified);
      const key = configuration.enabled ? environmentKey(env) : undefined;
      if (!key || eligible.length === 0 || eligible.length > MAX_JEV_PROFILES) {
        result = { profile: null, source: 'manual', reason: !configuration.optedIn ? 'External recommendations are disabled. Set WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS=1 to opt in.' : !key ? 'TypeSafe is not configured on this server' : eligible.length > MAX_JEV_PROFILES ? 'The current local catalog is too large for one bounded recommendation. Select a verified profile manually.' : 'No eligible local worker profile is available', catalog: available, fingerprint, retryable: !key };
      } else {
        const criteria: Record<string, any> = { manual: 'No listed profile fits. Ask the owner to choose manually.' };
        for (const profile of eligible) criteria[profile.id] = { selected_profile: profile.label, runtime: profile.runtime, model: { id: profile.model ?? 'account default', description: profile.modelDescription ?? 'Use the local account default.' }, thinking: { level: profile.thinking ?? 'account default', description: profile.thinkingDescription ?? 'Use the local account default.' } } as any;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const requestBody = {
            model: 'jev-latest', state: { objective: request.subject, scope: request.scope, criteria: request.criteria, requirements: request.requirements, permissions: request.permissions, specHash: request.specHash, phase: request.phase, selectionPolicy: 'Prefer the lowest-cost capable setup. Use deeper thinking only when ambiguity, technical risk, or verification complexity needs it. The worker plans first and then implements the approved scope.' },
            questions: { worker_profile: { type: 'choice', instructions: 'Select the best complete worker profile for this bounded approved work using `selectionPolicy`. Choose manual when the options do not fit or the evidence is insufficient. Do not infer availability beyond the supplied profiles.', criteria } },
          };
          if (Buffer.byteLength(JSON.stringify(requestBody), 'utf8') > MAX_JEV_REQUEST_BYTES) {
            result = { profile: null, source: 'manual', reason: 'The current local catalog details exceed the bounded recommendation request. Select a verified profile manually.', catalog: available, fingerprint };
          } else {
            const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
              method: 'POST', signal: controller.signal,
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
            });
            if (!response.ok) throw new Error(`TypeSafe service returned HTTP ${response.status}`);
            const providerBody: any = await response.json();
            const answer = providerBody?.answers?.worker_profile;
            const profile = eligible.find(item => item.id === answer?.choice);
            result = profile
              ? { profile, source: 'jev', confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined, reason: 'Jev selected a supported complete profile from the local catalog', catalog: available, fingerprint, usage: providerBody.usage, model: providerBody.model }
              : { profile: null, source: 'manual', confidence: typeof answer?.confidence === 'number' ? answer.confidence : undefined, reason: 'Jev returned no supported profile. Select manually.', catalog: available, fingerprint, usage: providerBody.usage, model: providerBody.model };
          }
        } catch (error) {
          result = { profile: null, source: 'manual', reason: `TypeSafe recommendation unavailable: ${failureCategory(error)}`, catalog: available, fingerprint, retryable: true };
        } finally { clearTimeout(timer); }
      }
      store.put('worker_recommendation', { id: fingerprint, fingerprint, request, catalog: available, result, createdAt: now() });
      store.event('worker.recommendation.recorded', request.projectId || null, { fingerprint, source: result.source, profileId: result.profile?.id ?? null }, `worker-recommendation:${fingerprint}`);
      return result;
    })().finally(() => inFlight.delete(fingerprint));
    inFlight.set(fingerprint, work);
    return work;
  }

  const actions = () => [
    { name: 'worker.options', description: 'List locally verified complete worker profiles for owner selection.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } } } },
    { name: 'worker.recommend', description: 'Recommend one locally supported worker profile for bounded approved work, or require manual selection.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'subject', 'scope', 'criteria'], properties: { projectId: { type: 'string' }, subject: { type: 'string' }, scope: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } }, requirements: { type: 'array', items: { type: 'string' } }, specHash: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } }, phase: { type: 'string' } } } },
    { name: 'worker.validate', description: 'Validate one owner-selected profile against the current local runtime before approval.', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['profile'], properties: { projectId: { type: 'string' }, profile: { oneOf: [{ type: 'string' }, { type: 'object' }] }, permissions: { type: 'array', items: { type: 'string' } } } } },
    { name: 'models.list', description: 'List worker model descriptions, revisions and discovery facts', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false } },
    { name: 'model.describe', description: 'Update one model description with provenance; guides must give requestedBy', roles: ['owner', 'guide'], inputSchema: { type: 'object', additionalProperties: false, required: ['model', 'description', 'source', 'expectedRev'], properties: { provider: { type: 'string' }, model: { type: 'string' }, description: { type: 'string' }, source: { type: 'string' }, expectedRev: { type: 'integer' }, requestedBy: { type: 'string' } } } },
    { name: 'project.workerPolicy.get', description: 'Read this project’s worker provider, route, harness, and model allowlists.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: { type: 'string' } } } },
    { name: 'project.workerPolicy.set', description: 'Set this project’s worker allowlists using an optimistic revision.', roles: ['owner'], inputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'policy', 'expectedRev'], properties: { projectId: { type: 'string' }, policy: { type: 'object' }, expectedRev: { type: 'integer' } } } },
  ];
  async function call(action: string, input: Record<string, any> = {}, actor: any) {
    const descriptor = actions().find(item => item.name === action);
    if (!descriptor) throw new Error(`Unknown worker action: ${action}`);
    if (!descriptor.roles.includes(actor?.role)) throw new Error(`Role ${actor?.role} cannot call ${action}`);
    if (action === 'worker.options') return optionsForWorker(input.projectId);
    if (action === 'worker.validate') return validateProfile(input.profile, input.permissions, input.projectId);
    if (action === 'models.list') { await optionsForWorker(); return models.list(); }
    if (action === 'model.describe') return models.describe(input, actor);
    if (action === 'project.workerPolicy.get') return models.getWorkerPolicy(String(input.projectId));
    if (action === 'project.workerPolicy.set') return models.setWorkerPolicy(String(input.projectId), input.policy, input.expectedRev, actor);
    return recommend(input as RecommendationInput);
  }
  return { options: optionsForWorker, validateProfile, recommend, dispatchRuntime, actions, call, models };
}
