import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { contextDecision, DEFAULT_CONTEXT_POLICY } from './worker-context.ts';
import { assert } from './store.ts';

const PI_AGENT_DIR = join(homedir(), '.pi', 'agent');
const SYSTEM_PATH = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const KNOWN_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PI_FILE_READ_BYTES = 128 * 1024;
const MAX_PI_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_PI_PROMPT_BYTES = 240 * 1024;

/**
 * The Node executable may load Homebrew dylibs outside its own Cellar bundle.
 * Return only the installed Node bundle and exact absolute dylibs declared by
 * its Mach-O metadata, never the Homebrew prefix.
 */
export function nodeRuntimeReadPaths(executable = process.execPath): string[] {
  const target = realpathSync(executable);
  const bundleRoot = dirname(dirname(target));
  const recognizedBundle = /[\\/]\.nvm[\\/]versions[\\/]node[\\/]v[^\\/]+$/.test(bundleRoot)
    || /[\\/]Cellar[\\/]node(?:@[^\\/]+)?[\\/][^\\/]+$/.test(bundleRoot);
  const paths = new Set<string>([target, ...(recognizedBundle ? [bundleRoot] : [])]);
  const result = spawnSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [...paths];
  for (const line of result.stdout.split('\n').slice(1)) {
    const value = line.trim().split(' (', 1)[0];
    if (!value || !isAbsolute(value)) continue;
    paths.add(value);
    try { paths.add(realpathSync(value)); } catch {}
  }
  return [...paths];
}

export type PiModel = {
  id: string;
  provider: string;
  contextWindow: number;
  thinkingSupport: string[];
};

export type PiDiscovery = {
  installed: boolean;
  version?: string;
  authKind: 'subscription' | 'other' | 'none' | 'unavailable';
  availableModels: PiModel[];
  reason?: string;
};

export type PiContextPolicy = {
  targetTokens?: number;
  checkpointTokens?: number;
  reserveTokens?: number;
  exceptionMaxTokens?: number;
  exceptionReason?: string;
};

export type PiPermissionPaths = {
  gitCommonDir?: string;
  gitWorktreeDir?: string;
  runtimeReadPaths?: string[];
};

export type PiRunOptions = {
  cwd: string;
  model: string;
  thinking?: string;
  write: boolean;
  prompt: string;
  sessionDir: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
  customTools?: ToolDefinition<any, any, any>[];
  contextPolicy?: PiContextPolicy;
  permissionPaths?: PiPermissionPaths;
  policyCheck?: () => void | Promise<void>;
};

type PiModelInternal = PiModel & { raw: any };
type PiToolDefinition = ToolDefinition<any, any, any>;

function compact(value: unknown, limit: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path));
}

function deniedPaths(cwd: string, sessionDir?: string): string[] {
  return [
    join(homedir(), '.pi'),
    join(homedir(), '.codex'),
    join(cwd, '.wimzo'),
    sessionDir,
    process.env.WIMZO_STATE_DIR,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).map(value => resolve(value));
}

function assertNotSensitive(path: string, cwd: string, sessionDir?: string): void {
  const candidate = resolve(path);
  for (const denied of deniedPaths(cwd, sessionDir)) {
    if (inside(denied, candidate)) throw new Error('Pi tool access to credentials or worker state is blocked');
  }
}

async function existingInside(path: string, cwd: string, sessionDir?: string): Promise<string> {
  const root = await realpath(cwd);
  const resolved = resolve(path);
  assertNotSensitive(resolved, root, sessionDir);
  const target = await realpath(resolved);
  if (!inside(root, target)) throw new Error('Pi tool path escapes the isolated working directory');
  assertNotSensitive(target, root, sessionDir);
  return target;
}

async function writableInside(path: string, cwd: string, sessionDir?: string): Promise<string> {
  const root = await realpath(cwd);
  const target = resolve(path);
  if (!inside(root, target)) throw new Error('Pi tool path escapes the isolated working directory');
  assertNotSensitive(target, root, sessionDir);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Pi tool path has no existing parent');
    existing = parent;
  }
  const realParent = await realpath(existing);
  if (!inside(root, realParent)) throw new Error('Pi tool path escapes through a symbolic link');
  assertNotSensitive(realParent, root, sessionDir);
  if (existsSync(target)) {
    const realTarget = await realpath(target);
    if (!inside(root, realTarget)) throw new Error('Pi tool path escapes through a symbolic link');
    assertNotSensitive(realTarget, root, sessionDir);
  }
  return target;
}

function sandboxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sandboxReadPaths(cwd: string, permissionPaths: PiPermissionPaths | undefined): string[] {
  const configured = [permissionPaths?.gitCommonDir, permissionPaths?.gitWorktreeDir, ...(permissionPaths?.runtimeReadPaths ?? [])];
  const paths = [cwd, '/bin', '/usr/bin', '/usr/lib', '/System', '/Library/Apple', ...configured]
    .filter((value): value is string => typeof value === 'string' && isAbsolute(value))
    .map(value => resolve(value));
  return [...new Set(paths)];
}

function sandboxProfile(cwd: string, temp: string, write: boolean, sessionDir?: string, permissionPaths?: PiPermissionPaths): string {
  const reads = sandboxReadPaths(cwd, permissionPaths).map(path => `(allow file-read* (subpath "${sandboxString(path)}"))`).join('\n');
  const broadReadDenies = [homedir(), tmpdir()].map(path => `(deny file-read* (subpath "${sandboxString(resolve(path))}"))`).join('\n');
  const writes = [`(allow file-write* (subpath "${sandboxString(temp)}"))`, ...(write ? [`(allow file-write* (subpath "${sandboxString(cwd)}"))`] : [])].join('\n');
  const denies = deniedPaths(cwd, sessionDir).map(path => `(deny file-read* (subpath "${sandboxString(path)}"))\n(deny file-write* (subpath "${sandboxString(path)}"))`).join('\n');
  return `(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow file-read-metadata)
${broadReadDenies}
${reads}
(deny file-write*)
${writes}
${denies}
(deny network*)`;
}

export async function runPiBash(command: string, options: { cwd: string; tempDir: string; write: boolean; sessionDir?: string; permissionPaths?: PiPermissionPaths; signal?: AbortSignal; onData?: (data: Buffer) => void; timeout?: number }): Promise<{ exitCode: number | null }> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('Pi shell execution is blocked because the macOS sandbox is unavailable');
  const cwd = await realpath(options.cwd);
  await mkdir(options.tempDir, { recursive: true, mode: 0o700 });
  const tempDir = await realpath(options.tempDir);
  const temporaryRoot = await realpath(tmpdir());
  if (!inside(temporaryRoot, tempDir)) throw new Error('Pi shell temp directory is outside the system temporary directory');
  const profile = sandboxProfile(cwd, tempDir, options.write, options.sessionDir, options.permissionPaths);
  if (options.signal?.aborted) throw new Error('Pi shell execution was canceled');
  return await new Promise((resolveResult, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/zsh', '-fc', command], {
      cwd,
      env: { PATH: SYSTEM_PATH, HOME: cwd, TMPDIR: tempDir, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timeout: NodeJS.Timeout | undefined;
    const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
    const cancel = () => { stop(); reject(new Error('Pi shell execution was canceled')); };
    let outputBytes = 0;
    let outputTruncated = false;
    const forward = (data: Buffer) => {
      if (!options.onData || outputTruncated) return;
      const remaining = MAX_PI_TOOL_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) { outputTruncated = true; options.onData(Buffer.from('\n[Pi shell output truncated; inspect a bounded file segment if needed.]\n')); return; }
      const chunk = data.subarray(0, remaining);
      outputBytes += chunk.byteLength;
      options.onData(chunk);
      if (chunk.byteLength < data.byteLength) { outputTruncated = true; options.onData(Buffer.from('\n[Pi shell output truncated; inspect a bounded file segment if needed.]\n')); }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.once('error', error => reject(new Error(`Pi shell sandbox failed: ${compact(error.message, 160)}`)));
    child.once('close', code => resolveResult({ exitCode: code }));
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.timeout && options.timeout > 0) timeout = setTimeout(cancel, options.timeout);
    child.once('close', () => { if (timeout) clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel); });
  });
}

function globMatch(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') { expression += '.*'; index++; }
    else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '.';
    else expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(path);
}

async function safeGlob(pattern: string, root: string, cwd: string, sessionDir: string | undefined, limit: number): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (result.length >= limit) return;
    const realDirectory = await existingInside(directory, cwd, sessionDir);
    for (const entry of await readdir(realDirectory, { withFileTypes: true })) {
      if (result.length >= limit || entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = join(realDirectory, entry.name);
      const info = await lstat(next);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(next);
      else if (info.isFile()) {
        const relativePath = relative(root, next).replace(/\\/g, '/');
        if (globMatch(pattern, relativePath)) result.push(next);
      }
    }
  };
  await walk(root);
  return result;
}

async function searchableFiles(root: string, cwd: string, sessionDir: string | undefined, limit: number): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (result.length >= limit) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = join(directory, entry.name);
      try { assertNotSensitive(next, cwd, sessionDir); } catch { continue; }
      const info = await lstat(next);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(next);
      else if (info.isFile()) result.push(next);
    }
  };
  await walk(root);
  return result;
}

async function containedGrep(params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }, cwd: string, sessionDir: string | undefined, signal?: AbortSignal) {
  assert(typeof params.pattern === 'string' && params.pattern.length > 0 && params.pattern.length <= 1000, 'Pi grep pattern is required and bounded');
  let expression: RegExp;
  try { expression = new RegExp(params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : params.pattern, params.ignoreCase ? 'i' : ''); }
  catch { throw new Error('Pi grep pattern is not a valid regular expression'); }
  const target = await existingInside(resolve(cwd, params.path ?? '.'), cwd, sessionDir);
  const files = (await stat(target)).isFile() ? [target] : await searchableFiles(target, cwd, sessionDir, 5_000);
  const glob = typeof params.glob === 'string' && params.glob ? params.glob : undefined;
  const limit = Math.max(1, Math.min(Number.isInteger(params.limit) ? Number(params.limit) : 100, 1_000));
  const context = Math.max(0, Math.min(Number.isInteger(params.context) ? Number(params.context) : 0, 5));
  const lines: string[] = [];
  let matches = 0, bytes = 0, truncated = false;
  for (const file of files) {
    if (signal?.aborted) throw new Error('Pi grep was canceled');
    const path = relative(cwd, file).replace(/\\/g, '/');
    if (glob && !globMatch(glob, path) && !(glob.includes('/') ? false : globMatch(glob, basename(path)))) continue;
    if ((await stat(file)).size > MAX_PI_FILE_READ_BYTES) continue;
    const content = await readFile(file);
    if (content.includes(0)) continue;
    const text = content.toString('utf8').split('\n');
    for (let index = 0; index < text.length && !truncated; index++) {
      if (!expression.test(text[index])) continue;
      matches++;
      for (let line = Math.max(0, index - context); line <= Math.min(text.length - 1, index + context); line++) {
        const entry = `${path}:${line + 1}${line === index ? ':' : '-'} ${text[line].slice(0, 500)}`;
        bytes += Buffer.byteLength(entry, 'utf8') + 1;
        if (bytes > MAX_PI_TOOL_OUTPUT_BYTES) { truncated = true; break; }
        lines.push(entry);
      }
      if (matches >= limit) truncated = true;
    }
    if (truncated) break;
  }
  const notice = truncated ? `\n[Pi grep output truncated at ${matches >= limit ? `${limit} matches` : `${MAX_PI_TOOL_OUTPUT_BYTES / 1024}KB`}; narrow the pattern, path or glob.]` : '';
  return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') + notice : 'No matches found' }], details: truncated ? { matchLimitReached: matches >= limit ? limit : undefined, linesTruncated: true } : undefined };
}

export function createPiToolDefinitions(input: { cwd: string; write: boolean; sessionDir?: string; tempDir: string; permissionPaths?: PiPermissionPaths; customTools?: PiToolDefinition[]; policyCheck?: () => void | Promise<void> }): PiToolDefinition[] {
  const cwd = realpathSync(input.cwd);
  const check = async () => { await input.policyCheck?.(); };
  const readOperations = {
    readFile: async (path: string) => { await check(); const content = await readFile(await existingInside(path, cwd, input.sessionDir)); if (content.byteLength > MAX_PI_FILE_READ_BYTES) throw new Error('Pi file read is too large; use a bounded range or targeted search'); return content; },
    access: async (path: string) => { await check(); return access(await existingInside(path, cwd, input.sessionDir)); },
  };
  const writeOperations = {
    mkdir: async (path: string) => { await check(); await mkdir(await writableInside(path, cwd, input.sessionDir), { recursive: true }); },
    writeFile: async (path: string, content: string) => { await check(); await writeFile(await writableInside(path, cwd, input.sessionDir), content, 'utf8'); },
  };
  const tools: PiToolDefinition[] = [
    createReadToolDefinition(cwd, { operations: readOperations }),
    createFindToolDefinition(cwd, { operations: {
      exists: async (path: string) => { await check(); await existingInside(path, cwd, input.sessionDir); return true; },
      glob: async (pattern: string, root: string, options: { limit: number }) => { await check(); return safeGlob(pattern, await existingInside(root, cwd, input.sessionDir), cwd, input.sessionDir, options.limit); },
    } }),
    { name: 'grep', label: 'grep', parameters: createGrepToolDefinition(cwd).parameters, description: `Search file contents inside the isolated working directory for a regular expression or literal. Returns path:line matches. Skips credentials, worker state, symbolic links, binary files and files over ${MAX_PI_FILE_READ_BYTES / 1024}KB. Output is capped at ${MAX_PI_TOOL_OUTPUT_BYTES / 1024}KB.`, promptSnippet: 'Search file contents inside the working directory', execute: async (_id: string, params: any, signal?: AbortSignal) => { await check(); return containedGrep(params, cwd, input.sessionDir, signal); } },
    createLsToolDefinition(cwd, { operations: {
      exists: async (path: string) => { await check(); await existingInside(path, cwd, input.sessionDir); return true; },
      stat: async (path: string) => { await check(); return stat(await existingInside(path, cwd, input.sessionDir)); },
      readdir: async (path: string) => { await check(); return readdir(await existingInside(path, cwd, input.sessionDir)); },
    } }),
    createBashToolDefinition(cwd, { operations: {
      exec: async (command, _unused, options) => { await check(); return runPiBash(command, { cwd, sessionDir: input.sessionDir, tempDir: input.tempDir, write: input.write, permissionPaths: input.permissionPaths, signal: options.signal, timeout: options.timeout, onData: options.onData }); },
    } }),
  ];
  if (input.write) {
    tools.push(
      createEditToolDefinition(cwd, { operations: { ...readOperations, writeFile: writeOperations.writeFile } }),
      createWriteToolDefinition(cwd, { operations: writeOperations }),
    );
  }
  const names = new Set(tools.map(tool => tool.name));
  for (const tool of input.customTools ?? []) {
    if (!tool || typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('Custom Pi tools must have unique names and cannot replace contained tools');
    names.add(tool.name);
    tools.push({ ...tool, execute: async (...args: any[]) => { await check(); return (tool.execute as any)(...args); } });
  }
  return tools;
}

async function registry(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(PI_AGENT_DIR, 'auth.json'),
    modelsPath: join(PI_AGENT_DIR, 'models.json'),
    allowModelNetwork: false,
  });
}

function thinkingSupport(model: any): string[] {
  if (!model.reasoning) return ['off'];
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== 'object') return ['off'];
  return KNOWN_THINKING.filter(level => level === 'off' || map[level] !== null && map[level] !== undefined);
}

function available(models: ModelRuntime): PiModelInternal[] {
  return models.getAvailableSnapshot()
    .filter((model: any) => model.provider === 'openai-codex')
    .map((model: any) => ({ id: model.id, provider: model.provider, contextWindow: Number(model.contextWindow) || 0, thinkingSupport: thinkingSupport(model), raw: model }));
}

export async function discoverPi(): Promise<PiDiscovery> {
  try {
    const models = await registry();
    const configured = models.hasConfiguredAuth('openai-codex');
    const availableModels = available(models).map(({ raw: _raw, ...model }) => model);
    return {
      installed: true,
      version: VERSION,
      authKind: !configured ? 'none' : models.isUsingSubscription('openai-codex') ? 'subscription' : 'other',
      availableModels,
      reason: !configured ? 'OpenAI Codex subscription OAuth is not configured in Pi' : availableModels.length ? undefined : 'Pi has no authenticated OpenAI Codex models',
    };
  } catch {
    return { installed: false, authKind: 'unavailable', availableModels: [], reason: 'Pi SDK metadata could not be read safely' };
  }
}

function contextPolicy(input: PiContextPolicy | undefined): PiContextPolicy {
  const { exceptionReason, ...thresholds } = input ?? {};
  const policy = { ...DEFAULT_CONTEXT_POLICY, ...thresholds };
  for (const value of Object.values(policy)) if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Pi context policy is invalid');
  if (policy.checkpointTokens >= policy.targetTokens || policy.targetTokens > policy.exceptionMaxTokens) throw new Error('Pi context policy has invalid threshold order');
  return exceptionReason?.trim() ? { ...policy, exceptionReason: exceptionReason.trim() } : policy;
}

export function piContextDecision(used: number | null, contextWindow: number, policy: PiContextPolicy | undefined) {
  return contextDecision(used, contextWindow, contextPolicy(policy));
}

export function piPrompt(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0, 'Pi prompt is required');
  assert(Buffer.byteLength(value, 'utf8') <= MAX_PI_PROMPT_BYTES, 'Pi prompt is too large; save a durable handoff and start a fresh bounded run');
  return value;
}

export function monitorPiAuthorization(policyCheck: PiRunOptions['policyCheck'], abort: () => void, intervalMs = 1_000) {
  let failure: unknown;
  let pending: Promise<void> | undefined;
  const check = () => {
    if (!policyCheck || failure || pending) return pending ?? Promise.resolve();
    pending = Promise.resolve().then(() => policyCheck()).catch(error => {
      failure = error;
      abort();
    }).finally(() => { pending = undefined; });
    return pending;
  };
  const timer = policyCheck ? setInterval(() => { void check(); }, intervalMs) : undefined;
  timer?.unref();
  return {
    observe: check,
    async checkNow() { await check(); if (failure) throw failure; },
    failure: () => failure,
    close: () => { if (timer) clearInterval(timer); },
  };
}

export async function runPi(options: PiRunOptions): Promise<{ summary: string; sessionId: string; usage: Record<string, unknown>; context: Record<string, unknown>; needsContinuation: boolean }> {
  const cwd = await realpath(options.cwd);
  const sessionDir = resolve(options.sessionDir);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const tempDir = join(tmpdir(), 'wimzo-pi', `${basename(sessionDir)}-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const probe = await runPiBash(':', { cwd, sessionDir, tempDir, write: options.write, permissionPaths: options.permissionPaths });
  if (probe.exitCode !== 0) throw new Error(`Pi ${options.write ? 'write' : 'read-only'} run is blocked because the macOS shell sandbox did not start`);
  const models = await registry();
  const selected = available(models).find(model => model.id === options.model);
  if (!selected || !models.isUsingSubscription('openai-codex')) throw new Error('Pi run is blocked because the selected OpenAI Codex subscription model is unavailable');
  const policy = contextPolicy(options.contextPolicy);
  if (options.thinking && !selected.thinkingSupport.includes(options.thinking)) throw new Error('Pi run is blocked because the requested thinking level is unsupported by the selected model');
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } } as any);
  const loader = new DefaultResourceLoader({ cwd, agentDir: PI_AGENT_DIR, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const tools = createPiToolDefinitions({ cwd, write: options.write, sessionDir, tempDir, permissionPaths: options.permissionPaths, customTools: options.customTools, policyCheck: options.policyCheck });
  const { session } = await createAgentSession({ cwd, agentDir: PI_AGENT_DIR, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager, model: selected.raw, thinkingLevel: options.thinking as any, noTools: 'all', tools: tools.map(tool => tool.name), customTools: tools });
  let needsContinuation = false;
  const emit = (type: string, extra: Record<string, unknown> = {}) => options.onEvent?.({ type, sessionId: session.sessionId, model: selected.id, ...extra });
  const authorization = monitorPiAuthorization(options.policyCheck, () => { void session.abort(); });
  const observe = () => {
    const usage = session.getContextUsage();
    emit('pi.context', { context: usage ?? null, policy });
    const decision = piContextDecision(typeof usage?.tokens === 'number' ? usage.tokens : null, selected.contextWindow, policy);
    if ((decision.action === 'checkpoint' || decision.action === 'stop') && !needsContinuation) {
      needsContinuation = true;
      emit('pi.handoff.required', { context: usage, policy, decision });
      void session.abort();
    }
  };
  const unsubscribe = session.subscribe(event => { void authorization.observe(); emit('pi.event', { event: event.type }); observe(); });
  const cancel = () => { emit('pi.canceled'); void session.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('Pi run was canceled before prompt submission');
    await authorization.checkNow();
    emit('pi.started', { tools: session.getActiveToolNames(), policy });
    try {
      await session.prompt(piPrompt(options.prompt), { expandPromptTemplates: false, source: 'rpc' });
      await session.waitForIdle();
    } catch (error) {
      if (authorization.failure()) throw authorization.failure();
      if (!needsContinuation) throw error;
    }
    await authorization.checkNow();
    observe();
    const context = session.getContextUsage() ?? { tokens: null, contextWindow: selected.contextWindow, percent: null };
    const stats = session.getSessionStats();
    return { summary: session.getLastAssistantText() ?? (needsContinuation ? 'Pi run paused at the durable context checkpoint.' : ''), sessionId: session.sessionId, usage: stats.tokens as unknown as Record<string, unknown>, context: { ...context, checkpointed: needsContinuation, policy }, needsContinuation };
  } finally {
    unsubscribe();
    authorization.close();
    options.signal?.removeEventListener('abort', cancel);
    session.dispose();
  }
}
