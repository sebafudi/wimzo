import test from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPiToolDefinitions, discoverPi, MAX_PI_PROMPT_BYTES, monitorPiAuthorization, nodeRuntimeReadPaths, piContextDecision, piPrompt, runPiBash } from '../src/pi-sdk.ts';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'wimzo-pi-sdk-'));
  const cwd = join(base, 'workspace');
  const outside = join(base, 'outside.txt');
  const sessionDir = join(base, 'state');
  const tempDir = join(tmpdir(), 'wimzo-pi-sdk-temp', String(Date.now()), String(Math.random()).slice(2));
  writeFileSync(outside, 'private outside content');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'inside.txt'), 'inside content');
  symlinkSync(outside, join(cwd, 'escape'));
  const tools = createPiToolDefinitions({ cwd, write: true, sessionDir, tempDir });
  return { cwd, outside, sessionDir, tempDir, tools };
}

async function execute(tool: any, input: any) {
  return tool.execute('test', input, undefined, () => {}, {});
}

test('Pi discovery uses the async runtime with offline catalogs and excludes credential values', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'wimzo-pi-discovery-'));
  const authPath = join(base, 'auth.json');
  const create = ModelRuntime.create.bind(ModelRuntime);
  let calls = 0;
  t.mock.method(ModelRuntime, 'create', async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    calls++;
    assert.equal(options?.allowModelNetwork, false);
    assert.equal(options?.authPath?.endsWith('/.pi/agent/auth.json'), true);
    return create({ ...options, authPath, modelsPath: join(base, 'models.json') });
  });
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('Unexpected outbound request'); });
  for (const [credential, expected] of [
    [undefined, 'none'],
    [{ type: 'api_key', key: 'fixture-api-key' }, 'none'],
    [{ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000, accountId: 'fixture-account' }, 'subscription'],
  ] as const) {
    writeFileSync(authPath, JSON.stringify(credential ? { 'openai-codex': credential } : {}));
    const result = await discoverPi();
    assert.equal(result.installed, true);
    assert.equal(result.authKind, expected);
    assert.ok(Array.isArray(result.availableModels));
    if (expected === 'subscription') {
      assert.ok(result.availableModels.length > 0);
      assert.ok(result.availableModels.every(model => model.provider === 'openai-codex'));
    }
    assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|fixture-api-key|access_token|refresh_token|api_key/i);
  }
  assert.equal(calls, 3);
  assert.equal(outbound, 0);
});

test('Pi Node runtime metadata does not grant an arbitrary executable parent directory', () => {
  const f = fixture();
  const executable = join(f.cwd, 'custom', 'bin', 'node');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, 'not a Node binary');
  assert.deepEqual(nodeRuntimeReadPaths(executable), [realpathSync(executable)]);
});

test('Pi file tools reject outside paths and symbolic-link escapes', async () => {
  const f = fixture();
  const read = f.tools.find((tool: any) => tool.name === 'read')!;
  const write = f.tools.find((tool: any) => tool.name === 'write')!;
  const ls = f.tools.find((tool: any) => tool.name === 'ls')!;
  await assert.rejects(() => execute(read, { path: f.outside }), /escapes|blocked/);
  await assert.rejects(() => execute(read, { path: 'escape' }), /escapes|blocked/);
  await assert.rejects(() => execute(ls, { path: 'escape' }), /escapes|blocked/);
  await assert.rejects(() => execute(write, { path: 'escape/new.txt', content: 'must not escape' }), /escapes|blocked/);
  assert.equal(existsSync(join(f.cwd, 'escape', 'new.txt')), false);
});

test('Pi grep searches contents inside the workspace, refuses escapes and caps output in read-only runs', async () => {
  const f = fixture();
  const tools = createPiToolDefinitions({ cwd: f.cwd, write: false, sessionDir: f.sessionDir, tempDir: f.tempDir });
  const grep = tools.find((tool: any) => tool.name === 'grep')!;
  assert.ok(grep);
  assert.equal(tools.some((tool: any) => tool.name === 'write'), false);
  const found = await execute(grep, { pattern: 'inside' });
  assert.match(found.content[0].text, /^inside\.txt:1: inside content$/m);
  assert.doesNotMatch(found.content[0].text, /private outside/);
  assert.equal((await execute(grep, { pattern: 'INSIDE', literal: true, ignoreCase: true, glob: '*.txt' })).content[0].text.split('\n').length, 1);
  assert.equal((await execute(grep, { pattern: 'nothing-here' })).content[0].text, 'No matches found');
  await assert.rejects(() => execute(grep, { pattern: 'private', path: f.outside }), /escapes|blocked/);
  await assert.rejects(() => execute(grep, { pattern: 'private', path: 'escape' }), /escapes|blocked/);
  writeFileSync(join(f.cwd, 'large.txt'), Array.from({ length: 1_500 }, (_, index) => `match ${index} ${'x'.repeat(60)}`).join('\n'));
  const limited = await execute(grep, { pattern: 'match', limit: 5 });
  assert.match(limited.content[0].text, /truncated at 5 matches/);
  const capped = await execute(grep, { pattern: 'match', limit: 1_000 });
  assert.ok(Buffer.byteLength(capped.content[0].text, 'utf8') <= 64 * 1024 + 200);
  assert.match(capped.content[0].text, /truncated at 64KB/);
});

test('Pi checks authorization before each contained tool and shares the reserve-aware context decision', async () => {
  const f = fixture();
  let checks = 0;
  const tools = createPiToolDefinitions({ cwd: f.cwd, write: false, sessionDir: f.sessionDir, tempDir: f.tempDir, policyCheck: () => { checks++; } });
  const read = tools.find((tool: any) => tool.name === 'read')!;
  await execute(read, { path: 'inside.txt' });
  assert.ok(checks >= 1);
  const decision = piContextDecision(70_000, 128_000, { targetTokens: 150_000, checkpointTokens: 120_000, reserveTokens: 30_000, exceptionMaxTokens: 180_000 });
  assert.equal(decision.action, 'checkpoint');
  assert.equal(decision.limit, 98_000);
});

test('Pi revokes an in-flight session when policy changes between tool calls', async () => {
  let aborts = 0;
  const monitor = monitorPiAuthorization(() => { throw new Error('Project worker policy was revoked'); }, () => { aborts++; }, 60_000);
  try {
    await monitor.observe();
    await assert.rejects(() => monitor.checkNow(), /policy was revoked/);
    assert.equal(aborts, 1);
  } finally { monitor.close(); }
});

test('Pi preserves bounded prompt context exactly and refuses oversized file reads for a durable handoff', async () => {
  const prompt = `${'x'.repeat(24_001)}\nExact scoped tail.`;
  assert.equal(piPrompt(prompt), prompt);
  assert.throws(() => piPrompt('x'.repeat(MAX_PI_PROMPT_BYTES + 1)), /durable handoff/);
  const f = fixture();
  writeFileSync(join(f.cwd, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
  const read = f.tools.find((tool: any) => tool.name === 'read')!;
  await assert.rejects(() => execute(read, { path: 'large.txt' }), /too large/);
});

test('Pi bash sandbox limits read-only verification and writers to declared paths', async () => {
  const f = fixture();
  const siblingProject = join(dirname(f.cwd), 'sibling-project');
  mkdirSync(siblingProject);
  writeFileSync(join(siblingProject, 'private.txt'), 'not worker context');
  const readonlyWrite = await runPiBash(`printf blocked > ${JSON.stringify(join(f.cwd, 'readonly.txt'))}`, { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: false });
  assert.notEqual(readonlyWrite.exitCode, 0);
  assert.equal(existsSync(join(f.cwd, 'readonly.txt')), false);
  const siblingRead = await runPiBash(`cat ${JSON.stringify(join(siblingProject, 'private.txt'))}`, { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: false });
  assert.notEqual(siblingRead.exitCode, 0);
  const sourceRead = await runPiBash('cat inside.txt', { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: false });
  assert.equal(sourceRead.exitCode, 0);
  let runtimeOutput = '';
  const runtimePaths = nodeRuntimeReadPaths();
  assert.ok(runtimePaths.every(path => path.startsWith('/')));
  const runtimeNode = await runPiBash('node --version', { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: false, permissionPaths: { runtimeReadPaths: runtimePaths }, onData: data => { runtimeOutput += data.toString('utf8'); } });
  assert.equal(runtimeNode.exitCode, 0, runtimeOutput);
  assert.match(runtimeOutput, /^v\d+/m);
  const writeAttempt = await runPiBash(`printf blocked > ${JSON.stringify(f.outside)}`, { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: true });
  assert.notEqual(writeAttempt.exitCode, 0);
  assert.equal(readFileSync(f.outside, 'utf8'), 'private outside content');
  const writeInside = await runPiBash('printf permitted > writer.txt', { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: true });
  assert.equal(writeInside.exitCode, 0);
  assert.equal(readFileSync(join(f.cwd, 'writer.txt'), 'utf8'), 'permitted');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runPiBash('while true; do :; done', { cwd: f.cwd, sessionDir: f.sessionDir, tempDir: f.tempDir, write: false, signal: controller.signal }), /canceled/);
});
