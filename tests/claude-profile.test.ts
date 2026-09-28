import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { App } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';
import { CLAUDE_PROFILE_RUNTIME, baseRuntime, dispatchRuntime, isProfileRuntime, profileForTask } from '../src/worker-profile.ts';
import { CLAUDE_DEFAULT_MAX_TURNS, CLAUDE_MAX_TURNS_LIMIT, approveClaudeAuthorization, assertClaudeAuthorized, claudeAuthorization, claudeMaxTurns, revokeClaudeAuthorization } from '../src/claude-profile.ts';
import { CLAUDE_OUTCOME_SCHEMA, claudeEnvironment, claudeFailureMessage, claudeOptions, claudeTemporaryDirectory, claudeToolGuard, runClaude, type SdkOptions } from '../src/sdk-workers.ts';

const owner = { role: 'owner' as const, id: 'claude-owner' };
const claudeProfile = { id: 'claude:claude-sonnet-5:low', runtime: 'claude', provider: 'anthropic', authRoute: 'subscription', model: 'claude-sonnet-5', thinking: 'low', contextWindow: 200000, label: 'Claude Sonnet 5, low', source: 'claude-sdk', verified: true };
const noPi = async () => ({ installed: false, authKind: 'none', availableModels: [], reason: 'Pi fixture disabled' } as any);

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}

function fakeClaudeLogin(root: string) {
  const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  const mode = join(root, 'claude-login-mode');
  writeFileSync(mode, 'subscription');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const mode=require('node:fs').readFileSync(${JSON.stringify(mode)},'utf8').trim();
if(process.argv.includes('--version')){console.log('9.9.9 (Claude Code fixture)');process.exit(0);}
if(mode==='logged-out'){console.log(JSON.stringify({loggedIn:false}));process.exit(1);}
console.log(JSON.stringify({loggedIn:true,authMethod:mode==='api-key'?'api_key':'claude.ai',subscriptionType:mode==='api-key'?undefined:'max'}));
`); chmodSync(join(bin, 'claude'), 0o755);
  return { bin, setMode: (value: string) => writeFileSync(mode, value) };
}

async function withPath<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try { return await work(); } finally { process.env.PATH = previous; }
}

function projectFixture(root: string, domain: ReturnType<typeof Domain>, id: string) {
  const projectRoot = join(root, id); mkdirSync(join(projectRoot, 'spec'), { recursive: true });
  writeFileSync(join(projectRoot, '.gitignore'), '.state/\n');
  writeFileSync(join(projectRoot, 'spec', 'PRD.md'), '**H-050 Claude worker.** The answer file contains four.\n');
  writeFileSync(join(projectRoot, 'answer.txt'), 'TODO\n');
  git(projectRoot, 'init', '-q'); git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-qm', 'fixture');
  const candidate = git(projectRoot, 'rev-parse', 'HEAD');
  const project: any = domain.call('project.register', { id, name: `Claude ${id}`, root: projectRoot, purpose: 'Claude profile fixture', canonicalPaths: ['spec/PRD.md'] }, owner);
  const captured: any = domain.call('spec.capture', { projectId: project.id, path: 'spec/PRD.md' }, owner);
  const accepted: any = domain.call('spec.accept', { specId: captured.id, hash: captured.hash, expectedRev: captured.rev, decision: 'Fixture acceptance', source: 'test' }, owner).spec;
  return { project, accepted, candidate, projectRoot };
}

function approvedClaudeTask(domain: ReturnType<typeof Domain>, fixture: ReturnType<typeof projectFixture>, permissions: string[] = []) {
  const task: any = domain.call('task.create', { projectId: fixture.project.id, specId: fixture.accepted.id, specHash: fixture.accepted.hash, requirements: ['H-050'], objective: 'Write four into answer.txt', criteria: ['answer.txt contains 4'], scope: 'answer.txt only', permissions, budget: { timeoutMs: 20_000, workerProfile: claudeProfile }, runtime: CLAUDE_PROFILE_RUNTIME, sourceCandidate: { id: fixture.candidate, specHash: fixture.accepted.hash }, deadline: new Date(Date.now() + 60_000).toISOString(), resources: [] }, owner);
  return domain.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Approve Claude fixture', source: 'test' }, owner).task;
}

const readOnlyGuardFor = (cwd: string) => claudeToolGuard({ cwd, write: false });

function writeFakeClaudeCli(root: string) {
  const path = join(root, 'fake-claude-code.mjs');
  writeFileSync(path, `import {execFileSync,spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
const argv=process.argv.slice(2),arg=name=>argv[argv.indexOf(name)+1];
const server=JSON.parse(arg('--mcp-config')).mcpServers.wimzo,config=JSON.parse(readFileSync(server.args[1],'utf8'));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const pending=new Map();let hookId,initJsonSchema,sequence=0;
const control=request=>new Promise(done=>{const request_id='fixture-'+(++sequence);pending.set(request_id,done);send({type:'control_request',request_id,request});});
const preToolUse=(tool_name,tool_input)=>control({subtype:'hook_callback',callback_id:hookId,input:{hook_event_name:'PreToolUse',session_id:'claude-fixture-session',transcript_path:'',cwd:process.cwd(),tool_name,tool_input,tool_use_id:'tool-'+sequence},tool_use_id:'tool-'+sequence}).then(response=>response.response);
const bridge=spawn(server.command,server.args,{stdio:['pipe','pipe','inherit']}),replies=new Map();let rpcId=0;
createInterface({input:bridge.stdout}).on('line',line=>{const message=JSON.parse(line);replies.get(message.id)?.(message);});
const rpc=(method,params={})=>new Promise(done=>{const id=++rpcId;replies.set(id,done);bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
const tool=async(name,args={})=>{const reply=await rpc('tools/call',{name,arguments:args});if(reply.error)throw new Error(reply.error.message);return JSON.parse(reply.result.content[0].text);};
async function work(){
 await rpc('initialize',{protocolVersion:'2024-11-05'});
 const tools=(await rpc('tools/list')).result.tools.map(item=>item.name);
 const context=await tool('wimzo_context');
 const outside=await preToolUse('Write',{file_path:resolve('..','outside.txt'),content:'x'});
 const inside=await preToolUse('Write',{file_path:'answer.txt',content:'4\\n'});
 if(inside.continue===true){writeFileSync('answer.txt','4\\n');execFileSync('git',['-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qam','Write answer'])}
 await tool('wimzo_checkpoint',{summary:'Claude fixture wrote the answer',submissionId:'claude-fixture'});
 writeFileSync(join(config.stateDir,'claude-fixture.json'),JSON.stringify({argv,envKeys:Object.keys(process.env).sort(),approvedClaudeAuth:config.approvedClaudeAuth,runtime:config.runtime,tools,taskId:context.task.id,outside,inside,cwd:process.cwd(),initJsonSchema,tmp:{TMPDIR:process.env.TMPDIR,CLAUDE_CODE_TMPDIR:process.env.CLAUDE_CODE_TMPDIR}}));
 bridge.stdin.end();
 send({type:'system',subtype:'init',session_id:'claude-fixture-session'});
 send({type:'assistant',session_id:'claude-fixture-session',message:{role:'assistant',content:[{type:'text',text:'Wrote four'}],usage:{input_tokens:120,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
 const outcomeFile=join(config.stateDir,'claude-fixture-outcome.json');
 const proposed=existsSync(outcomeFile)?JSON.parse(readFileSync(outcomeFile,'utf8')):{status:'completed',summary:'Claude fixture wrote four and checked answer.txt'};
 if(proposed.maxTurns){send({type:'result',subtype:'error_max_turns',is_error:true,errors:['Reached maximum number of turns ('+argv[argv.indexOf('--max-turns')+1]+')'],session_id:'claude-fixture-session',usage:{}});return;}
 if(proposed.fail){send({type:'result',subtype:'success',is_error:true,api_error_status:400,result:proposed.fail,session_id:'claude-fixture-session',usage:{}});return;}
 const structuredDecision=await preToolUse('StructuredOutput',proposed);
 const structured=structuredDecision.continue===true?proposed:undefined;
 writeFileSync(join(config.stateDir,'claude-fixture-structured.json'),JSON.stringify(structuredDecision));
 send({type:'result',subtype:'success',is_error:false,result:'Claude fixture final text',structured_output:structured,session_id:'claude-fixture-session',usage:{input_tokens:120,output_tokens:9}});
}
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
 if(message.type==='control_response'){pending.get(message.response.request_id)?.(message.response);return;}
 if(message.type==='control_request'&&message.request.subtype==='initialize'){hookId=message.request.hooks.PreToolUse[0].hookCallbackIds[0];initJsonSchema=message.request.jsonSchema;send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],account:{}}}});return;}
 if(message.type==='user')work().catch(error=>{send({type:'result',subtype:'error_during_execution',is_error:true,result:String(error.message),session_id:'claude-fixture-session',usage:{}});});
}).on('close',()=>process.exit(0));
`);
  return path;
}

const allowClaude = { providers: ['openai', 'anthropic'], harnesses: ['codex', 'pi', 'claude'], authRoutes: ['subscription'] };

async function waitFor(read: () => Promise<any>, predicate: (value: any) => boolean, ms = 15_000) {
  const until = Date.now() + ms;
  let value = await read();
  while (!predicate(value) && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 50)); value = await read(); }
  assert.ok(predicate(value), JSON.stringify(value));
  return value;
}

test('Claude profiles dispatch through claude-profile and require the Anthropic subscription route', () => {
  assert.equal(dispatchRuntime({ runtime: 'claude' }), CLAUDE_PROFILE_RUNTIME);
  assert.equal(isProfileRuntime(CLAUDE_PROFILE_RUNTIME), true);
  assert.deepEqual([baseRuntime(CLAUDE_PROFILE_RUNTIME), baseRuntime('codex-profile'), baseRuntime('pi-profile'), baseRuntime('claude'), baseRuntime('script')], ['claude', 'codex', 'pi', 'claude', 'script']);
  assert.deepEqual(profileForTask({ runtime: CLAUDE_PROFILE_RUNTIME, budget: { workerProfile: claudeProfile } }), { ...claudeProfile, modelDescription: undefined, thinkingDescription: undefined });
  const invalid: Array<[Record<string, any>, RegExp]> = [
    [{ model: undefined }, /Anthropic subscription route and a model/],
    [{ model: ' ' }, /Anthropic subscription route and a model/],
    [{ provider: 'openai' }, /Anthropic subscription route/],
    [{ authRoute: undefined }, /Anthropic subscription route/],
    [{ authRoute: 'api-key' }, /authentication route is invalid/],
    [{ source: 'local-metadata' }, /Claude SDK metadata/],
    [{ verified: false }, /verified profile/],
  ];
  for (const [patch, message] of invalid) assert.throws(() => profileForTask({ runtime: CLAUDE_PROFILE_RUNTIME, budget: { workerProfile: { ...claudeProfile, ...patch } } }), message);
  assert.throws(() => profileForTask({ runtime: 'codex-profile', budget: { workerProfile: claudeProfile } }), /does not match/);
  assert.throws(() => profileForTask({ runtime: 'codex-profile', budget: { workerProfile: { ...claudeProfile, runtime: 'codex' } } }), /Codex profiles require Codex metadata/);
});

test('claude-profile capability is eligible only with an SDK, a claude.ai subscription login and an owner record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-capability-'));
  const login = fakeClaudeLogin(root);
  const store = new Store(join(root, 'state', 'state.sqlite')); const domain = Domain(store);
  let sdk: any = { available: true, version: '0.3.278' };
  const execution = Execution(store, domain, join(root, 'state'), { discoverPi: noPi, claudeSdk: () => sdk });
  const capability = async () => (await execution.call('runtime.capabilities', { refresh: true }, owner)).find((item: any) => item.name === CLAUDE_PROFILE_RUNTIME);
  try {
    await withPath(login.bin, async () => {
      login.setMode('logged-out');
      assert.match((await capability()).reason, /claude\.ai subscription/);
      login.setMode('api-key');
      assert.equal((await capability()).eligible, false);
      assert.match((await capability()).reason, /claude\.ai subscription/);
      login.setMode('subscription');
      const unauthorized = await capability();
      assert.equal(unauthorized.eligible, false); assert.match(unauthorized.reason, /Owner has not authorized/); assert.equal(unauthorized.authorization, null);
      await execution.call('worker.claude_auth', { decision: 'approve', source: 'Owner said: "use my Claude subscription for Wimzo workers on this Mac"' }, owner);
      const eligible = await execution.call('runtime.capabilities', {}, owner).then((rows: any[]) => rows.find(item => item.name === CLAUDE_PROFILE_RUNTIME));
      assert.equal(eligible.eligible, true); assert.equal(eligible.reason, undefined);
      assert.deepEqual([eligible.provider, eligible.authRoute, eligible.adapter, eligible.profileRuntime, eligible.modelSource, eligible.installedVersion], ['anthropic', 'subscription', 'claude-sdk', 'claude', 'local-metadata', '0.3.278']);
      assert.deepEqual(eligible.models.map((model: any) => [model.id, model.contextWindow, model.reasoningEfforts.map((entry: any) => entry.effort)]), ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'].map(id => [id, 200000, ['low', 'medium', 'high']]));
      assert.ok(eligible.models.every((model: any) => model.source === 'local-metadata' && /not discovered/.test(model.description)));
      assert.deepEqual(eligible.limits.runtime, 'claude');
      sdk = { available: false, reason: 'Claude Agent SDK package is not installed' };
      assert.match((await capability()).reason, /SDK package is not installed/);
      sdk = { available: true, version: '0.3.278' };
      await execution.call('worker.claude_auth', { decision: 'revoke', source: 'Owner said: "stop using Claude"' }, owner);
      assert.match((await execution.call('runtime.capabilities', {}, owner).then((rows: any[]) => rows.find(item => item.name === CLAUDE_PROFILE_RUNTIME))).reason, /Owner has not authorized/);
      assert.equal((await execution.call('runtime.capabilities', {}, owner)).find((item: any) => item.name === 'claude').eligible, true);
    });
  } finally { await execution.close(); store.close(); }
});

test('only the owner can approve or revoke the Claude subscription route and the record is durable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-auth-'));
  const app = new App(join(root, 'state'));
  try {
    const source = 'Owner said: "yes, authorize the claude.ai subscription for local workers"';
    for (const actor of [{ role: 'guide' as const, id: 'guide' }, { role: 'worker' as const, id: 'worker', taskId: 'task' }, { role: 'system' as const, id: 'system' }]) {
      await assert.rejects(app.call('worker.claude_auth', { decision: 'approve', source }, actor), /Action unavailable/);
      await assert.rejects(app.execution.call('worker.claude_auth', { decision: 'approve', source }, actor), /cannot call worker\.claude_auth/);
    }
    assert.throws(() => approveClaudeAuthorization(app.store, { role: 'system', id: 'system' }, source), /Only the owner/);
    await assert.rejects(app.call('worker.claude_auth', { decision: 'approve', source: '  ' }, owner), /quote the owner decision/);
    await assert.rejects(app.call('worker.claude_auth', { decision: 'approve' }, owner), /source is required/);
    await assert.rejects(app.call('worker.claude_auth', { decision: 'enable', source }, owner), /invalid value/);
    await assert.rejects(app.call('worker.claude_auth', { decision: 'revoke', source }, owner), /not authorized/);
    const approved = await app.call('worker.claude_auth', { decision: 'approve', source }, owner);
    assert.deepEqual({ route: approved.route, scope: approved.scope, paidApi: approved.paidApi, status: approved.status, actor: approved.actor, source: approved.source }, { route: 'claude.ai subscription', scope: 'local Mac only', paidApi: false, status: 'approved', actor: { role: 'owner', id: owner.id }, source });
    assert.ok(Number.isFinite(Date.parse(approved.at)));
    assert.equal(claudeAuthorization(app.store)?.rev, approved.rev);
    assert.ok(app.store.events(0).some(event => event.type === 'worker.claude_auth.approved' && event.data.source === source));
    const revoked = await app.call('worker.claude_auth', { decision: 'revoke', source: 'Owner said: "revoke it"' }, owner);
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revoked.actor.id, owner.id);
    assert.equal(claudeAuthorization(app.store), undefined);
    assert.throws(() => assertClaudeAuthorized(app.store), /missing or revoked/);
  } finally { await app.close(); }
});

test('project policy lists and launches Claude for one project while denying another, and launch needs the owner record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-policy-'));
  const login = fakeClaudeLogin(root);
  const app = new App(join(root, 'state'));
  try {
    await withPath(login.bin, async () => {
      const allowed = projectFixture(root, app.domain, 'claude_allowed'), denied = projectFixture(root, app.domain, 'claude_denied');
      await app.call('project.workerPolicy.set', { projectId: allowed.project.id, policy: allowClaude, expectedRev: 0 }, owner);
      const unauthorizedTask = approvedClaudeTask(app.domain, allowed);
      await assert.rejects(app.call('runtime.start', { taskId: unauthorizedTask.id }, owner), /Owner has not authorized/);
      assert.equal(app.store.list<any>('run').some(run => run.sdkConfigPath), false);
      assert.equal((await app.call('worker.options', { projectId: allowed.project.id }, owner)).profiles.some((profile: any) => profile.runtime === 'claude'), false);
      await app.call('worker.claude_auth', { decision: 'approve', source: 'Owner said: "authorize Claude subscription"' }, owner);
      const allowedOptions = await app.call('worker.options', { projectId: allowed.project.id }, owner);
      const claudeOptions = allowedOptions.profiles.filter((profile: any) => profile.runtime === 'claude');
      assert.equal(claudeOptions.length, 9);
      assert.ok(claudeOptions.every((profile: any) => profile.provider === 'anthropic' && profile.authRoute === 'subscription' && profile.source === 'claude-sdk' && profile.verified));
      assert.equal(allowedOptions.catalog.runtimes.claude.authorized, true);
      const validated = await app.call('worker.validate', { projectId: allowed.project.id, profile: 'claude:claude-opus-5-5:high' }, owner);
      assert.equal(validated.dispatchRuntime, CLAUDE_PROFILE_RUNTIME);
      assert.equal((await app.call('worker.options', { projectId: denied.project.id }, owner)).profiles.some((profile: any) => profile.runtime === 'claude'), false);
      await assert.rejects(app.call('worker.validate', { projectId: denied.project.id, profile: 'claude:claude-opus-5-5:high' }, owner), /not supported/);
      const deniedTask = approvedClaudeTask(app.domain, denied);
      await assert.rejects(app.call('runtime.start', { taskId: deniedTask.id }, owner), /Project worker policy has no permitted installed harness: claude/);
      assert.equal(app.store.require<any>('task', deniedTask.id).state, 'Approved');
    });
  } finally { await app.close(); }
});

test('Claude environment strips parent session state and credentials and refuses paid routing', () => {
  const env = claudeEnvironment({ HOME: '/tmp/home', PATH: '/usr/bin', LANG: 'C', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '4444', CLAUDE_PID: '12', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_SESSION_ID: 'parent', CLAUDE_PROJECT_DIR: '/parent', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_MODEL: 'paid', OPENAI_API_KEY: 'secret', ANTHROPIC_BASE_URL: '' });
  assert.deepEqual(env, { HOME: '/tmp/home', PATH: '/usr/bin', LANG: 'C' });
  for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_VERTEX_PROJECT_ID']) assert.throws(() => claudeEnvironment({ HOME: '/tmp/home', [key]: '1' }), new RegExp(`paid or cloud inference routing: ${key}`));
  const base: SdkOptions = { cwd: mkdtempSync(join(tmpdir(), 'wimzo-claude-env-')), write: false, prompt: 'fixture', env: { HOME: '/tmp/home', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1' }, bridgeConfigPath: '/tmp/sdk-config.json', onEvent: () => {}, approvedClaudeAuth: true };
  const baseSettings = claudeOptions(base);
  assert.deepEqual(baseSettings.env, { HOME: '/tmp/home', CLAUDE_CODE_TMPDIR: baseSettings.env.CLAUDE_CODE_TMPDIR, TMPDIR: baseSettings.env.CLAUDE_CODE_TMPDIR });
  rmSync(baseSettings.env.CLAUDE_CODE_TMPDIR, { recursive: true, force: true });
  assert.throws(() => claudeOptions({ ...base, env: { HOME: '/tmp/home', CLAUDE_CODE_USE_BEDROCK: '1' } }), /paid or cloud/);
  assert.throws(() => claudeOptions({ ...base, approvedClaudeAuth: undefined }), /no confirmed supported authentication route/);
});

test('Claude direct path guard rejects disallowed paths and configures SDK sandbox requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-guard-'));
  const workspace = join(root, 'worktree'); mkdirSync(join(workspace, 'src'), { recursive: true });
  const sibling = join(root, 'sibling'); mkdirSync(sibling); symlinkSync(sibling, join(workspace, 'escape'));
  const guard = claudeToolGuard({ cwd: workspace, write: true });
  assert.deepEqual(guard('Write', { file_path: 'src/answer.txt' }), { allowed: true });
  assert.deepEqual(guard('Edit', { file_path: join(workspace, 'answer.txt') }), { allowed: true });
  assert.deepEqual(guard('Bash', { command: 'node --test' }), { allowed: true });
  assert.deepEqual(guard('mcp__wimzo__wimzo_checkpoint', {}), { allowed: true });
  assert.deepEqual(guard('StructuredOutput', { status: 'completed', summary: 'Done' }), { allowed: true });
  assert.deepEqual(readOnlyGuardFor(workspace)('StructuredOutput', { status: 'blocked', summary: 'Stuck' }), { allowed: true });
  for (const [tool, input] of [['Write', { file_path: join(sibling, 'x.txt') }], ['Edit', { file_path: '../sibling/x.txt' }], ['Write', { file_path: 'escape/x.txt' }], ['Write', { file_path: '.git/config' }], ['Write', { file_path: '.claude/settings.json' }], ['Write', { file_path: '.wimzo/state.sqlite' }], ['NotebookEdit', { notebook_path: '/tmp/x.ipynb' }]] as const) assert.equal(guard(tool, input).allowed, false, `${tool} ${JSON.stringify(input)}`);
  for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__other__tool']) assert.equal(guard(tool, {}).allowed, false, tool);
  assert.equal(guard('Read', { file_path: join(sibling, 'x.txt') }).allowed, false);
  assert.equal(guard('Grep', { path: '/' }).allowed, false);
  assert.equal(guard('Read', { file_path: '.env' }).allowed, false);
  mkdirSync(join(workspace, '.codex'));
  writeFileSync(join(workspace, '.env.local'), 'fixture');
  symlinkSync(join(workspace, '.env.local'), join(workspace, 'secret-alias'));
  symlinkSync(join(workspace, '.codex'), join(workspace, 'protected-alias'));
  const explicitRoots = claudeToolGuard({ cwd: workspace, write: true, readRoots: [workspace, join(workspace, '.codex')] });
  for (const path of ['.env', '.env.local', 'src/.env.production', '.env.backup', '.git/config', '.claude/settings.json', '.codex/auth.json', '.wimzo/state.sqlite', 'secret-alias', 'protected-alias/auth.json']) {
    for (const tool of ['Read', 'Grep', 'Glob', 'Write']) {
      const input = tool === 'Grep' || tool === 'Glob' ? { path } : { file_path: path };
      assert.equal(explicitRoots(tool, input).allowed, false, `${tool} ${path}`);
    }
  }
  assert.equal(guard('Read', { file_path: 'src/environment.ts' }).allowed, true);
  const readOnly = claudeToolGuard({ cwd: workspace, write: false });
  assert.equal(readOnly('Write', { file_path: 'answer.txt' }).allowed, false); assert.equal(readOnly('Bash', { command: 'ls' }).allowed, false); assert.equal(readOnly('Read', { file_path: 'answer.txt' }).allowed, true);
  let authorized = true;
  const settings: any = claudeOptions({ cwd: workspace, write: true, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, 'write', 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true, assertAuthorized: () => { if (!authorized) throw new Error('Owner authorization for the Claude subscription route is missing or revoked'); } });
  const workspacePath = settings.cwd;
  const uid = process.getuid!(); const temporary = realpathSync(settings.env.CLAUDE_CODE_TMPDIR);
  assert.deepEqual(settings.sandbox, { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false }, filesystem: { allowWrite: [workspacePath, temporary], denyWrite: [...['.git', '.claude', '.codex', '.wimzo'].map(name => join(workspacePath, name)), '/tmp/claude', '/private/tmp/claude', `/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`] } });
  assert.deepEqual(settings.outputFormat, { type: 'json_schema', schema: CLAUDE_OUTCOME_SCHEMA });
  assert.deepEqual([settings.permissionMode, settings.strictMcpConfig, settings.additionalDirectories, settings.pathToClaudeCodeExecutable], ['dontAsk', true, undefined, undefined]);
  assert.deepEqual(settings.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: 'answer.txt' } }), { continue: true });
  assert.equal((await hook({ tool_name: 'Write', tool_input: { file_path: join(sibling, 'x') } })).hookSpecificOutput.permissionDecision, 'deny');
  authorized = false;
  assert.match((await hook({ tool_name: 'Write', tool_input: { file_path: 'answer.txt' } })).hookSpecificOutput.permissionDecisionReason, /revoked/);
  const readOnlySettings: any = claudeOptions({ cwd: workspace, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, 'read-only', 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true });
  assert.equal(readOnlySettings.permissionMode, 'dontAsk');
  const readOnlyHook = readOnlySettings.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(readOnlySettings.tools, ['Read', 'Glob', 'Grep']); assert.deepEqual(readOnlySettings.allowedTools, ['Read', 'Glob', 'Grep', 'StructuredOutput', 'mcp__wimzo__*']);
  assert.deepEqual(await readOnlyHook({ tool_name: 'StructuredOutput', tool_input: { status: 'completed', summary: 'Read-only check done' } }), { continue: true });
  assert.ok(['Edit', 'Write', 'Bash', 'WebFetch', 'Agent'].every(tool => readOnlySettings.disallowedTools.includes(tool)));
  assert.deepEqual(readOnlySettings.sandbox.filesystem.allowWrite, [realpathSync(readOnlySettings.env.CLAUDE_CODE_TMPDIR)]);
  assert.deepEqual(await readOnlyHook({ tool_name: 'mcp__wimzo__wimzo_checkpoint', tool_input: { summary: 'read-only progress' } }), { continue: true });
  for (const tool of ['Write', 'Edit', 'Bash', 'ExitPlanMode']) assert.equal((await readOnlyHook({ tool_name: tool, tool_input: { file_path: 'answer.txt', command: 'touch x' } })).hookSpecificOutput.permissionDecision, 'deny', tool);
  for (const value of [settings, readOnlySettings]) rmSync(value.env.CLAUDE_CODE_TMPDIR, { recursive: true, force: true });
});

test('each Claude run gets a short private temporary root outside the shared per-uid directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-tmp-'));
  const first = claudeTemporaryDirectory(join(root, 'run-a', 'sdk-config.json')), again = claudeTemporaryDirectory(join(root, 'run-a', 'sdk-config.json')), second = claudeTemporaryDirectory(join(root, 'run-b', 'sdk-config.json'));
  try {
    assert.equal(first.path, again.path); assert.notEqual(first.path, second.path);
    assert.match(first.path, /^\/tmp\/wzc-[0-9a-f]{12}$/);
    assert.ok(Buffer.byteLength(join(first.path, `claude-${process.getuid!()}`)) <= 44);
    assert.equal(statSync(first.path).mode & 0o777, 0o700);
    assert.equal(first.real, realpathSync(first.path));
    assert.ok(!first.real.startsWith(`/private/tmp/claude-${process.getuid!()}`));
  } finally { for (const value of [first, second]) rmSync(value.path, { recursive: true, force: true }); }
});

test('mocked Claude calls preserve unrelated old global temporary directories and run files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-no-cleanup-'));
  const unrelated = `/tmp/wzc-${randomBytes(6).toString('hex')}`;
  mkdirSync(unrelated, { mode: 0o700 });
  const sentinel = join(unrelated, 'keep.txt');
  writeFileSync(sentinel, 'unrelated data');
  const old = new Date(Date.now() - 30 * 60 * 60_000);
  utimesSync(unrelated, old, old);
  const runRoots: string[] = [];
  try {
    for (const fails of [false, true]) {
      const options: SdkOptions = { cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, String(fails), 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true };
      const query = ({ options: settings }: any) => {
        runRoots.push(settings.env.CLAUDE_CODE_TMPDIR);
        writeFileSync(join(settings.env.CLAUDE_CODE_TMPDIR, 'run.txt'), 'run data');
        return { interrupt: async () => {}, async *[Symbol.asyncIterator]() {
          if (fails) throw new Error('fixture failure');
          yield { type: 'result', subtype: 'success', structured_output: { status: 'completed', summary: 'Done' } };
        } };
      };
      if (fails) await assert.rejects(runClaude(options, { query }), /fixture failure/);
      else await runClaude(options, { query });
      assert.equal(readFileSync(sentinel, 'utf8'), 'unrelated data');
      assert.equal(readFileSync(join(runRoots.at(-1)!, 'run.txt'), 'utf8'), 'run data');
    }
  } finally {
    for (const path of [unrelated, root, ...runRoots]) rmSync(path, { recursive: true, force: true });
  }
});

test('Claude completion requires an explicit structured status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-outcome-'));
  const options = (name: string): SdkOptions => ({ cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, name, 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true });
  const finishing = (result: Record<string, any>) => () => ({ interrupt: async () => {}, async *[Symbol.asyncIterator]() { yield { type: 'result', is_error: false, usage: {}, session_id: 'outcome-session', ...result }; } });
  const completed = await runClaude(options('completed'), { query: finishing({ result: 'text', structured_output: { status: 'completed', summary: 'Done and checked' } }) });
  assert.deepEqual([completed.outcome, completed.summary], ['completed', 'Done and checked']);
  const owner = await runClaude(options('owner'), { query: finishing({ result: 'text', structured_output: { status: 'needs_owner', summary: 'Need a decision' } }) });
  assert.deepEqual([owner.outcome, owner.summary], ['needs_owner', 'Need a decision']);
  for (const structured of [undefined, { status: 'done', summary: 'x' }, { status: 'completed', summary: ' ' }]) {
    const missing = await runClaude(options(`missing-${JSON.stringify(structured)}`), { query: finishing({ result: 'I could not complete the task', structured_output: structured }) });
    assert.equal(missing.outcome, 'blocked'); assert.match(missing.summary, /without an explicit completion status.*could not complete/);
  }
});

test('revoking the Claude subscription route aborts an active Claude SDK run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-revoke-'));
  const store = new Store(join(root, 'state.sqlite'));
  approveClaudeAuthorization(store, owner, 'Owner said: "authorize"');
  let interrupted = false, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const query = () => ({
    interrupt: async () => { interrupted = true; release(); },
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'revoked-claude-session' };
      revokeClaudeAuthorization(store, owner, 'Owner said: "revoke"');
      await waiting;
      yield { type: 'assistant', session_id: 'revoked-claude-session', message: { usage: { input_tokens: 1 } } };
      yield { type: 'result', is_error: false, result: 'must not finish', usage: {} };
    },
  });
  try {
    await assert.rejects(runClaude({ cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: '/tmp/sdk-config.json', onEvent: () => {}, approvedClaudeAuth: true, assertAuthorized: () => { assertClaudeAuthorized(store); } }, { query }), /missing or revoked/);
    assert.equal(interrupted, true);
  } finally { store.close(); }
});

async function dispatchClaudeFixture(label: string, outcome: Record<string, string> | undefined, check: (context: { app: App; state: string; fakeCli: string; fixture: ReturnType<typeof projectFixture>; approved: any; run: any }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), `wimzo-claude-${label}-`));
  const login = fakeClaudeLogin(root);
  const fakeCli = writeFakeClaudeCli(root);
  const previous = { executable: process.env.WIMZO_CLAUDE_EXECUTABLE, claudecode: process.env.CLAUDECODE, port: process.env.CLAUDE_CODE_SSE_PORT };
  process.env.WIMZO_CLAUDE_EXECUTABLE = fakeCli; process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_SSE_PORT = '9';
  const state = join(root, 'state');
  const app = new App(state);
  if (outcome) writeFileSync(join(state, 'claude-fixture-outcome.json'), JSON.stringify(outcome));
  try {
    await withPath(login.bin, async () => {
      const fixture = projectFixture(root, app.domain, `claude_${label}`);
      await app.call('project.workerPolicy.set', { projectId: fixture.project.id, policy: allowClaude, expectedRev: 0 }, owner);
      await app.call('worker.claude_auth', { decision: 'approve', source: 'Owner said: "use my Claude subscription for this fixture"' }, owner);
      const approved = approvedClaudeTask(app.domain, fixture, ['workspace-write']);
      const tick: any = await app.execution.tickProfiles();
      assert.equal(tick.queue.started.length, 1, JSON.stringify(tick.queue));
      assert.equal(tick.inferenceLaunches, 1);
      const run: any = await waitFor(() => app.call('runtime.inspect', { runId: tick.queue.started[0] }, owner), value => ['completed', 'failed', 'paused'].includes(value.status));
      await check({ app, state, fakeCli, fixture, approved, run });
    });
  } finally {
    await app.close();
    for (const [key, value] of [['WIMZO_CLAUDE_EXECUTABLE', previous.executable], ['CLAUDECODE', previous.claudecode], ['CLAUDE_CODE_SSE_PORT', previous.port]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('an approved claude-profile task runs the official SDK against a fixture CLI with scoped tools and reaches Verifying', async () => {
  await dispatchClaudeFixture('e2e', undefined, async ({ app, state, fakeCli, fixture, approved, run }) => {
    assert.equal(run.status, 'completed', readFileSync(run.paths.stderr, 'utf8'));
    assert.deepEqual([run.runtime, run.adapter, run.provider, run.model, run.thinking], [CLAUDE_PROFILE_RUNTIME, 'claude-sdk', 'anthropic', 'claude-sonnet-5', 'low']);
    const sdkConfig = JSON.parse(readFileSync(run.sdkConfigPath, 'utf8'));
    assert.deepEqual([sdkConfig.runtime, sdkConfig.approvedClaudeAuth, sdkConfig.claudeExecutable, sdkConfig.contextCapacity], ['claude', true, fakeCli, 200000]);
    assert.equal(sdkConfig.env.CLAUDECODE, undefined); assert.equal(sdkConfig.env.CLAUDE_CODE_SSE_PORT, undefined);
    const evidence = JSON.parse(readFileSync(join(state, 'claude-fixture.json'), 'utf8'));
    assert.equal(evidence.approvedClaudeAuth, true); assert.equal(evidence.taskId, approved.id);
    assert.ok(['wimzo_context', 'wimzo_checkpoint', 'wimzo_phase'].every(name => evidence.tools.includes(name)));
    assert.equal(evidence.outside.hookSpecificOutput.permissionDecision, 'deny'); assert.deepEqual(evidence.inside, { continue: true });
    assert.equal(evidence.envKeys.some((key: string) => key === 'CLAUDECODE' || key === 'CLAUDE_CODE_SSE_PORT' || key.startsWith('ANTHROPIC_')), false);
    assert.match(evidence.tmp.CLAUDE_CODE_TMPDIR, /^\/tmp\/wzc-[0-9a-f]{12}$/); assert.equal(evidence.tmp.TMPDIR, evidence.tmp.CLAUDE_CODE_TMPDIR);
    assert.equal(existsSync(evidence.tmp.CLAUDE_CODE_TMPDIR), true);
    rmSync(evidence.tmp.CLAUDE_CODE_TMPDIR, { recursive: true, force: true });
    assert.deepEqual([evidence.argv[evidence.argv.indexOf('--model') + 1], evidence.argv[evidence.argv.indexOf('--effort') + 1], evidence.argv[evidence.argv.indexOf('--permission-mode') + 1]], ['claude-sonnet-5', 'low', 'dontAsk']);
    const settings = JSON.parse(evidence.argv[evidence.argv.indexOf('--settings') + 1]);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(settings.sandbox.filesystem.allowWrite.includes(realpathSync('/tmp') + evidence.tmp.CLAUDE_CODE_TMPDIR.slice('/tmp'.length)));
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(`/private/tmp/claude-${process.getuid!()}`));
    assert.deepEqual(evidence.initJsonSchema, CLAUDE_OUTCOME_SCHEMA);
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'claude-fixture-structured.json'), 'utf8')), { continue: true });
    assert.equal(readFileSync(join(evidence.cwd, 'answer.txt'), 'utf8'), '4\n');
    assert.equal(existsSync(join(evidence.cwd, '..', 'outside.txt')), false);
    assert.equal(readFileSync(join(fixture.projectRoot, 'answer.txt'), 'utf8'), 'TODO\n');
    assert.equal(run.sdkSessionId, 'claude-fixture-session'); assert.equal(run.contextTelemetry.used, 120); assert.equal(run.contextTelemetry.estimated, false);
    assert.equal(run.sdkResult.outcome, 'completed'); assert.equal(run.sdkResult.summary, 'Claude fixture wrote four and checked answer.txt');
    assert.ok(app.store.list<any>('worker_checkpoint').some(checkpoint => checkpoint.taskId === approved.id));
    await app.execution.tickProfiles();
    assert.equal(app.store.require<any>('task', approved.id).state, 'Verifying');
    assert.equal(app.store.require<any>('run', run.id).resultReported, true);
    const status = await app.call('worker.status', { projectId: fixture.project.id }, owner);
    const projected = [...status.active, ...status.recent].find((value: any) => value.taskId === approved.id);
    assert.deepEqual([projected.runtime, projected.provider, projected.model], [CLAUDE_PROFILE_RUNTIME, 'anthropic', 'claude-sonnet-5']);
    assert.equal(status.runtimes.find((value: any) => value.id === CLAUDE_PROFILE_RUNTIME).label, 'Claude SDK');
    assert.ok(readdirSync(join(state, 'runs')).length >= 1);
  });
});

for (const status of ['blocked', 'needs_owner']) test(`a Claude run reporting ${status} pauses with its summary instead of entering Verifying`, async () => {
  const summary = `Could not finish: the fixture needs an owner decision (${status}).`;
  await dispatchClaudeFixture(status.replace('_', '-'), { status, summary }, async ({ app, approved, run }) => {
    assert.equal(run.status, 'paused', readFileSync(run.paths.stderr, 'utf8'));
    assert.equal(run.exitCode, 76);
    assert.deepEqual(run.workerOutcome, { status, summary });
    assert.match(run.error, new RegExp(`Worker reported ${status}: Could not finish`));
    await waitFor(async () => { await app.execution.tickProfiles(); return app.store.require<any>('task', approved.id); }, value => value.state === 'Paused');
    const task = app.store.require<any>('task', approved.id);
    assert.notEqual(task.state, 'Verifying');
    assert.equal(app.store.list<any>('result').some(result => result.taskId === approved.id), false);
    assert.equal(app.store.require<any>('run', run.id).resultReported, undefined);
    assert.ok(app.store.list<any>('worker_checkpoint').some(checkpoint => checkpoint.taskId === approved.id && String(checkpoint.data?.summary ?? checkpoint.summary).includes('Could not finish')));
    assert.ok(app.store.list<any>('checkpoint').some(checkpoint => checkpoint.taskId === approved.id && checkpoint.data?.candidate));
    assert.match(app.store.require<any>('run', run.id).error, /Could not finish/);
  });
});

test('Claude failures name the error code and bounded detail without credentials', async () => {
  const versionError = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required","apiErrorCode":"claude_code_version_too_old"}}';
  const message = claudeFailureMessage({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: versionError });
  assert.match(message, /^claude_code_version_too_old: success, HTTP 400: API Error: 400 .*version 2\.1\.280 or newer is required/);
  assert.match(claudeFailureMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (40)'] }), /^error_max_turns: Reached maximum number of turns \(40\)$/);
  assert.match(claudeFailureMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid request' }, 'invalid_request'), /^invalid_request: success: Invalid request$/);
  const redacted = claudeFailureMessage({ type: 'result', subtype: 'error_during_execution', errors: ['failed with sk-ant-oat01-abcdef123456 and Bearer abc.def.ghi and api_key=zzz9', 'x'.repeat(3000)] });
  assert.doesNotMatch(redacted, /sk-ant-oat01|abc\.def\.ghi|zzz9/); assert.match(redacted, /\[redacted\]/); assert.ok(redacted.length <= 1000);
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-failure-'));
  const failing = () => ({ interrupt: async () => {}, async *[Symbol.asyncIterator]() { yield { type: 'assistant', error: 'invalid_request', message: { usage: { input_tokens: 1 } } }; yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: versionError, usage: {} }; } });
  await assert.rejects(runClaude({ cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, 'failure', 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true }, { query: failing }), /^Error: claude_code_version_too_old: success, HTTP 400: /);
});

test('a failed Claude result is recorded on the run and in stderr with its error code', async () => {
  const fail = 'API Error: 400 {"error":{"message":"Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required","apiErrorCode":"claude_code_version_too_old"}}';
  await dispatchClaudeFixture('api-failure', { fail } as any, async ({ app, approved, run }) => {
    assert.equal(run.status, 'failed');
    const recorded = app.store.require<any>('run', run.id);
    assert.match(recorded.error, /^claude_code_version_too_old: success, HTTP 400: .*2\.1\.280 or newer is required/);
    assert.match(readFileSync(run.paths.stderr, 'utf8'), /claude_code_version_too_old: /);
    await waitFor(async () => { await app.execution.tickProfiles(); return app.store.require<any>('task', approved.id); }, value => value.state === 'Failed');
    assert.equal(app.store.require<any>('run', run.id).state, 'Failed');
    assert.ok(app.store.list<any>('inbox').some(item => item.kind === 'run failed' && item.status === 'pending' && item.data.runId === run.id));
  });
});

test('Claude turn limits come from the task budget, default to 150 and reject invalid values', () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-turns-'));
  const base: SdkOptions = { cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, 'turns', 'sdk-config.json'), onEvent: () => {}, approvedClaudeAuth: true };
  assert.equal(claudeOptions(base).maxTurns, CLAUDE_DEFAULT_MAX_TURNS);
  assert.equal(CLAUDE_DEFAULT_MAX_TURNS, 150);
  assert.equal(claudeOptions({ ...base, maxTurns: 60 }).maxTurns, 60);
  for (const invalid of [0, -1, 2.5, CLAUDE_MAX_TURNS_LIMIT + 1, '40']) assert.throws(() => claudeMaxTurns(invalid), /maxTurns must be an integer from 1 to 500/);
});

test('reaching the Claude turn limit returns a continuation instead of failing the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-claude-turn-limit-'));
  const events: any[] = [];
  const limited = () => ({ interrupt: async () => {}, async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init', session_id: 'turn-limit-session' }; yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (12)'], session_id: 'turn-limit-session', usage: { output_tokens: 3 } }; } });
  const result: any = await runClaude({ cwd: root, write: false, prompt: 'fixture', env: {}, bridgeConfigPath: join(root, 'limit', 'sdk-config.json'), onEvent: event => events.push(event), approvedClaudeAuth: true, maxTurns: 12 }, { query: limited });
  assert.equal(result.needsContinuation, true);
  assert.equal(result.sessionId, 'turn-limit-session');
  assert.match(result.summary, /turn limit \(12\)/);
  assert.ok(events.some(event => event.type === 'turn_limit_checkpoint'));
});

test('a dispatched Claude run that reaches its turn limit pauses with a continuation checkpoint', async () => {
  await dispatchClaudeFixture('turn-limit', { maxTurns: 'true' }, async ({ app, state, approved, run }) => {
    assert.equal(run.status, 'paused', readFileSync(run.paths.stderr, 'utf8'));
    assert.equal(run.exitCode, 75);
    const recorded = app.store.require<any>('run', run.id);
    assert.equal(recorded.needsContinuation, true);
    const argv: string[] = JSON.parse(readFileSync(join(state, 'claude-fixture.json'), 'utf8')).argv;
    assert.equal(argv[argv.indexOf('--max-turns') + 1], String(CLAUDE_DEFAULT_MAX_TURNS));
    const checkpoints = app.store.list<any>('worker_checkpoint').filter(checkpoint => checkpoint.taskId === approved.id);
    assert.ok(checkpoints.some(checkpoint => /turn limit/.test(String(checkpoint.data?.summary ?? checkpoint.summary))));
    assert.ok(checkpoints.some(checkpoint => /fresh bounded run/.test(String(checkpoint.data?.next ?? checkpoint.next))));
    await waitFor(async () => { await app.execution.tickProfiles(); return app.store.require<any>('task', approved.id); }, value => value.state === 'Paused');
    assert.equal(app.store.list<any>('result').some(result => result.taskId === approved.id), false);
  });
});
