import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, now, type RecordValue, type Store } from './store.ts';

export const CLAUDE_SUBSCRIPTION_ROUTE = 'claude.ai subscription';
export const CLAUDE_AUTHORIZATION_SCOPE = 'local Mac only';
const AUTHORIZATION_KIND = 'claude_subscription_authorization';
export const CLAUDE_DEFAULT_MAX_TURNS = 150;
export const CLAUDE_MAX_TURNS_LIMIT = 500;

/** Turn limit for one Claude run, taken from the task budget and bounded. */
export function claudeMaxTurns(value: unknown): number {
  if (value === undefined || value === null) return CLAUDE_DEFAULT_MAX_TURNS;
  assert(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= CLAUDE_MAX_TURNS_LIMIT, `Task budget maxTurns must be an integer from 1 to ${CLAUDE_MAX_TURNS_LIMIT}`);
  return value as number;
}
const AUTHORIZATION_ID = 'claude-subscription';

export type ClaudeAuthorization = RecordValue & {
  route: typeof CLAUDE_SUBSCRIPTION_ROUTE;
  scope: typeof CLAUDE_AUTHORIZATION_SCOPE;
  paidApi: false;
  status: 'approved' | 'revoked';
  actor: { role: 'owner'; id: string };
  source: string;
  at: string;
  revoked?: { actor: { role: 'owner'; id: string }; source: string; at: string };
};

type Owner = { role: string; id: string };

const EFFORTS = ['low', 'medium', 'high'].map(effort => ({ effort }));

/**
 * Local metadata for exact Claude model IDs. It is not discovered: listing the
 * account's models requires starting an authenticated Claude Code session.
 */
export function claudeModels() {
  const model = (id: string, displayName: string, description: string) => ({ id, displayName, description: `${description} Local metadata, not discovered.`, reasoningEfforts: EFFORTS, contextWindow: 200_000, source: 'local-metadata' });
  return [
    model('claude-opus-5-5', 'Opus 5.5', 'Use for difficult planning, architecture and judgment-heavy review where a confident wrong call is expensive; highest Claude cost and latency, so hand clear bounded implementation to a cheaper model.'),
    model('claude-sonnet-5', 'Sonnet 5', 'Use for routine implementation and focused review after a clear plan; balanced cost and latency. Escalate to Opus 5.5 for ambiguity or cross-cutting design.'),
    model('claude-haiku-4-5-20251001', 'Haiku 4.5', 'Use for fast, low-cost extraction, small edits and simple checks. Escalate to Sonnet 5 when the change spans several files or checks fail.'),
  ];
}

export function claudeSdkPackage(): { available: boolean; version?: string; reason?: string } {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const manifest = join(dirname(entry), 'package.json');
    const version = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined;
    return { available: existsSync(entry), version: typeof version === 'string' ? version : undefined };
  } catch { return { available: false, reason: 'Claude Agent SDK package is not installed' }; }
}

export function claudeAuthorization(store: Store): ClaudeAuthorization | undefined {
  const value = store.get<ClaudeAuthorization>(AUTHORIZATION_KIND, AUTHORIZATION_ID);
  return value?.status === 'approved' && value.paidApi === false && value.route === CLAUDE_SUBSCRIPTION_ROUTE && value.scope === CLAUDE_AUTHORIZATION_SCOPE && value.actor?.role === 'owner' ? value : undefined;
}

export function assertClaudeAuthorized(store: Store): ClaudeAuthorization {
  const value = claudeAuthorization(store);
  assert(value, 'Owner authorization for the Claude subscription route is missing or revoked');
  return value;
}

function ownerSource(actor: Owner, source: unknown): string {
  assert(actor?.role === 'owner', 'Only the owner can change Claude subscription authorization');
  const text = String(source ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000);
  assert(text, 'source must quote the owner decision');
  return text;
}

export function approveClaudeAuthorization(store: Store, actor: Owner, source: unknown): ClaudeAuthorization {
  const decision = ownerSource(actor, source);
  const previous = store.get<ClaudeAuthorization>(AUTHORIZATION_KIND, AUTHORIZATION_ID);
  const saved = store.put<ClaudeAuthorization>(AUTHORIZATION_KIND, { id: AUTHORIZATION_ID, route: CLAUDE_SUBSCRIPTION_ROUTE, scope: CLAUDE_AUTHORIZATION_SCOPE, paidApi: false, status: 'approved', actor: { role: 'owner', id: actor.id }, source: decision, at: now() }, previous?.rev ?? 0);
  store.event('worker.claude_auth.approved', null, { route: saved.route, scope: saved.scope, actor: saved.actor, source: saved.source, rev: saved.rev }, `claude-auth:${saved.rev}`);
  return saved;
}

export function revokeClaudeAuthorization(store: Store, actor: Owner, source: unknown): ClaudeAuthorization {
  const decision = ownerSource(actor, source);
  const previous = store.get<ClaudeAuthorization>(AUTHORIZATION_KIND, AUTHORIZATION_ID);
  assert(previous?.status === 'approved', 'Claude subscription route is not authorized');
  const saved = store.put<ClaudeAuthorization>(AUTHORIZATION_KIND, { ...previous, status: 'revoked', revoked: { actor: { role: 'owner', id: actor.id }, source: decision, at: now() } }, previous.rev);
  store.event('worker.claude_auth.revoked', null, { route: saved.route, actor: saved.revoked!.actor, source: decision, rev: saved.rev }, `claude-auth:${saved.rev}`);
  return saved;
}
