import { assert, type Store } from './store.ts';
import { validateExecutionPolicy } from './models.ts';
import { assertClaudeAuthorized } from './claude-profile.ts';

export type ProfileRuntime = 'codex' | 'pi' | 'claude';
export type ProfileSource = 'codex-default' | 'local-metadata' | 'pi-sdk' | 'claude-sdk';

export type WorkerProfile = {
  id: string;
  runtime: ProfileRuntime;
  provider?: string;
  authRoute?: 'subscription';
  model?: string;
  thinking?: string;
  contextWindow?: number;
  modelDescription?: string;
  thinkingDescription?: string;
  label: string;
  source: ProfileSource;
  verified: boolean;
};

export const CODEX_PROFILE_RUNTIME = 'codex-profile';
export const PI_PROFILE_RUNTIME = 'pi-profile';
export const CLAUDE_PROFILE_RUNTIME = 'claude-profile';
const PROFILE_RUNTIMES = { codex: CODEX_PROFILE_RUNTIME, pi: PI_PROFILE_RUNTIME, claude: CLAUDE_PROFILE_RUNTIME } as const;
export type DispatchRuntime = typeof PROFILE_RUNTIMES[ProfileRuntime];

function isBaseProfileRuntime(runtime: unknown): runtime is ProfileRuntime {
  return typeof runtime === 'string' && Object.hasOwn(PROFILE_RUNTIMES, runtime);
}

export function dispatchRuntime(profile: Pick<WorkerProfile, 'runtime'>): DispatchRuntime {
  assert(isBaseProfileRuntime(profile.runtime), 'No dispatch runtime exists for this profile');
  return PROFILE_RUNTIMES[profile.runtime];
}

export function isProfileRuntime(runtime: unknown): runtime is DispatchRuntime {
  return Object.values(PROFILE_RUNTIMES).includes(runtime as DispatchRuntime);
}

/** Maps a dispatch runtime such as `claude-profile` to its harness; other runtimes map to themselves. */
export function baseRuntime(runtime: string): string {
  return (Object.keys(PROFILE_RUNTIMES) as ProfileRuntime[]).find(key => PROFILE_RUNTIMES[key] === runtime) ?? runtime;
}

export function runtimeProvider(runtime: string): string {
  return baseRuntime(runtime) === 'claude' ? 'anthropic' : 'openai';
}

/** Re-checks project policy and, for Claude, the owner's subscription authorization for an active profile task. */
export function assertProfileRouteAuthorized(store: Store, task: any): void {
  const profile = task.budget?.workerProfile;
  if (!profile || typeof profile !== 'object' || !isBaseProfileRuntime(profile.runtime)) return;
  validateExecutionPolicy(store, task.projectId, { harness: profile.runtime, provider: typeof profile.provider === 'string' ? profile.provider : runtimeProvider(profile.runtime), model: typeof profile.model === 'string' ? profile.model : undefined, authRoute: typeof profile.authRoute === 'string' ? profile.authRoute : 'subscription' });
  if (profile.runtime === 'claude') assertClaudeAuthorized(store);
}

export function profileForTask(task: any): WorkerProfile {
  assert(isProfileRuntime(task.runtime), 'Task does not use a profile runtime');
  const profile = task.budget?.workerProfile;
  assert(profile && typeof profile === 'object' && !Array.isArray(profile), 'Profile runtime requires budget.workerProfile');
  assert(isBaseProfileRuntime(profile.runtime) && typeof profile.id === 'string' && profile.id.length > 0, 'Profile runtime has an invalid worker profile');
  assert(dispatchRuntime(profile) === task.runtime, 'Profile runtime does not match the selected worker profile');
  assert(typeof profile.label === 'string' && profile.label.length > 0, 'Profile runtime profile label is required');
  assert(profile.provider === undefined || typeof profile.provider === 'string', 'Profile runtime provider is invalid');
  assert(profile.authRoute === undefined || profile.authRoute === 'subscription', 'Profile runtime authentication route is invalid');
  assert(profile.model === undefined || typeof profile.model === 'string', 'Profile runtime model is invalid');
  assert(profile.thinking === undefined || typeof profile.thinking === 'string', 'Profile runtime thinking is invalid');
  assert(profile.contextWindow === undefined || typeof profile.contextWindow === 'number' && Number.isFinite(profile.contextWindow) && profile.contextWindow > 0, 'Profile runtime context window is invalid');
  assert(['codex-default', 'local-metadata', 'pi-sdk', 'claude-sdk'].includes(profile.source), 'Profile runtime source is invalid');
  assert(profile.runtime !== 'pi' || typeof profile.model === 'string' && typeof profile.provider === 'string' && profile.authRoute === 'subscription' && typeof profile.contextWindow === 'number', 'Pi profiles require an authenticated model and context window');
  assert(profile.runtime !== 'pi' || profile.source === 'pi-sdk', 'Pi profiles must come from Pi SDK metadata');
  assert(profile.runtime !== 'codex' || profile.source === 'codex-default' || profile.source === 'local-metadata', 'Codex profiles require Codex metadata');
  assert(profile.runtime !== 'claude' || profile.provider === 'anthropic' && profile.authRoute === 'subscription' && typeof profile.model === 'string' && profile.model.trim().length > 0, 'Claude profiles require the Anthropic subscription route and a model');
  assert(profile.runtime !== 'claude' || profile.source === 'claude-sdk', 'Claude profiles must come from Claude SDK metadata');
  assert(profile.verified === true, 'Profile runtime requires a verified profile');
  return {
    id: profile.id,
    runtime: profile.runtime,
    provider: profile.provider,
    authRoute: profile.authRoute,
    model: profile.model,
    thinking: profile.thinking,
    contextWindow: profile.contextWindow,
    modelDescription: profile.modelDescription,
    thinkingDescription: profile.thinkingDescription,
    label: profile.label,
    source: profile.source,
    verified: true,
  };
}
