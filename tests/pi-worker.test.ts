import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';

const owner = { role: 'owner' as const, id: 'pi-worker-owner' };
const system = { role: 'system' as const, id: 'pi-worker-system' };
const piProfile = { id: 'pi:openai:pi-fixture-model:low', runtime: 'pi', provider: 'openai', authRoute: 'subscription', model: 'pi-fixture-model', thinking: 'low', contextWindow: 200_000, label: 'Pi fixture', source: 'pi-sdk', verified: true };
const sdkWorker = resolve(import.meta.dirname, '..', 'scripts', 'sdk-worker.ts');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

function registerProject(domain: ReturnType<typeof Domain>, base: string, id: string, requirement: string) {
  const root = join(base, id);
  mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec', 'PRD.md'), requirement);
  writeFileSync(join(root, 'AGENTS.md'), `Instructions for ${id} only.\n`);
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const project: any = domain.call('project.register', { id, name: id, root, purpose: 'Pi worker fixture', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured: any = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted: any = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Fixture acceptance', source: 'test' }, owner).spec;
  return { root, project, accepted, candidate: git(root, 'rev-parse', 'HEAD') };
}

function fakePiSdk(base: string, record: string) {
  const fake = join(base, 'fake-pi-sdk.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';
export async function runPi(options) {
  const tool = name => options.customTools.find(item => item.name === name);
  const text = async (name, args) => JSON.parse((await tool(name).execute('fixture-call', args)).content[0].text);
  const context = await text('wimzo_context', {});
  const checkpoint = await text('wimzo_checkpoint', { summary: 'Pi fixture progress saved through the scoped tool.', next: 'Verify the fixture.', submissionId: 'pi-fixture-progress' });
  let policyCheck = 'missing';
  try { await options.policyCheck(); policyCheck = 'passed'; } catch (error) { policyCheck = String(error.message); }
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ prompt: options.prompt, model: options.model, thinking: options.thinking, write: options.write, sessionDir: options.sessionDir, cwd: options.cwd, tools: options.customTools.map(item => ({ name: item.name, label: item.label, description: item.description, parameters: item.parameters })), context, checkpoint, policyCheck }));
  return { summary: 'Pi fixture completed', sessionId: 'pi-fixture-session', usage: { input: 10, output: 2 }, context: { used: 12, capacity: 200000, estimated: false }, needsContinuation: false };
}
`);
  const hooks = join(base, 'fake-pi-hooks.mjs');
  writeFileSync(hooks, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../src/pi-sdk.ts' && context.parentURL?.endsWith('/scripts/sdk-worker.ts')) return { url: ${JSON.stringify(pathToFileURL(fake).href)}, shortCircuit: true };
  return next(specifier, context);
} });
`);
  return hooks;
}

test('an official Pi SDK worker receives its built task context and only the task-scoped Wimzo tools', () => {
  const base = mkdtempSync(join(tmpdir(), 'wimzo-pi-worker-'));
  const stateDir = join(base, 'state');
  let store = new Store(join(stateDir, 'state.sqlite'));
  const domain = Domain(store);
  const bound = registerProject(domain, base, 'pi_bound', '**H-061 Pi context.** The Pi worker reads the bound accepted requirement.\n');
  const other = registerProject(domain, base, 'pi_other', '**H-099 Unrelated secret requirement.** This text belongs to another project.\n');
  store.put('project_worker_policy', { id: bound.project.id, projectId: bound.project.id, policy: { harnesses: ['pi'], providers: ['openai'], authRoutes: ['subscription'], models: ['pi-fixture-model'] } });
  const create = (fixture: typeof bound, objective: string) => {
    const task: any = domain.call('task.create', { projectId: fixture.project.id, specId: fixture.accepted.id, specHash: fixture.accepted.hash, requirements: [fixture === bound ? 'H-061' : 'H-099'], objective, criteria: ['Fixture criterion'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 60_000, workerProfile: piProfile }, runtime: 'pi-profile', sourceCandidate: { id: fixture.candidate, specHash: fixture.accepted.hash }, deadline: new Date(Date.now() + 60_000).toISOString(), resources: [] }, owner);
    return domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve Pi fixture', source: 'test' }, owner).task;
  };
  const approved: any = create(bound, 'Read the bound Pi requirement');
  create(other, 'Unrelated task in another project');
  const claimed: any = domain.call('task.claim', { taskId: approved.id, expectedRev: approved.rev, workerId: 'execution:pi-fixture', runType: 'technical' }, system);
  const runId = claimed.task.runId;
  const run = store.require<any>('run', runId);
  store.put('run', { ...run, runtime: 'pi-profile', cwd: bound.root }, run.rev);
  store.close();

  const record = join(base, 'pi-record.json');
  const hooks = fakePiSdk(base, record);
  const folder = join(stateDir, 'runs', runId); mkdirSync(folder, { recursive: true });
  const configPath = join(folder, 'sdk-config.json');
  const sourceCandidate = { id: bound.candidate, specHash: bound.accepted.hash };
  writeFileSync(configPath, JSON.stringify({ stateDir, taskId: approved.id, runId, runtime: 'pi', cwd: bound.root, model: piProfile.model, thinking: piProfile.thinking, write: false, env: {}, sourceCandidate, sessionDir: join(folder, 'session'), resultFile: join(folder, 'sdk-result.json') }));
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(hooks).href, sdkWorker, configPath], { cwd: bound.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Pi fixture completed/);

  const observed = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(observed.tools.map((tool: any) => tool.name), ['wimzo_context', 'wimzo_specification', 'wimzo_checkpoint', 'wimzo_phase']);
  assert(observed.tools.every((tool: any) => tool.label === tool.name && typeof tool.description === 'string' && tool.parameters?.type === 'object'));
  assert(observed.tools.every((tool: any) => !/approve|accept|owner|publish|release|workflow/i.test(tool.name)));
  assert.deepEqual([observed.model, observed.thinking, observed.write, observed.sessionDir], [piProfile.model, piProfile.thinking, false, join(folder, 'session')]);
  assert.equal(observed.policyCheck, 'passed');

  const [instructions, packetText] = observed.prompt.split('\nTask context:\n');
  assert.match(instructions, /wimzo_context, wimzo_phase and wimzo_checkpoint/);
  const packet = JSON.parse(packetText);
  assert.equal(packet.project.id, bound.project.id);
  assert.equal(packet.task.id, approved.id);
  assert.equal(packet.task.objective, 'Read the bound Pi requirement');
  assert.equal(packet.specification.hash, bound.accepted.hash);
  assert.match(packet.specification.content, /H-061 Pi context/);
  assert(packet.instructions.some((entry: any) => /Instructions for pi_bound only/.test(entry.content)));
  assert.deepEqual(packet.policy.harnesses, ['pi']);
  assert(packet.omissions.includes('Unrelated projects'));
  assert.doesNotMatch(observed.prompt, /H-099|Unrelated secret requirement|Instructions for pi_other|Unrelated task in another project/);

  assert.equal(observed.context.task.id, approved.id);
  assert.equal(observed.context.project.id, bound.project.id);
  assert.deepEqual([observed.checkpoint.taskId, observed.checkpoint.runId], [approved.id, runId]);

  store = new Store(join(stateDir, 'state.sqlite'));
  try {
    const checkpoints = store.list<any>('worker_checkpoint').filter(item => item.taskId === approved.id);
    assert.deepEqual(checkpoints.map(item => item.summary).sort(), ['Pi fixture completed', 'Pi fixture progress saved through the scoped tool.']);
    assert(checkpoints.every(item => item.runId === runId && item.projectId === bound.project.id));
    const finished = store.require<any>('run', runId);
    assert.equal(finished.sdkSessionId, 'pi-fixture-session');
    assert.equal(finished.needsContinuation, false);
    assert.ok(existsSync(join(folder, 'sdk-result.json')));
  } finally { store.close(); }
});

test('a Pi SDK worker refuses to run once project policy no longer permits its route', () => {
  const base = mkdtempSync(join(tmpdir(), 'wimzo-pi-worker-denied-'));
  const stateDir = join(base, 'state');
  let store = new Store(join(stateDir, 'state.sqlite'));
  const domain = Domain(store);
  const bound = registerProject(domain, base, 'pi_denied', '**H-062 Pi policy.** Pi runs only when project policy allows it.\n');
  store.put('project_worker_policy', { id: bound.project.id, projectId: bound.project.id, policy: { harnesses: ['pi'], providers: ['openai'], authRoutes: ['subscription'], models: ['pi-fixture-model'] } });
  const task: any = domain.call('task.create', { projectId: bound.project.id, specId: bound.accepted.id, specHash: bound.accepted.hash, requirements: ['H-062'], objective: 'Denied Pi fixture', criteria: ['Fixture criterion'], scope: 'Fixture only', permissions: [], budget: { timeoutMs: 60_000, workerProfile: piProfile }, runtime: 'pi-profile', sourceCandidate: { id: bound.candidate, specHash: bound.accepted.hash }, deadline: new Date(Date.now() + 60_000).toISOString(), resources: [] }, owner);
  const approved: any = domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve Pi fixture', source: 'test' }, owner).task;
  const claimed: any = domain.call('task.claim', { taskId: approved.id, expectedRev: approved.rev, workerId: 'execution:pi-denied', runType: 'technical' }, system);
  const runId = claimed.task.runId;
  const policy = store.require<any>('project_worker_policy', bound.project.id);
  store.put('project_worker_policy', { ...policy, policy: { ...policy.policy, models: ['another-model'] } }, policy.rev);
  store.close();

  const record = join(base, 'pi-record.json');
  const hooks = fakePiSdk(base, record);
  const folder = join(stateDir, 'runs', runId); mkdirSync(folder, { recursive: true });
  const configPath = join(folder, 'sdk-config.json');
  writeFileSync(configPath, JSON.stringify({ stateDir, taskId: approved.id, runId, runtime: 'pi', cwd: bound.root, model: piProfile.model, thinking: piProfile.thinking, write: false, env: {}, sourceCandidate: { id: bound.candidate, specHash: bound.accepted.hash }, sessionDir: join(folder, 'session'), resultFile: join(folder, 'sdk-result.json') }));
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(hooks).href, sdkWorker, configPath], { cwd: bound.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Project worker policy denies model: pi-fixture-model/);
  store = new Store(join(stateDir, 'state.sqlite'));
  try {
    assert.match(store.require<any>('run', runId).error, /denies model/);
    assert.equal(store.list<any>('worker_checkpoint').filter(item => item.taskId === approved.id).length, 0);
  } finally { store.close(); }
});
