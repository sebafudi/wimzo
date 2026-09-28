import { saveWorkerCheckpoint } from './worker-context.ts';
import { runChangelogs, saveRunChangelog } from './run-changelog.ts';
import { prepareWorkerDependencies } from './worker-dependencies.ts';
import { codexRuntimeReadPaths } from './codex-permissions.ts';
import { materializeCandidate,workflowSource } from './workflow-candidates.ts';
import { validateExecutionPolicy } from './models.ts';
import { discoverPi, nodeRuntimeReadPaths } from './pi-sdk.ts';
import { assertTechnicalTask } from './launch-policy.ts';
import { CLAUDE_PROFILE_RUNTIME, CODEX_PROFILE_RUNTIME, baseRuntime as profileBaseRuntime, isProfileRuntime, profileForTask, runtimeProvider } from './worker-profile.ts';
import { approveClaudeAuthorization, claudeAuthorization, claudeMaxTurns, claudeModels, claudeSdkPackage, revokeClaudeAuthorization } from './claude-profile.ts';
import { spawn, execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { Store, assert, hash, id, now, type RecordValue } from './store.ts';

const execFileAsync = promisify(execFile);

export type Actor = { role: 'owner' | 'guide' | 'worker' | 'system'; id: string; taskId?: string };
type DomainLike = {
  call(action: string, input: Record<string, any>, actor: Actor): any;
  actions?: () => Array<{ name: string }>;
};

type ActionDescriptor = {
  name: string;
  description: string;
  roles: Actor['role'][];
  inputSchema: Record<string, any>;
};

type Capability = {
  name: string;
  version: number;
  description: string;
  command: string;
  access: 'read' | 'write' | 'network-read';
  sideEffects: string[];
  timeoutMs: number;
  retry: 'never' | 'safe';
  args(input: Record<string, any>): string[];
  projectId?: string;
  source?: 'built-in' | 'saved';
};

type Procedure = RecordValue & { projectId: string; description: string; command: string; args: string[]; access: Capability['access']; sideEffects: string[]; timeoutMs: number; status: 'proposed' | 'approved'; proposedBy: Record<string, any>; approvedBy?: Record<string, any> };

const MAX_PROCEDURE_TIMEOUT_MS = 45 * 60_000;

type RunRecord = RecordValue & {
  taskId?: string;
  projectId?: string;
  runtime: string;
  adapterVersion: number;
  runType: 'technical' | 'script' | 'gui';
  status: string;
  launchKey: string;
  launchState: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadline?: string;
  cwd?: string;
  pid?: number;
  command?: string;
  args?: string[];
  capability?: string;
  paths?: { stdout: string; stderr: string; status: string; result: string };
  resultReported?: boolean;
  cancelRequestedAt?: string;
  error?: string;
  usage?: Record<string, any>;
  [key: string]: any;
};

type WatchRecord = RecordValue & {
  projectId: string;
  kind: 'git-ref' | 'pr-checks';
  repository: string;
  ref?: string;
  pr?: number | string;
  expectedCandidate?: string;
  intervalMs: number;
  status: 'active' | 'paused' | 'canceled' | 'expired';
  health: 'unknown' | 'healthy' | 'unhealthy' | 'expired';
  createdAt: string;
  nextCheckAt: string;
  expiresAt?: string;
  lastSuccessAt?: string;
  lastObservation?: any;
  observationHash?: string;
  retryCount: number;
  lastError?: string;
  recentEvents: any[];
  pendingReconciliation?: string;
};

const LAUNCH_GRACE_MS = 60_000;

const WRAPPER = String.raw`
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const p=JSON.parse(process.argv[1]);
const write=(value)=>{const tmp=p.status+'.tmp.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,p.status)};
const out=fs.openSync(p.stdout,'a'); const err=fs.openSync(p.stderr,'a');
const child=spawn(p.command,p.args,{cwd:p.cwd,env:p.env,stdio:['ignore',out,err]});
write({state:'running',wrapperPid:process.pid,pid:child.pid,startedAt:new Date().toISOString()});
let requested;
const signalGroup=(signal)=>{let pids=[];try{pids=require('node:child_process').execFileSync('pgrep',['-g',String(process.pid)],{encoding:'utf8'}).split(/\s+/).filter(Boolean).map(Number)}catch{};for(const pid of [child.pid,...pids])if(pid&&pid!==process.pid)try{process.kill(pid,signal)}catch{}};
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{requested=requested??'cancel';try{child.kill(signal)}catch{}});
const remaining=Date.parse(p.deadline)-Date.now();
const deadlineTimer=setTimeout(()=>{requested='deadline';signalGroup('SIGTERM');setTimeout(()=>signalGroup('SIGKILL'),2000).unref()},Number.isFinite(remaining)?Math.max(0,remaining):0);
child.on('error',e=>{write({state:'failed',wrapperPid:process.pid,error:String(e.message||e),finishedAt:new Date().toISOString()});process.exitCode=1});
const GROUP_KILL_SETTLE_MS=250;
child.on('close',(code,signal)=>{clearTimeout(deadlineTimer);if(requested==='deadline')signalGroup('SIGKILL');setTimeout(()=>finish(code,signal),code!==0&&!requested?GROUP_KILL_SETTLE_MS:0)});
const finish=(code,signal)=>{write({state:requested==='cancel'?'canceled':requested==='deadline'?'failed':code===0?'completed':'failed',wrapperPid:process.pid,pid:child.pid,code,signal,error:requested==='deadline'?'Execution deadline exceeded':undefined,finishedAt:new Date().toISOString()});fs.closeSync(out);fs.closeSync(err)};
`;

const descriptor = (
  name: string,
  description: string,
  roles: Actor['role'][],
  properties: Record<string, any> = {},
  required: string[] = [],
): ActionDescriptor => ({
  name,
  description,
  roles,
  inputSchema: { type: 'object', additionalProperties: false, properties, required },
});

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function canonicalJson(value:any):string {
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function jsonFile(path: string): any | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function atomicJson(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

function processGroupAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(-pid,0); return true; } catch { return false; }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv = {};
  for (const key of ['HOME','USER','LOGNAME','TMPDIR','SHELL','LANG','TERM','CODEX_HOME','PI_CODING_AGENT_DIR']) {
    if (process.env[key]) env[key]=process.env[key];
  }
  for (const [key,value] of Object.entries(process.env)) if (key.startsWith('LC_')) env[key]=value;
  env.PATH = [dirname(process.execPath), process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
  return env;
}

function within(root: string, candidate: string): boolean {
  const path=relative(resolve(root),resolve(candidate));
  return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`));
}

async function candidateFor(task: any, run: RunRecord): Promise<Record<string, any>> {
  const source = run.candidate ?? run.sourceCandidate ?? task.sourceCandidate;
  const fallback=source && typeof source === 'object' && !Array.isArray(source)
    ? { ...source, id:String(source.id ?? source.commit ?? source.sha ?? run.id), specHash:task.specHash }
    : { id:String(source ?? run.id), specHash:task.specHash };
  if(!run.cwd||!existsSync(run.cwd)) return fallback;
  let baseCommit:string;
  try {
    const head=await execFileAsync('git',['rev-parse','HEAD'],{cwd:run.cwd,timeout:30_000,maxBuffer:4*1024*1024,env:cleanEnvironment()});
    baseCommit=String(head.stdout).trim();
  } catch {return {id:run.id,specHash:task.specHash,sourceCandidate:fallback};}
  const launchSource=run.resolvedWorkflowSource?.commit??run.sourceCandidate??task.sourceCandidate;
  const launchCommit=typeof launchSource==='string'?launchSource:launchSource?.id??launchSource?.commit??launchSource?.sha;
  if(typeof launchCommit==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(launchCommit)){
    try{await execFileAsync('git',['merge-base','--is-ancestor',launchCommit,baseCommit],{cwd:run.cwd,timeout:30000,env:cleanEnvironment()});}
    catch{throw new Error('Worker candidate does not descend from its exact launch source');}
  }
  const statusResult=await execFileAsync('git',['status','--porcelain=v1','-z','--untracked-files=all'],{cwd:run.cwd,timeout:30_000,maxBuffer:16*1024*1024,env:cleanEnvironment()});
  const status=String(statusResult.stdout??'');
  if(!status) return {id:baseCommit,specHash:task.specHash};
  const diffResult=await execFileAsync('git',['diff','--binary','HEAD','--'],{cwd:run.cwd,timeout:30_000,maxBuffer:64*1024*1024,env:cleanEnvironment()});
  const diff=String(diffResult.stdout??'');
  const statusEntries=status.split('\0').filter(Boolean);
  const untrackedPaths=statusEntries.filter(entry=>entry.startsWith('?? ')).map(entry=>entry.slice(3)).sort();
  const untracked=untrackedPaths.map(path=>{
    const absolute=resolve(run.cwd!,path);assert(within(run.cwd!,absolute),'Untracked candidate path escapes its worktree');
    const info=lstatSync(absolute);
    return info.isSymbolicLink()?{path,type:'symlink',target:readlinkSync(absolute)}:{path,type:'file',content:readFileSync(absolute).toString('base64')};
  });
  const diffDigest=hash(diff);
  const untrackedDigest=hash(canonicalJson(untracked));
  const worktreeDigest=hash(canonicalJson({baseCommit,statusEntries,diffDigest,untrackedDigest}));
  return {id:`sha256:${worktreeDigest}`,baseCommit,worktreeDigest,diffDigest,untrackedDigest,dirty:true,specHash:task.specHash};
}

function allowsWrite(permissions:any):boolean {
  if(permissions?.write===true||permissions?.filesystem==='write') return true;
  return Array.isArray(permissions)&&permissions.some(value=>['write','workspace-write','filesystem:write'].includes(value));
}

function stringArray(value: unknown, label = 'args'): string[] {
  assert(Array.isArray(value ?? []), `${label} must be an array`);
  const result = ((value ?? []) as unknown[]).map((item: unknown) => {
    assert(typeof item === 'string', `${label} must contain strings`);
    assert(!item.includes('\0'), `${label} contains an invalid value`);
    return item;
  });
  assert(result.length <= 100, `${label} is too large`);
  return result;
}

function capabilitiesRegistry(): Map<string, Capability> {
  const pathArgs = (input: Record<string, any>) => stringArray(input.args);
  const nodeTests = (input:Record<string,any>) => {
    const files=pathArgs(input);
    assert(files.length>0,'At least one test file is required');
    for(const file of files) assert(!file.startsWith('-') && /(?:^|\/)[^/]+\.test\.(?:js|mjs|cjs|ts)$/.test(file),'Only explicit Node test file paths are allowed');
    return ['--test',...files];
  };
  const xcodeArgs = (input:Record<string,any>) => {
    const args=pathArgs(input);
    assert(args.some(value=>['build','test','build-for-testing','test-without-building'].includes(value)),'An Xcode build or test action is required');
    assert(!args.some(value=>['archive','-exportArchive','-exportPath','-allowProvisioningUpdates'].includes(value)),'Archive, export, and provisioning changes are not allowed');
    return args;
  };
  const gitArgs = (input:Record<string,any>) => {
    const args=pathArgs(input); const sub=args[0];
    assert(['status','diff','log','show','rev-parse','ls-files'].includes(sub),'Git subcommand is not read-only');
    assert(!args.some(value=>value==='--output'||value.startsWith('--output=')||value==='--ext-diff'||value==='--textconv'),'Git output files and external commands are not allowed');
    return args;
  };
  return new Map<string, Capability>([
    ['node.test', { name: 'node.test', version: 1, description: 'Run explicit Node test files', command: process.execPath, access: 'write', sideEffects: ['executes approved repository tests and writes test-owned temporary files'], timeoutMs: 10 * 60_000, retry: 'safe', args: nodeTests }],
    ['swift.test', { name: 'swift.test', version: 1, description: 'Run Swift package tests', command: 'swift', access: 'write', sideEffects: ['writes local build outputs'], timeoutMs: 30 * 60_000, retry: 'safe', args: input => ['test', ...pathArgs(input)] }],
    ['xcodebuild.check', { name: 'xcodebuild.check', version: 1, description: 'Run a bounded Xcode build or test check', command: 'xcodebuild', access: 'write', sideEffects: ['writes local build outputs and may access Simulator services'], timeoutMs: 45 * 60_000, retry: 'safe', args: xcodeArgs }],
    ['simctl.list', { name: 'simctl.list', version: 1, description: 'Inspect CoreSimulator devices and runtimes', command: 'xcrun', access: 'read', sideEffects: [], timeoutMs: 60_000, retry: 'safe', args: input => ['simctl', 'list', ...pathArgs(input)] }],
    ['git.validate', { name: 'git.validate', version: 1, description: 'Run a read-only Git validation query', command: 'git', access: 'read', sideEffects: [], timeoutMs: 60_000, retry: 'safe', args: gitArgs }],
    ['gh.pr-checks', { name: 'gh.pr-checks', version: 1, description: 'Read GitHub pull request checks', command: 'gh', access: 'network-read', sideEffects: [], timeoutMs: 60_000, retry: 'safe', args: input => ['pr','checks',String(input.pr),'--json','bucket,completedAt,event,link,name,state,workflow'] }],
    ['gh.pr-view', { name: 'gh.pr-view', version: 1, description: 'Read GitHub pull request head revision', command: 'gh', access: 'network-read', sideEffects: [], timeoutMs: 60_000, retry: 'safe', args: input => ['pr','view',String(input.pr),'--json','headRefOid,state,url'] }],
  ]);
}

export function Execution(store: Store, domain: DomainLike, stateDir: string, dependencies:{discoverPi?:()=>ReturnType<typeof discoverPi>|Promise<ReturnType<typeof discoverPi>>;claudeSdk?:()=>ReturnType<typeof claudeSdkPackage>}={}) {
  const root = resolve(stateDir);
  const runRoot = join(root, 'runs');
  const worktreeRoot = join(root, 'worktrees');
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
  const registry = capabilitiesRegistry();
  let closed = false;
  let ticking: Promise<any> | undefined;
  const capabilityCache = new Map<string, { at: number; value: any }>();
  const launching = new Set<string>();
  let modelLaunches = 0;

  const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] };
  const actionDescriptors: ActionDescriptor[] = [
    descriptor('runtime.capabilities', 'List replaceable worker runtimes and current eligibility', ['owner','guide','worker','system'], { refresh:{type:'boolean'} }),
    descriptor('runtime.limits', 'Inspect provider allowance, context use, and task limits with provenance', ['owner','guide','worker','system'], { runtime:{type:'string'} }),
    descriptor('runtime.limit_set', 'Record supported runtime limit telemetry or an explicit unknown', ['owner','system'], { runtime:{type:'string'}, providerRemaining:nullableNumber, providerUnit:{type:'string'}, contextUsed:nullableNumber, contextCapacity:nullableNumber, taskTimeoutMs:nullableNumber, warningThreshold:{oneOf:[{type:'number'},{type:'null'},{type:'object',additionalProperties:false,properties:{providerRemaining:nullableNumber,contextRatio:nullableNumber}}]}, stopNewWork:{type:'boolean'}, source:{type:'string'}, observedAt:{type:'string'} }, ['runtime','source']),
    descriptor('runtime.start', 'Start one already-authorized task or deterministic capability run', ['owner','guide','system'], { taskId: {type:'string'}, runtime: {type:'string'}, runType: {enum:['technical','script','gui']}, capability: {type:'string'}, capabilityInput: {type:'object'}, cwd: {type:'string'}, deadline: {type:'string'}, resources:{type:'array',items:{type:'string'}}, worktree:{oneOf:[{type:'string'},{type:'boolean'}]} }, ['taskId']),
    descriptor('runtime.inspect', 'Inspect a durable run', ['owner','guide','worker','system'], { runId: {type:'string'} }, ['runId']),
    descriptor('runtime.events', 'Read persisted run events', ['owner','guide','worker','system'], { runId: {type:'string'}, after: {type:'integer'} }, ['runId']),
    descriptor('runtime.cancel', 'Request cancellation and report acknowledgement separately', ['owner','guide','system'], { runId: {type:'string'} }, ['runId']),
    descriptor('runtime.collect_result', 'Collect a completed run result and report it to its task', ['owner','guide','worker','system'], { runId: {type:'string'} }, ['runId']),
    descriptor('capability.list', 'List structured reusable local capabilities', ['owner','guide','worker','system'], { includeProposed:{type:'boolean'} }),
    descriptor('capability.propose', 'Propose a saved project procedure; it runs only after owner approval', ['owner','guide'], { name:{type:'string'}, projectId:{type:'string'}, description:{type:'string'}, command:{type:'string'}, args:{type:'array',items:{type:'string'}}, access:{enum:['read','write','network-read']}, sideEffects:{type:'array',items:{type:'string'}}, timeoutMs:{type:'integer'}, expectedRev:{type:'integer'} }, ['name','projectId','description','command','access','sideEffects','timeoutMs']),
    descriptor('capability.approve', 'Approve a proposed saved procedure revision', ['owner'], { name:{type:'string'}, expectedRev:{type:'integer'} }, ['name','expectedRev']),
    descriptor('capability.run', 'Start an owner-authorized or task-bound deterministic capability without model polling', ['owner','worker','system'], { capability: {type:'string'}, input: {type:'object'}, cwd: {type:'string'}, taskId: {type:'string'}, deadline: {type:'string'}, idempotencyKey:{type:'string'} }, ['capability']),
    descriptor('watch.create', 'Create a durable local Git ref or GitHub PR checks watch', ['owner','guide','system'], { projectId:{type:'string'}, kind:{enum:['git-ref','pr-checks']}, repository:{type:'string'}, ref:{type:'string'}, pr:{oneOf:[{type:'integer'},{type:'string'}]}, expectedCandidate:{type:'string'}, intervalMs:{type:'integer'}, expiresAt:{type:'string'} }, ['projectId','kind','repository']),
    descriptor('watch.list', 'List durable watches and their health', ['owner','guide','worker','system'], { projectId:{type:'string'} }),
    descriptor('watch.control', 'Pause, resume, or cancel a watch', ['owner','guide','system'], { watchId:{type:'string'}, command:{enum:['pause','resume','cancel']} }, ['watchId','command']),
    descriptor('watch.tick', 'Poll due watches deterministically', ['owner','system']),
    descriptor('run.changelog', 'Read plain-language run changelogs by project, task or run', ['owner','guide','worker','system'], { projectId:{type:'string'}, taskId:{type:'string'}, runId:{type:'string'}, limit:{type:'integer'} }),
    descriptor('execution.queue', 'List execution-specific queue reasons', ['owner','guide','worker','system'], { projectId:{type:'string'}, taskId:{type:'string'} }),
    descriptor('execution.tick', 'Dispatch eligible work and reconcile durable jobs without model polling', ['owner','system']),
    descriptor('execution.tick_profiles', 'Reconcile and dispatch only approved profile-runtime jobs from this candidate', ['system']),
    descriptor('worker.claude_auth', 'Owner approves or revokes Claude SDK use of the local claude.ai subscription', ['owner'], { decision:{enum:['approve','revoke']}, source:{type:'string'} }, ['decision','source']),
  ];
  const descriptorByName = new Map(actionDescriptors.map(item => [item.name, item]));

  function ensureOpen() { assert(!closed, 'Execution is closed'); }
  function authorize(action: string, actor: Actor) {
    const found = descriptorByName.get(action);
    assert(found, `Unknown execution action: ${action}`);
    assert(found.roles.includes(actor.role), `Role ${actor.role} cannot call ${action}`);
  }
  function requireRun(runId: string, actor: Actor): RunRecord {
    const run = store.require<RunRecord>('run', runId);
    if (actor.role === 'worker') {
      assert(actor.taskId && (run.taskId ?? run.parentTaskId) === actor.taskId, 'Worker is not bound to this task');
    }
    return run;
  }
  function updateRun(run: RunRecord, patch: Record<string, any>): RunRecord {
    const next = store.tx(() => {
      const current=store.require<RunRecord>('run',run.id);
      return store.put<RunRecord>('run', { ...current, ...patch }, current.rev);
    });
    if (['status','state','launchState','resultReported','error'].some(key => key in patch)) { try { saveRunChangelog(store, next.id, String(patch.status ?? patch.state ?? 'progress')); } catch {} }
    return next;
  }
  function runEvent(run: RunRecord, type: string, data: any, suffix = '') {
    return store.event(type, run.projectId ?? null, { runId: run.id, taskId: run.taskId, ...data }, suffix ? `${run.id}:${type}:${suffix}` : undefined);
  }

  async function commandStatus(command: string, args: string[], timeout = 5000): Promise<{ ok: boolean; stdout: string; reason?: string }> {
    try {
      const result = await execFileAsync(command, args, { timeout, env: cleanEnvironment(), maxBuffer: 1024 * 1024 });
      return { ok: true, stdout: [result.stdout,result.stderr].map(value=>String(value??'').trim()).filter(Boolean).join('\n') };
    } catch (error: any) {
      return { ok: false, stdout: [error?.stdout,error?.stderr].map(value=>String(value??'').trim()).filter(Boolean).join('\n'), reason: safeError(error) };
    }
  }

  function localCodexModels(): Array<{ id: string; displayName?: string; description?: string; reasoningEfforts: Array<{ effort: string; description?: string }>; contextWindow?:number }> {
    const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
    try {
      const models = JSON.parse(readFileSync(path, 'utf8'))?.models;
      if (!Array.isArray(models)) return [];
      return models.filter((model: any) => typeof model?.slug === 'string' && model.visibility === 'list')
        .map((model: any) => ({ id: model.slug, contextWindow:typeof model.context_window==='number'?model.context_window:undefined, displayName: typeof model.display_name === 'string' ? model.display_name : undefined, description: typeof model.description === 'string' ? model.description : undefined, reasoningEfforts: Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter((entry: any) => typeof entry?.effort === 'string').map((entry: any) => ({ effort: entry.effort, description: typeof entry.description === 'string' ? entry.description : undefined })) : [] }));
    } catch { return []; }
  }

  async function runtimeCapabilities(force = false): Promise<any[]> {
    const cached = capabilityCache.get('runtimes');
    if (!force && cached && Date.now() - cached.at < 30_000) return cached.value;
    const [codex, codexVersion, claude, claudeVersion, pi, piVersion] = await Promise.all([
      commandStatus('codex', ['login','status']),
      commandStatus('codex', ['--version']),
      commandStatus('claude', ['auth','status']),
      commandStatus('claude', ['--version']),
      commandStatus('pi', ['--list-models','openai-codex']),
      commandStatus('pi', ['--version']),
    ]);
    const codexEligible = codex.ok && /Logged in using ChatGPT/i.test(codex.stdout);
    let claudeStatus: any = {};
    try { claudeStatus = JSON.parse(claude.stdout); } catch {}
    const claudeMethod = String(claudeStatus.authMethod ?? claudeStatus.subscriptionType ?? '');
    const claudeEligible = claude.ok && claudeStatus.loggedIn === true && /claudeai|claude\.ai|subscription|oauth/i.test(claudeMethod) && !/console|api/i.test(claudeMethod);
    const piDiscovery=await (dependencies.discoverPi??discoverPi)();
    const piEligible=piDiscovery.authKind==='subscription'&&piDiscovery.availableModels.length>0;
    const result: any[] = [
      { name:'script', version:1, available:true, eligible:true, access:'local process', capabilities:['start','inspect','events','cancel','collect_result'], usage:{providerAllowance:'not_applicable',taskLimit:'bounded'} },
      { name:'codex', provider:'openai',authRoute:'subscription',adapter:'codex-cli',version:1, available:codexVersion.ok, installedVersion:codexVersion.ok?codexVersion.stdout:undefined, eligible:codexEligible, access:codexEligible?'ChatGPT login':'unavailable', reason:codexEligible?undefined:'Official Codex CLI is not confirmed logged in using ChatGPT', capabilities:['start','inspect','events','cancel','collect_result'], defaults:{sandbox:'read-only'}, models:localCodexModels(), usage:{providerAllowance:'unknown',contextCapacity:'unknown'} },
      { name:'claude', provider:'anthropic',authRoute:'subscription',version:1, available:claudeVersion.ok, installedVersion:claudeVersion.ok?claudeVersion.stdout:undefined, eligible:claudeEligible, access:claudeEligible?'claude.ai subscription':'unavailable', reason:claudeEligible?undefined:'Official Claude CLI is installed but not confirmed authenticated through a claude.ai subscription', capabilities:['start','inspect','events','cancel','collect_result'], defaults:{permissionMode:'plan'}, models:claudeModels(), usage:{providerAllowance:'unknown',contextCapacity:'unknown'} },
      { name:'pi', provider:'openai',authRoute:'subscription',adapter:'pi-sdk',version:1, available:piDiscovery.installed, installedVersion:piDiscovery.version, eligible:piEligible, access:piEligible?'openai-codex OAuth':'unavailable', reason:piEligible?undefined:piDiscovery.reason??'Pi requires its own supported openai-codex login', capabilities:['start','inspect','events','cancel','collect_result'], models:piDiscovery.availableModels.map(m=>({...m,reasoningEfforts:m.thinkingSupport.map(effort=>({effort}))})), defaults:{extensions:false,skills:false,contextFiles:false}, usage:{providerAllowance:'unknown',contextCapacity:'unknown'} },
      { name:'codex-app', version:1, available:true, eligible:false, access:'app-driven session required', reason:'Supported native task dispatch has not been proven', capabilities:['await_session'], usage:{providerAllowance:'unknown',contextCapacity:'unknown'} },
    ];
    const codexProfile = result.find(item => item.name === 'codex')!;
    result.push({ name:CODEX_PROFILE_RUNTIME, adapter:'codex-sdk',version:1, available:codexProfile.available, eligible:codexProfile.eligible, access:codexProfile.access, reason:codexProfile.reason, capabilities:codexProfile.capabilities, models:codexProfile.models, profileRuntime:'codex', defaults:{profile:'task.budget.workerProfile'}, usage:codexProfile.usage });
    const piProfile=result.find(item=>item.name==='pi')!;
    result.push({...piProfile,name:'pi-profile',profileRuntime:'pi',defaults:{profile:'task.budget.workerProfile'}});
    const claudeSdk=(dependencies.claudeSdk??claudeSdkPackage)(),authorization=claudeAuthorization(store);
    const claudeProfileReason=!claudeSdk.available?claudeSdk.reason??'Claude Agent SDK package is not installed':!claudeEligible?'Claude login is not confirmed as a claude.ai subscription':!authorization?'Owner has not authorized Wimzo workers to use the Claude subscription route':undefined;
    result.push({ name:CLAUDE_PROFILE_RUNTIME, provider:'anthropic', authRoute:'subscription', adapter:'claude-sdk', version:1, available:claudeSdk.available, installedVersion:claudeSdk.version, eligible:claudeProfileReason===undefined, access:claudeProfileReason===undefined?'claude.ai subscription (owner authorized)':'unavailable', reason:claudeProfileReason, capabilities:['start','inspect','events','cancel','collect_result'], profileRuntime:'claude', models:claudeModels(), modelSource:'local-metadata', authorization:authorization?{route:authorization.route,scope:authorization.scope,paidApi:false,actor:authorization.actor,at:authorization.at}:null, defaults:{profile:'task.budget.workerProfile',sandbox:'required'}, usage:{providerAllowance:'unknown',contextCapacity:'unknown'} });
    const withLimits=result.map(item=>{const limitRuntime=isProfileRuntime(item.name)?item.profileRuntime:item.name; return {...item,limits:store.get<any>('runtime_limit',limitRuntime)??{runtime:limitRuntime,provider:{status:'unknown'},context:{status:'unknown'},task:{status:'unknown'},source:'unavailable',observedAt:null}}});
    capabilityCache.set('runtimes', { at: Date.now(), value: withLimits });
    return withLimits;
  }

  function limitReached(limit:any):boolean {
    if(!limit) return false;
    if(limit.stopNewWork===true) return true;
    if(limit.provider?.status==='known'&&typeof limit.provider.remaining==='number'&&typeof limit.warningThreshold?.providerRemaining==='number'&&limit.provider.remaining<=limit.warningThreshold.providerRemaining) return true;
    if(limit.context?.status==='known'&&typeof limit.context.used==='number'&&typeof limit.context.capacity==='number'&&limit.context.capacity>0) {
      return limit.context.used/limit.context.capacity>=Number(limit.warningThreshold?.contextRatio??0.9);
    }
    return false;
  }

  async function git(args: string[], cwd: string): Promise<string> {
    const result = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: cleanEnvironment() });
    return String(result.stdout).trim();
  }

  function taskRepository(task: any): string {
    const root = realpathSync(store.require<any>('project', task.projectId).root);
    for (const supplied of [task.repository, task.worktree?.repository]) {
      if (supplied !== undefined) assert(realpathSync(resolve(supplied)) === root, 'Repository differs from the owning canonical project');
    }
    return root;
  }
  function defaultWorktree(task: any, repository: string): string {
    const established = join(worktreeRoot, task.id);
    return within(repository, established) ? established : join(repository, '.wimzo', 'worktrees', task.id);
  }

  function resolvedPath(path: string): string {
    let ancestor = resolve(path);
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      // Reject dangling symlinks as well as symlinks pointing outside the project.
      try { assert(!lstatSync(ancestor).isSymbolicLink(), 'Worktree contains a dangling symlink'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    return resolve(realpathSync(ancestor), ...suffix);
  }

  function approvedTimeout(task: any, runtime: string): number {
    const bounds = [task.budget?.maxExecutionMs, task.budget?.maxRuntimeMs, task.budget?.timeoutMs,
      store.get<any>('runtime_limit', runtime)?.task?.timeoutMs].filter(value => value !== undefined);
    assert(bounds.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0), 'Execution budget must be a finite positive duration');
    return Math.min(...(bounds.length ? bounds : [30 * 60_000]), 24 * 60 * 60_000);
  }

  function remainingExecutionBudget(task: any, runtime: string): number {
    const budget = approvedTimeout(task, runtime);
    const current = Date.now();
    const consumed = store.list<RunRecord>('run').filter(run => run.taskId === task.id).reduce((total, run) => {
      const started = Date.parse(String(run.startedAt ?? ''));
      if (!Number.isFinite(started)) return total;
      const completed = Date.parse(String(run.finishedAt ?? run.endedAt ?? ''));
      // A run without a durable finish is conservatively charged through now.
      const stopped = Number.isFinite(completed) ? Math.min(completed, current) : current;
      return total + Math.max(0, stopped - started);
    }, 0);
    assert(consumed < budget, 'Execution budget is exhausted; do not resume without a new owner authorization');
    return budget - consumed;
  }

  function assertPolicy(task:any,runtime:string) {
    const selected=isProfileRuntime(runtime)?profileForTask(task):null;
    const codingRuntime=selected?.runtime??runtime;
    if(['codex','claude','pi'].includes(codingRuntime))validateExecutionPolicy(store,task.projectId,{harness:codingRuntime,provider:runtimeProvider(codingRuntime),authRoute:'subscription',model:selected?.model??(codingRuntime==='codex'?'gpt-5.6-luna':undefined)});
  }

  function policyDenial(task:any,runtime:string):string|undefined {
    try { assertPolicy(task,runtime); return undefined; } catch(error) { return `policy_denied:${runtime}:${safeError(error)}`; }
  }

  function selectRuntime(task:any,runtimes:any[]):string {
    if(task.runtime) return String(task.runtime);
    if(task.runType==='script') return 'script';
    const eligible=['pi','codex'].filter(name=>runtimes.some(item=>item.name===name&&item.eligible));
    return eligible.find(name=>!policyDenial(task,name))??eligible[0]??'codex';
  }

  async function validateLaunchBoundary(task: any, input: Record<string, any>, runtime: string, runType: RunRecord['runType']) {
    assertTechnicalTask(task);
    if (isProfileRuntime(runtime)) {
      const profile = profileForTask(task);
      const capability = (await runtimeCapabilities()).find(item => item.name === runtime);
      assert(capability?.eligible, capability?.reason ? `Selected worker profile is not supported by the current local runtime: ${capability.reason}` : 'Selected worker profile is not supported by the current local runtime');
      const global = store.get<any>('execution_limits', 'global');
      assert(!global?.blockedRuntimes?.includes(profile.runtime) && !global?.blockedRuntimes?.includes(runtime), 'Selected worker profile is blocked by execution limits');
      assert(!limitReached(store.get<any>('runtime_limit', profile.runtime)), 'Selected worker profile is paused by its runtime limit');
      if (profile.source === 'codex-default') assert(profile.runtime==='codex'&&profile.model === undefined && profile.thinking === undefined, 'Codex default profile cannot override model or thinking');
      else {
        const model = capability.models?.find((item: any) => item.id === profile.model);
        assert(model && (profile.thinking === undefined || model.reasoningEfforts.some((entry: any) => (typeof entry === 'string' ? entry : entry?.effort) === profile.thinking)), 'Selected worker profile is not supported by current local model metadata');
      }
    }
    assertPolicy(task,runtime);
    if (task.runtime) assert(runtime === task.runtime, 'Runtime differs from the approved task');
    assert(input.resources === undefined || canonicalJson(input.resources) === canonicalJson(task.resources ?? []), 'Resources differ from the approved task');
    assert(input.worktree === undefined || canonicalJson(input.worktree) === canonicalJson(task.worktree), 'Worktree differs from the approved task');
    assert(input.deadline === undefined || input.deadline === task.deadline, 'Deadline differs from the approved task');
    const repository = taskRepository(task);
    if (task.deadline !== undefined) assert(typeof task.deadline === 'string' && Number.isFinite(Date.parse(task.deadline)) && Date.parse(task.deadline) > Date.now(), 'Execution deadline is invalid or expired');
    const deadline = new Date(Math.min(task.deadline ? Date.parse(task.deadline) : Infinity, Date.now() + remainingExecutionBudget(task, runtime))).toISOString();
    const isolated = runType === 'technical' && task.worktree !== false;
    assert(runType !== 'technical' || !allowsWrite(task.permissions) || isolated, 'Technical writer requires an isolated worktree');
    const cwd = isolated ? resolvedPath(typeof task.worktree === 'string' ? task.worktree : defaultWorktree(task, repository))
      : typeof task.worktree === 'string' ? resolvedPath(task.worktree) : repository;
    assert(within(repository, cwd), 'Approved worktree is outside the task project');
    assert(!isolated || cwd !== repository, 'Technical worktree must be isolated from the canonical checkout');
    assert(input.cwd === undefined || resolvedPath(String(input.cwd)) === cwd, 'Working directory differs from the approved task');
    let candidate: string | undefined;
    const resolvedWorkflowSource=runType==='technical'?await workflowSource(store,task,repository):null;
    if (runType === 'technical') {
      const source = resolvedWorkflowSource?.commit ?? task.sourceCandidate?.commit ?? task.sourceCandidate?.sha ?? task.sourceCandidate?.id;
      assert(typeof source === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(source), 'Technical task requires an exact sourceCandidate commit');
      candidate = await git(['rev-parse', '--verify', `${source}^{commit}`], repository);
      assert(candidate.toLowerCase() === source.toLowerCase(), 'sourceCandidate must identify the exact commit');
      if (existsSync(cwd)) {
        assert(statSync(cwd).isDirectory(), 'Approved worktree is not a directory');
        assert(realpathSync(await git(['rev-parse', '--show-toplevel'], cwd)) === cwd, 'Approved worktree must be a repository root');
        const common = realpathSync(resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd)));
        const owningCommon = realpathSync(resolve(repository, await git(['rev-parse', '--git-common-dir'], repository)));
        assert(common === owningCommon, 'Worktree repository differs from the owning canonical project');
        assert(await git(['rev-parse', 'HEAD'], cwd) === candidate, 'Existing worktree does not match approved sourceCandidate');
      } else assert(isolated, 'Approved working directory is unavailable');
    } else if (runType === 'script') {
      assert(existsSync(cwd) && statSync(cwd).isDirectory(), 'Approved script worktree is unavailable');
    }
    return { repository, cwd, candidate, isolated, deadline, resolvedWorkflowSource };
  }

  async function prepareWorktree(plan: { repository: string; cwd: string; candidate?: string }) {
    assert(plan.candidate, 'Exact sourceCandidate is required for a writer worktree');
    if (!existsSync(plan.cwd)) await execFileAsync('git', ['worktree', 'add', '--detach', plan.cwd, plan.candidate], { cwd:plan.repository, timeout:60_000, env:cleanEnvironment() });
    const dependencySetup=prepareWorkerDependencies({worktree:plan.cwd,canonicalProject:plan.repository,runtimeCheckout:resolve(import.meta.dirname,'..')});
    return { cwd:plan.cwd, candidate:plan.candidate, worktree:plan.cwd, dependencySetup };
  }

  function pathsFor(runId: string) {
    const directory = join(runRoot, runId);
    mkdirSync(directory, { recursive:true, mode:0o700 });
    return { stdout:join(directory,'stdout.log'), stderr:join(directory,'stderr.log'), status:join(directory,'status.json'), result:join(directory,'result.json') };
  }

  async function reserveRun(base: Partial<RunRecord> & { runtime: string; runType: RunRecord['runType'] }, existing?: RunRecord): Promise<RunRecord> {
    const runId = existing?.id ?? base.id ?? id('run');
    const paths = pathsFor(runId);
    const launchKey = existing?.launchKey ?? base.launchKey ?? hash(`${runId}:${base.taskId ?? ''}:${base.runtime}`);
    const created = store.put<RunRecord>('run', {
      ...(existing ?? {}), ...base, id:runId, runtime:base.runtime, runType:base.runType,
      adapterVersion:1, status:base.status ?? 'reserved', launchState:'reserved', launchKey,
      createdAt:existing?.createdAt ?? now(), paths, usage:{ providerAllowance:'unknown', contextCapacity:'unknown', taskLimit:'bounded', ...(base.usage ?? {}) },
    }, existing?.rev);
    launching.add(created.id);
    runEvent(created, 'run.reserved', { runtime:created.runtime, runType:created.runType }, launchKey);
    return created;
  }

  async function launchProcess(run: RunRecord, command: string, args: string[], cwd: string, env = cleanEnvironment()): Promise<RunRecord> {
    assert(run.paths, 'Run paths are missing');
    assert(run.launchState === 'reserved', 'Run has already crossed its launch fence');
    const fence = join(dirname(run.paths.status), 'launch.fence');
    let fenceFd: number;
    try { fenceFd = openSync(fence, 'wx', 0o600); } catch { throw new Error('Run launch is already fenced'); }
    closeSync(fenceFd);
    const fenced = updateRun(run, { launchState:'fenced', command, args, cwd });
    atomicJson(run.paths.status, { state:'launching', fencedAt:now() });
    launching.delete(run.id);
    try {
      const payload = JSON.stringify({ command, args, cwd, env, deadline:run.deadline, stdout:run.paths.stdout, stderr:run.paths.stderr, status:run.paths.status });
      const child = spawn(process.execPath, ['-e', WRAPPER, payload], { detached:true, stdio:'ignore', env:cleanEnvironment() });
      child.unref();
      if (['pi','codex','claude'].includes(profileBaseRuntime(run.runtime))) modelLaunches++;
      const launched = updateRun(fenced, { status:'running', launchState:'launched', pid:child.pid, processGroupId:child.pid, startedAt:now() });
      runEvent(launched, 'run.started', { pid:child.pid, command:basename(command) }, launched.launchKey);
      return launched;
    } catch (error) {
      const failed = updateRun(fenced, { status:'failed', launchState:'failed-before-launch', error:safeError(error), finishedAt:now() });
      runEvent(failed, 'run.failed', { error:failed.error }, failed.launchKey);
      return failed;
    }
  }

  function promptFor(task: any): string {
    return [
      `Task ${task.id}`,
      `Objective: ${task.objective}`,
      `Requirements: ${JSON.stringify(task.requirements ?? [])}`,
      `Acceptance criteria: ${JSON.stringify(task.criteria ?? [])}`,
      `Scope: ${JSON.stringify(task.scope ?? {})}`,
      `Permissions: ${JSON.stringify(task.permissions ?? {})}`,
      `Specification: ${task.specId}@${task.specHash}`,
      `Source candidate: ${JSON.stringify(task.sourceCandidate ?? null)}`,
      ...(isProfileRuntime(task.runtime) ? ['Work in two real phases: plan the selected scope, then implement it. If the chat tool `board.phase` is available, report a phase only when it actually begins. Do not fabricate timer-based stages. A run may remain Running until a real phase report or completion.'] : []),
      'Stay within this approved scope. Preserve unrelated work. Report a concise summary, checks, artifacts, unresolved questions, usage if available, and an exit reason.',
      ...(allowsWrite(task.permissions)&&!task.workflow?.featureId ? ['Before exiting, commit only your intended changes and leave the worktree clean. Uncommitted changes pause the task instead of being collected.'] : []),
    ].join('\n');
  }

  async function startClaimed(task: any, run: RunRecord, input: Record<string, any>, plan: Awaited<ReturnType<typeof validateLaunchBoundary>>): Promise<RunRecord> {
    const runtime = String(input.runtime);
    const runType = input.runType as RunRecord['runType'];
    assert(Date.parse(plan.deadline) > Date.now(), 'Execution deadline expired before reservation');
    const reserved = await reserveRun({ ...run, taskId:task.id, projectId:task.projectId, runtime, runType, deadline:plan.deadline, ...(isProfileRuntime(runtime) ? { workerProfile: profileForTask(task) } : {}) }, run);
    if (runtime === 'codex-app') {
      const waiting = updateRun(reserved, { status:'awaiting_session', launchState:'awaiting-session', waitingReason:'A supported native Codex desktop session must explicitly claim this task' });
      runEvent(waiting, 'run.awaiting_session', { reason:waiting.waitingReason }, waiting.launchKey);
      return waiting;
    }
    if (plan.isolated) {
      const prepared = await prepareWorktree(plan);
      const updated = updateRun(reserved, { worktree:prepared.worktree, sourceCandidate:prepared.candidate, resolvedWorkflowSource:plan.resolvedWorkflowSource, dependencySetup:prepared.dependencySetup });
      return startRuntimeProcess(task, updated, runtime, prepared.cwd, input);
    }
    return startRuntimeProcess(task, reserved, runtime, plan.cwd, input);
  }

  function resumableSession(task:any,run:RunRecord,baseRuntime:string,model:string|undefined,cwd:string):{runId:string;sessionId:string}|undefined {
    if(!['codex','claude'].includes(baseRuntime)) return undefined;
    const prior=store.list<RunRecord>('run').filter(item=>item.taskId===task.id&&item.id!==run.id).at(-1);
    if(!prior?.sdkSessionId||prior.status!=='paused'||prior.needsContinuation||prior.launchState==='outcome-unknown'||prior.resumeBlockedReason) return undefined;
    if(profileBaseRuntime(prior.runtime)!==baseRuntime||(prior.model??undefined)!==model||prior.cwd!==cwd) return undefined;
    return {runId:prior.id,sessionId:String(prior.sdkSessionId)};
  }

  async function startRuntimeProcess(task: any, run: RunRecord, runtime: string, cwd: string, input: Record<string, any>): Promise<RunRecord> {
    const caps = await runtimeCapabilities();
    const cap = caps.find(item => item.name === runtime);
    assert(cap?.eligible, cap?.reason ?? `Runtime ${runtime} is unavailable`);
    const baseRuntime = profileBaseRuntime(runtime);
    if (isProfileRuntime(runtime)) {
      const profile=profileForTask(task);
      const folder=dirname(run.paths!.status);
      const configPath=join(folder,'sdk-config.json');
      const metadata=cap.models?.find((item:any)=>item.id===profile.model);
      const approvedClaudeAuth=baseRuntime==='claude'&&claudeAuthorization(store)!==undefined;
      assert(baseRuntime!=='claude'||approvedClaudeAuth,'Owner authorization for the Claude subscription route is missing or revoked');
      const claudeExecutable=baseRuntime==='claude'&&process.env.WIMZO_CLAUDE_EXECUTABLE&&isAbsolute(process.env.WIMZO_CLAUDE_EXECUTABLE)?{claudeExecutable:process.env.WIMZO_CLAUDE_EXECUTABLE}:{};
      const permissionPaths={gitCommonDir:resolvedPath(resolve(cwd,await git(['rev-parse','--git-common-dir'],cwd))),gitWorktreeDir:resolvedPath(resolve(cwd,await git(['rev-parse','--git-dir'],cwd))),runtimeReadPaths:[...nodeRuntimeReadPaths(),...(baseRuntime==='codex'?codexRuntimeReadPaths():[]),...(run.dependencySetup?.dependencyRoot?[run.dependencySetup.dependencyRoot]:[])]};
      const resumed=resumableSession(task,run,baseRuntime,profile.model,cwd);
      const config={stateDir,taskId:task.id,runId:run.id,runtime:baseRuntime,cwd,...(resumed?{sessionId:resumed.sessionId}:{}),model:profile.model,thinking:profile.thinking,write:allowsWrite(task.permissions),env:cleanEnvironment(),permissionPaths,sourceCandidate:run.resolvedWorkflowSource?{id:run.resolvedWorkflowSource.commit,specHash:task.specHash}:task.sourceCandidate,originalSourceCandidate:task.sourceCandidate,contextPolicy:task.budget?.context,...(baseRuntime==='claude'?{maxTurns:claudeMaxTurns(task.budget?.maxTurns)}:{}),contextCapacity:metadata?.contextWindow,sessionDir:join(folder,'session'),resultFile:join(folder,'sdk-result.json'),...(approvedClaudeAuth?{approvedClaudeAuth:true}:{}),...claudeExecutable};
      atomicJson(configPath,config);
      const prepared=updateRun(run,{adapter:`${baseRuntime}-sdk`,workerProfile:profile,provider:runtimeProvider(baseRuntime),model:profile.model??null,thinking:profile.thinking??null,sdkConfigPath:configPath,resumedSession:resumed??null});
      return launchProcess(prepared,process.execPath,[resolve(import.meta.dirname,'../scripts/sdk-worker.ts'),configPath],cwd);
    }
    if (baseRuntime === 'codex') {
      const write = allowsWrite(task.permissions);
      const profile = isProfileRuntime(runtime) ? profileForTask(task) : undefined;
      const profileArgs = profile ? [
        ...(profile.thinking ? ['-c', `model_reasoning_effort=${JSON.stringify(profile.thinking)}`] : []),
        ...(profile.model ? ['--model', profile.model] : []),
      ] : ['-c','model_reasoning_effort="low"','--model','gpt-5.6-luna'];
      const args = ['exec','--ignore-user-config','--ephemeral','-c','forced_login_method="chatgpt"',...profileArgs,'--json','--sandbox',write?'workspace-write':'read-only','-C',cwd,promptFor(task)];
      return launchProcess(run, 'codex', args, cwd);
    }
    if (baseRuntime === 'claude') {
      const write = allowsWrite(task.permissions);
      assert(!write,'Claude write execution is unavailable until a containment boundary is verified');
      const args = ['-p','--output-format','json','--permission-mode','plan','--permission-prompts','none',promptFor(task)];
      return launchProcess(run, 'claude', args, cwd);
    }
    if (baseRuntime === 'pi') {
      const write = allowsWrite(task.permissions);
      assert(!write,'Pi write execution is unavailable until a containment boundary is verified');
      const args = ['--provider','openai-codex','--model','gpt-5.6-luna','--thinking','low','--tools','read,grep,find,ls','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--offline','--no-session','--mode','json','--print',promptFor(task)];
      return launchProcess(run, 'pi', args, cwd);
    }
    if (runtime === 'script') {
      assert(task.capability, 'Script runtime requires an approved task capability');
      return startCapability(task.capability, task.capabilityInput ?? {}, cwd, { run, taskId:task.id, projectId:task.projectId, approvedTaskRev:task.rev, deadline:run.deadline });
    }
    throw new Error(`Unknown runtime: ${runtime}`);
  }

  function procedureCapability(procedure: Procedure): Capability {
    return { name:procedure.id, version:procedure.rev, description:procedure.description, command:procedure.command, access:procedure.access, sideEffects:procedure.sideEffects, timeoutMs:procedure.timeoutMs, retry:'never', projectId:procedure.projectId, source:'saved', args:input => { assert(input.args===undefined||canonicalJson(input.args)===canonicalJson(procedure.args),'Saved procedures run only their approved arguments'); return procedure.args; } };
  }
  function capabilityFor(name: string): Capability | undefined {
    const builtIn = registry.get(name);
    if (builtIn) return builtIn;
    const procedure = store.get<Procedure>('capability_procedure', name);
    assert(!procedure || procedure.status === 'approved', `Saved procedure ${name} is not approved`);
    return procedure && procedureCapability(procedure);
  }
  function proposeProcedure(input: Record<string, any>, actor: Actor): Procedure {
    const name = String(input.name ?? '');
    assert(/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name), 'Procedure name must be 2-64 lowercase letters, digits, dots, dashes or underscores');
    assert(!registry.has(name), `Procedure name ${name} is reserved by a built-in capability`);
    const project = store.require<any>('project', String(input.projectId));
    const text = (value: unknown, label: string, limit: number) => { assert(typeof value === 'string' && value.trim() && value.length <= limit && !value.includes('\0'), `${label} is required and bounded`); return value.trim(); };
    const command = text(input.command, 'command', 1_000);
    assert(!/[\r\n]/.test(command) && (isAbsolute(command) || /^[A-Za-z0-9._+-]+$/.test(command)), 'command must be an executable name or absolute path without shell syntax');
    assert(['read','write','network-read'].includes(input.access), 'access must be read, write or network-read');
    assert(Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= MAX_PROCEDURE_TIMEOUT_MS, `timeoutMs must be a positive integer up to ${MAX_PROCEDURE_TIMEOUT_MS}`);
    const sideEffects = stringArray(input.sideEffects, 'sideEffects');
    const previous = store.get<Procedure>('capability_procedure', name);
    assert(!previous || previous.projectId === project.id, 'Procedure belongs to another project');
    assert(!previous || input.expectedRev === previous.rev, 'Procedure changed; supply its current expectedRev');
    const value = store.put<Procedure>('capability_procedure', { id:name, projectId:project.id, description:text(input.description,'description',2_000), command, args:stringArray(input.args), access:input.access, sideEffects, timeoutMs:input.timeoutMs, status:'proposed', proposedBy:{id:actor.id,role:actor.role,at:now()}, approvedBy:undefined }, previous?.rev);
    store.event('capability.proposed', project.id, { name, rev:value.rev, command, args:value.args, access:value.access, sideEffects, timeoutMs:value.timeoutMs, actor:{id:actor.id,role:actor.role} }, `capability-proposed:${name}:${value.rev}`);
    return value;
  }
  function approveProcedure(input: Record<string, any>, actor: Actor): Procedure {
    const procedure = store.require<Procedure>('capability_procedure', String(input.name));
    assert(procedure.status === 'proposed', 'Procedure is already approved');
    assert(input.expectedRev === procedure.rev, 'Procedure changed; review and approve its current revision');
    const value = store.put<Procedure>('capability_procedure', { ...procedure, status:'approved', approvedBy:{id:actor.id,role:actor.role,at:now()} }, input.expectedRev);
    store.event('capability.approved', procedure.projectId, { name:value.id, rev:value.rev, proposedRev:procedure.rev, actor:{id:actor.id,role:actor.role} }, `capability-approved:${value.id}:${value.rev}`);
    return value;
  }

  async function startCapability(name: string, input: Record<string, any>, cwdInput?: string, options: any = {}): Promise<RunRecord> {
    const capability = capabilityFor(name);
    assert(capability, `Unknown capability: ${name}`);
    const cwd = resolve(cwdInput ?? process.cwd());
    assert(existsSync(cwd) && statSync(cwd).isDirectory(), 'Capability working directory is unavailable');
    if (capability.projectId) {
      assert(!options.projectId || options.projectId === capability.projectId, 'Saved procedure belongs to another project');
      assert(within(realpathSync(store.require<any>('project', capability.projectId).root), realpathSync(cwd)), 'Saved procedure working directory is outside its project');
    }
    const args = capability.args(input);
    const capabilityDefinitionHash=hash(canonicalJson({name:capability.name,version:capability.version,command:capability.command,access:capability.access,sideEffects:capability.sideEffects,timeoutMs:capability.timeoutMs,retry:capability.retry}));
    const capabilityInputHash=hash(canonicalJson(input));
    if (name === 'node.test') {
      for(let index=1;index<args.length;index++) {
        const file=resolve(cwd,args[index]);
        assert(within(cwd,file),'Node test file must be inside its working directory');
        assert(existsSync(file),'Node test file does not exist');
        args[index]=file;
      }
    }
    const deadline = options.deadline ?? input.deadline ?? new Date(Date.now() + capability.timeoutMs).toISOString();
    assert(Date.parse(deadline) > Date.now(), 'Execution deadline must be in the future');
    const existing = options.run as RunRecord | undefined;
    const capabilityScope={actor:options.actorId??null,parentTaskId:options.parentTaskId??null,parentRunId:options.parentRunId??null,projectId:options.projectId??null};
    const requestKey = options.idempotencyKey ? hash(canonicalJson({capability:name,key:options.idempotencyKey,scope:capabilityScope})) : undefined;
    if (!existing && requestKey) {
      const prior=store.list<RunRecord>('run').find(item=>item.launchKey===requestKey);
      if (prior) {
        assert(prior.capabilityInputHash===capabilityInputHash&&prior.cwd===cwd&&canonicalJson(prior.capabilityScope)===canonicalJson(capabilityScope),'Idempotency key was already used for different capability input');
        return reconcileRun(prior);
      }
    }
    const run = existing ?? await reserveRun({ taskId:options.taskId, parentTaskId:options.parentTaskId,parentRunId:options.parentRunId,capabilityScope, projectId:options.projectId, runtime:'script', runType:'script', deadline, capability:name, capabilityVersion:capability.version, capabilityDefinitionHash, capabilityInputHash, approvedTaskRev:options.approvedTaskRev, launchKey:requestKey });
    const prepared = existing ? updateRun(existing, { capability:name, capabilityVersion:capability.version, capabilityDefinitionHash, capabilityInputHash, approvedTaskRev:options.approvedTaskRev, deadline, runtime:'script', runType:'script' }) : run;
    return launchProcess(prepared, capability.command, args, cwd);
  }

  async function claimAndStart(task: any, input: Record<string, any>, actor: Actor): Promise<RunRecord> {
    const runtimeOptions=await runtimeCapabilities();
    const runtime = selectRuntime(task,runtimeOptions);
    assert(input.runtime === undefined || input.runtime === runtime, 'Runtime differs from the approved task selection');
    const requiredRunType=runtime==='script'?'script':runtime==='codex-app'?'gui':'technical';
    assert(!input.runType||input.runType===requiredRunType,`Runtime ${runtime} requires runType ${requiredRunType}`);
    const runType = requiredRunType;
    const plan = await validateLaunchBoundary(task, input, runtime, runType);
    const workerId = `execution:${task.id}`;
    const claimed = domain.call('task.claim', { taskId:task.id, expectedRev:task.rev, runtime, runType, resources:task.resources, worktree:task.worktree, workerId }, { role:'system', id:actor.id });
    assert(claimed.claimed !== false, `Task is waiting: ${(claimed.reasons ?? []).join(', ')}`);
    const claimedTask = claimed.task ?? store.require('task', task.id);
    const domainRun = claimed.run ?? store.list<RunRecord>('run').filter(item => item.taskId === task.id).at(-1);
    assert(domainRun, 'Domain did not create a run for the claim');
    launching.add(domainRun.id);
    try { return await startClaimed(claimedTask, domainRun, { ...input, runtime, runType }, plan); }
    catch (error) {
      let failed = store.require<RunRecord>('run', domainRun.id);
      failed = updateRun(failed, { status:'failed', error:safeError(error), finishedAt:now(), launchState:failed.launchState ?? 'not-launched' });
      runEvent(failed, 'run.failed', { error:failed.error }, failed.launchKey ?? failed.id);
      try { stopTask(failed,'block',`Runtime could not start: ${failed.error}`,'execution-start',{runId:failed.id,summary:'Runtime could not start',error:failed.error,logs:failed.paths}); } catch {}
      throw error;
    }
    finally { launching.delete(domainRun.id); }
  }

  function orphanedLaunch(run:RunRecord):boolean {
    const started=Date.parse(String(run.createdAt??run.startedAt??''));
    return !launching.has(run.id)&&Number.isFinite(started)&&Date.now()-started>LAUNCH_GRACE_MS;
  }

  function interruptLaunch(run:RunRecord,reason:string):RunRecord {
    const interrupted=updateRun(run,{status:'paused',launchState:'outcome-unknown',finishedAt:now(),error:reason});
    runEvent(interrupted,'run.interrupted',{reason},interrupted.launchKey??interrupted.id);
    return interrupted;
  }

  async function reconcileRun(runInput: RunRecord): Promise<RunRecord> {
    let run = store.require<RunRecord>('run', runInput.id);
    if(run.runtime==='codex-app'&&run.taskId) {
      const task=store.require<any>('task',run.taskId);
      if(!task.requested&&['pause','takeover'].includes(task.acknowledged?.command)&&run.status!=='paused') run=updateRun(run,{status:'paused',launchState:'native-paused'});
      if(!task.requested&&task.acknowledged?.command==='cancel'&&run.status!=='canceled') run=updateRun(run,{status:'canceled',launchState:'native-canceled',finishedAt:run.finishedAt??now(),cancellationAcknowledged:true,cancellationAcknowledgedAt:now()});
      return run;
    }
    if (!run.paths) return run.status===undefined&&run.state==='Running'&&run.workerId===`execution:${run.taskId}`&&orphanedLaunch(run)?interruptLaunch(run,'Service stopped before the run was reserved; launch will not be replayed'):run;
    const status = jsonFile(run.paths.status);
    if (!status && run.status==='reserved' && run.launchState==='reserved' && orphanedLaunch(run)) return interruptLaunch(run,'Service stopped before the launch fence; launch will not be replayed');
    if (status?.state === 'running' && !['completed','failed','canceled','paused'].includes(run.status)) {
      if (status.wrapperPid) run = updateRun(run, { status:'running', launchState:'launched', pid:status.wrapperPid, processGroupId:status.wrapperPid, childPid:status.pid, startedAt:status.startedAt ?? run.startedAt });
    } else if (status && ['completed','failed','canceled'].includes(status.state) && !['completed','failed','canceled','paused'].includes(run.status)) {
      const reportedStop=status.code===76&&run.workerOutcome&&typeof run.workerOutcome==='object';
      const externallyKilled=status.state==='failed'&&Boolean(status.signal)&&!/deadline/i.test(String(status.error??''));
      run = updateRun(run, { status:run.status==='pause_requested'||status.code===75&&run.needsContinuation||reportedStop||externallyKilled?'paused':status.state, launchState:'finished', finishedAt:status.finishedAt ?? now(), exitCode:status.code, signal:status.signal, error:reportedStop?`Worker reported ${run.workerOutcome.status}: ${String(run.workerOutcome.summary).slice(0,4000)}`:status.error??run.error });
      runEvent(run, `run.${status.state}`, { exitCode:status.code, signal:status.signal }, `${run.launchKey}:${status.state}`);
    } else if (status?.state === 'launching' && ['reserved','fenced'].includes(run.launchState)) {
      const age=Date.now()-Date.parse(status.fencedAt??run.createdAt);
      if(age>3000) {
        run=updateRun(run,{status:'paused',launchState:'outcome-unknown',finishedAt:now(),error:'Launch fence was crossed without a durable process identity; launch will not be replayed'});
        runEvent(run,'run.interrupted',{reason:run.error},run.launchKey);
      }
    }
    if (run.status === 'running' && !processGroupAlive(run.processGroupId??run.pid)) {
      run = updateRun(run, { status:'paused', launchState:'outcome-unknown', finishedAt:now(), error:'Process ended without a durable final status; launch will not be replayed' });
      runEvent(run, 'run.interrupted', { reason:run.error }, run.launchKey);
      if (run.taskId) {
        try {
          const task=store.require<any>('task',run.taskId);
          const requested=domain.call('task.control', { taskId:run.taskId, expectedRev:task.rev, command:'pause' }, {role:'system',id:'execution-recovery'});
          domain.call('task.ack', { taskId:run.taskId, expectedRev:requested.rev, command:'pause', checkpoint:{ runId:run.id, summary:run.error, logs:run.paths } }, {role:'system',id:'execution-recovery'});
        } catch {}
      }
    }
    return run;
  }

  async function captureRunCandidate(run:RunRecord):Promise<RunRecord> {
    if(!run.taskId||!run.cwd||run.checkpointCandidate)return run;
    try{const task=store.require('task',run.taskId);let candidate=await candidateFor(task,run);if(candidate.dirty===true&&typeof candidate.baseCommit==='string')candidate=await materializeCandidate(run.cwd,candidate,run.id,stateDir);run=updateRun(store.require<RunRecord>('run',run.id),{checkpointCandidate:candidate});if(task.state==='Running'&&task.runId===run.id)saveWorkerCheckpoint(store,task.id,run.id,{summary:run.sdkResult?.summary??'Stopped run source and logs preserved.',next:'Verify the exact saved candidate and remaining checks before a fresh continuation.',candidate,submissionId:'execution-stopped-candidate'});return run;}
    catch(error){return updateRun(store.require<RunRecord>('run',run.id),{candidateCaptureError:safeError(error)});}
  }

  function checkpointSnapshot(candidate:any) {
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)) return candidate;
    const { materializedCommit: _materializedCommit, ...snapshot } = candidate;
    return snapshot;
  }

  async function validateResumeCheckpoint(task:any,run:RunRecord) {
    assert(run.status==='paused','Stopped worker run is not ready for a fresh continuation');
    assert(!run.candidateCaptureError,'Stopped worker candidate could not be preserved');
    assert(typeof run.cwd==='string'&&existsSync(run.cwd)&&statSync(run.cwd).isDirectory(),'Stopped worker worktree is unavailable; do not resume without its preserved candidate');
    assert(run.checkpointCandidate&&typeof run.checkpointCandidate==='object','Stopped worker checkpoint has no preserved candidate');
    const current=await candidateFor(task,run);
    assert(canonicalJson(checkpointSnapshot(current))===canonicalJson(checkpointSnapshot(run.checkpointCandidate)),'Stopped worker worktree changed after its checkpoint; do not resume without review');
    if(run.checkpointCandidate.dirty===true) assert(typeof run.checkpointCandidate.materializedCommit==='string','Stopped worker dirty candidate was not materialized');
  }

  function checkpoint(run:RunRecord|undefined,reason:string):any {
    if(!run?.taskId) return undefined;
    const key=`checkpoint:${run.id}:${reason}`;
    const prior=store.get<any>('checkpoint',key);
    if(prior) return prior;
    const saved=store.put('checkpoint',{id:key,projectId:run.projectId,taskId:run.taskId,runId:run.id,data:{reason,status:run.status,launchState:run.launchState,logs:run.paths,cwd:run.cwd,sourceCandidate:run.sourceCandidate,candidate:run.checkpointCandidate??null,candidateCaptureError:run.candidateCaptureError??null,next:'Inspect persisted logs and current source before resuming'},at:now(),actor:'execution'});
    store.event('checkpoint.saved',run.projectId??null,{taskId:run.taskId,runId:run.id,checkpointId:saved.id},key);
    return saved;
  }

  function closeDomainRun(run:RunRecord,state:'Failed'|'Paused'):RunRecord {
    const current=store.require<RunRecord>('run',run.id);
    return current.state==='Running'?updateRun(current,{state,endedAt:(current as any).endedAt??now()}):current;
  }

  function stopTask(run:RunRecord,kind:'fail'|'block',reason:string,source:string,data:Record<string,any>) {
    closeDomainRun(run,'Failed');
    if(!run.taskId) return;
    const task=store.require<any>('task',run.taskId);
    if(task.state!=='Running'||task.runId!==run.id||task.requested) return;
    domain.call(`task.${kind}`,{taskId:task.id,expectedRev:task.rev,runId:run.id,reason,checkpoint:data},{role:'system',id:source});
  }

  async function terminateRun(runInput:RunRecord,target:'paused'|'canceled'):Promise<{run:RunRecord;acknowledged:boolean}> {
    let run=store.require<RunRecord>('run',runInput.id);
    if(target==='paused'&&run.pauseRequestedAt&&['completed','failed','canceled'].includes(run.status)) run=updateRun(run,{status:'paused'});
    if(['completed','failed','canceled','paused'].includes(run.status)) return {run,acknowledged:target==='canceled'?run.status==='canceled':!processGroupAlive(run.processGroupId??run.pid)};
    run=updateRun(run,{status:target==='canceled'?'cancel_requested':'pause_requested',[target==='canceled'?'cancelRequestedAt':'pauseRequestedAt']:now()});
    const group=run.processGroupId??run.pid;
    if(group&&processGroupAlive(group)) {
      try{process.kill(-group,'SIGTERM')}catch{}
      const until=Date.now()+2500;
      while(Date.now()<until&&processGroupAlive(group)) await new Promise(resolveWait=>setTimeout(resolveWait,50));
    }
    run=await reconcileRun(run);
    const stopped=!processGroupAlive(group);
    // Once a cancellation request has crossed the durable fence, a process that
    // stops with a nonzero exit is still canceled. Node test runners can turn a
    // SIGTERM delivered to a child into exit code 1 without retaining the signal.
    if(stopped&&(target==='paused'?run.status!=='paused':run.status!=='completed'&&run.status!=='canceled')) run=updateRun(run,{status:target,finishedAt:run.finishedAt??now(),launchState:'finished'});
    return {run,acknowledged:stopped&&(target==='canceled'?run.status==='canceled':true)};
  }

  async function releaseHumanControl(task:any,run:RunRecord|undefined) {
    let released=run;
    if(run) {
      released=await captureRunCandidate(updateRun(run,{status:run.status==='canceled'?run.status:'paused',checkpointCandidate:undefined,candidateCaptureError:undefined,resumeBlockedReason:undefined}));
      checkpoint(released,`human-release-${task.rev}`);
    }
    const current=store.require<any>('task',task.id);
    domain.call('task.ack',{taskId:current.id,expectedRev:current.rev,command:'release',checkpoint:released?{runId:released.id,cwd:released.cwd,candidate:released.checkpointCandidate??null,candidateCaptureError:released.candidateCaptureError??null,summary:'Human worktree changes preserved for an owner resume'}:{summary:'No run worktree to preserve'}},{role:'system',id:'execution-control'});
  }

  async function processTaskControls(onlyProfileRuntimes = false):Promise<string[]> {
    const handled:string[]=[];
    for(const original of store.list<any>('task').filter(task=>task.requested?.command && (!onlyProfileRuntimes || isProfileRuntime(task.runtime)))) {
      let task=store.require<any>('task',original.id); const command=task.requested.command;
      const run=task.runId?store.get<RunRecord>('run',task.runId):undefined;
      const native=(run?.runtime??task.runtime)==='codex-app';
      if(command==='release') { await releaseHumanControl(task,run); handled.push(task.id); continue; }
      if(native&&!(command==='takeover'&&(!run||['completed','failed','canceled','paused'].includes(run.status)))) continue;
      if(native&&run) {
        checkpoint(await captureRunCandidate(updateRun(run,{status:'paused'})),command);
        domain.call('task.ack',{taskId:task.id,expectedRev:store.require<any>('task',task.id).rev,command,checkpoint:{runId:run.id,summary:'Native session is no longer active'}},{role:'system',id:'execution-control'}); handled.push(task.id); continue;
      }
      if(command==='checkpoint') {
        domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command,checkpoint:run?{runId:run.id,status:run.status,logs:run.paths,cwd:run.cwd,sourceCandidate:run.sourceCandidate,next:'Inspect persisted state before resuming'}:{summary:'No active run'}},{role:'system',id:'execution-control'}); handled.push(task.id); continue;
      }
      if(command==='resume') {
        if(run&&(run.status==='paused'||run.pauseRequestedAt)) {
          try { await validateResumeCheckpoint(task,run); }
          catch(error) { const reason=safeError(error); const current=store.require<RunRecord>('run',run.id); if(current.resumeBlockedReason!==reason) updateRun(current,{resumeBlockedReason:reason}); continue; }
        }
        domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command},{role:'system',id:'execution-control'});
        if(run?.status==='paused') { const current=store.require<RunRecord>('run',run.id); updateRun(current,{state:'Paused',resumeBlockedReason:undefined}); }
        handled.push(task.id); continue;
      }
      if(!run) {
        domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command,checkpoint:{summary:'No process had launched'}},{role:'system',id:'execution-control'}); handled.push(task.id); continue;
      }
      const stopped=await terminateRun(run,command==='cancel'?'canceled':'paused');
      if(!stopped.acknowledged) continue;
      let acknowledgedRun=stopped.run;
      if(command==='cancel') acknowledgedRun=updateRun(acknowledgedRun,{cancellationAcknowledged:true,cancellationAcknowledgedAt:now()});
      if(command==='pause'||command==='takeover') acknowledgedRun=await captureRunCandidate(acknowledgedRun);
      checkpoint(acknowledgedRun,command);
      task=store.require<any>('task',task.id);
      domain.call('task.ack',{taskId:task.id,expectedRev:task.rev,command,checkpoint:{runId:run.id,logs:run.paths,summary:`Process ${command} acknowledged`}},{role:'system',id:'execution-control'});
      runEvent(acknowledgedRun,`run.${command}_acknowledged`,{status:acknowledgedRun.status},task.acknowledged?.at??acknowledgedRun.finishedAt??now());
      handled.push(task.id);
    }
    return handled;
  }

  function compactResult(run: RunRecord) {
    const stdout = run.paths && existsSync(run.paths.stdout) ? readFileSync(run.paths.stdout, 'utf8') : '';
    const stderr = run.paths && existsSync(run.paths.stderr) ? readFileSync(run.paths.stderr, 'utf8') : '';
    return {
      runId:run.id, taskId:run.taskId, status:run.status, exitCode:run.exitCode,
      summary:(run.sdkResult?.summary || stdout.trim() || stderr.trim() || run.error || `Run ${run.status}`).slice(-4000),
      logs:run.paths ? { stdout:run.paths.stdout, stderr:run.paths.stderr, status:run.paths.status } : undefined,
      usage:run.sdkUsage ?? run.usage ?? { providerAllowance:'unknown', contextCapacity:'unknown', taskLimit:'bounded' },
      exitReason:run.status === 'completed' ? 'completed' : run.status,
    };
  }

  function requiresCleanCommit(task:any,run:RunRecord):boolean {
    return run.runType==='technical'&&allowsWrite(task.permissions)&&!task.workflow?.featureId;
  }

  async function pauseForCleanCommit(task:any,runInput:RunRecord):Promise<any> {
    let run=updateRun(runInput,{status:'paused',cleanCommitRequired:true,error:'Writer exited with uncommitted changes. Resume so it commits them; only a clean commit is collected.'});
    run=await captureRunCandidate(run);
    checkpoint(run,'clean-commit-required');
    if(task.state==='Running'&&task.runId===run.id&&!task.requested) {
      const requested=domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'pause'},{role:'system',id:'execution-result'});
      domain.call('task.ack',{taskId:task.id,expectedRev:requested.rev,command:'pause',checkpoint:{runId:run.id,logs:run.paths,candidate:run.checkpointCandidate,summary:run.error}},{role:'system',id:'execution-result'});
    }
    return { ...compactResult(run), resultReported:false, cleanCommitRequired:true };
  }

  async function collectResult(runInput: RunRecord, actor: Actor): Promise<any> {
    let run = await reconcileRun(runInput);
    assert(['completed','failed','canceled','paused'].includes(run.status), 'Run has not finished');
    const result = compactResult(run);
    if (run.paths) atomicJson(run.paths.result, result);
    if (run.taskId && run.status==='completed' && !run.resultReported) {
      const taskId = run.taskId;
      let task = store.require<any>('task', taskId);
      let candidate = await candidateFor(task,run);
      if(task.workflow?.featureId&&run.cwd&&task.workflow.purpose!=='requirements_preparation'&&task.workflow.purpose!=='planning'){const before=candidate;candidate=await materializeCandidate(run.cwd,candidate,run.id,stateDir);const after=await candidateFor(task,run);assert(canonicalJson(before)===canonicalJson(after),'Worker candidate changed while materializing its handoff');}
      run = store.require<RunRecord>('run',run.id);
      if (run.resultReported) return { ...compactResult(run), resultReported:true };
      task = store.require<any>('task', taskId);
      if (candidate.dirty===true&&typeof candidate.materializedCommit!=='string'&&requiresCleanCommit(task,run)) return pauseForCleanCommit(task,run);
      if(isProfileRuntime(run.runtime))saveWorkerCheckpoint(store,task.id,run.id,{summary:result.summary,next:'Independently verify the exact saved candidate.',candidate,submissionId:'execution-result-candidate'});
      domain.call('task.workerResult', {
        taskId, runId:run.id, expectedTaskRev:task.rev, candidate,
        summary:result.summary, checks:run.checks ?? [], artifacts:[result.logs].filter(Boolean), unresolved:run.error ? [run.error] : [], usage:result.usage, exitReason:result.exitReason,
      }, { role:'worker', id:actor.role === 'worker' ? actor.id : (task.workerId ?? `execution:${task.id}`), taskId });
      run = updateRun(store.require<RunRecord>('run',run.id), { resultReported:true, resultReportedAt:now() });
    } else if(run.taskId&&['failed','paused'].includes(run.status)) {
      const task=store.require<any>('task',run.taskId);
      run=await captureRunCandidate(run);
      checkpoint(run,run.status);
      if(run.status==='failed') stopTask(run,'fail',run.error??'Run failed','execution-result',{runId:run.id,logs:run.paths,candidate:run.checkpointCandidate,summary:run.error??'Run failed'});
      else if(task.state==='Running'&&!task.requested) {
        const requested=domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'pause'},{role:'system',id:'execution-result'});
        domain.call('task.ack',{taskId:task.id,expectedRev:requested.rev,command:'pause',checkpoint:{runId:run.id,logs:run.paths,summary:run.error??`Run ${run.status}`}},{role:'system',id:'execution-result'});
      }
    }
    return { ...result, resultReported:run.resultReported === true };
  }

  async function cancelRun(runInput: RunRecord, actor: Actor): Promise<RunRecord> {
    let run = store.require<RunRecord>('run', runInput.id);
    if (['completed','failed','canceled'].includes(run.status)) return run;
    if (run.taskId) {
      const task=store.require<any>('task',run.taskId);
      if(task.requested?.command!=='cancel') domain.call('task.control', {taskId:run.taskId,expectedRev:task.rev,command:'cancel'}, actor.role === 'system' ? actor : {role:'system',id:actor.id});
    }
    run = updateRun(run, { cancelRequestedAt:now(), status:run.status === 'awaiting_session' ? 'cancel_requested' : run.status });
    runEvent(run, 'run.cancel_requested', {}, run.cancelRequestedAt);
    if(run.runtime==='codex-app') return updateRun(run,{cancellationAcknowledged:false});
    if (run.status === 'cancel_requested' && run.launchState === 'awaiting-session') {
      run = updateRun(run, {status:'canceled',finishedAt:now(),launchState:'canceled-before-launch'});
    } else {
      const stopped=await terminateRun(run,'canceled'); run=stopped.run;
      if(!stopped.acknowledged) return updateRun(run,{cancellationAcknowledged:false});
    }
    run = updateRun(run, { cancellationAcknowledged:run.status === 'canceled', cancellationAcknowledgedAt:run.status === 'canceled' ? now() : undefined });
    if (run.taskId && run.status === 'canceled') {
      checkpoint(run,'cancel');
      const task=store.require<any>('task',run.taskId);
      domain.call('task.ack', {taskId:run.taskId,expectedRev:task.rev,command:'cancel',checkpoint:{runId:run.id,logs:run.paths,summary:'Process cancellation acknowledged'}}, {role:'system',id:'execution-cancel'});
      run=store.require<RunRecord>('run',run.id);
    }
    runEvent(run, run.status === 'canceled' ? 'run.cancel_acknowledged' : 'run.cancel_not_acknowledged', {status:run.status}, run.cancelRequestedAt);
    return run;
  }

  function queueReasons(task: any, runtimes: any[]): string[] {
    const limits = store.get<any>('execution_limits', 'global');
    const runtime = selectRuntime(task, runtimes);
    const runType = task.runType ?? (runtime === 'script' ? 'script' : runtime === 'codex-app' ? 'gui' : 'technical');
    const reasons: string[] = [];
    if (limits?.stopNewWork) reasons.push(`dispatch_paused:${limits.reason ?? 'execution_limit'}`);
    if (task.deadline && (!Number.isFinite(Date.parse(task.deadline)) || Date.parse(task.deadline) <= Date.now())) reasons.push('deadline_expired');
    reasons.push(...domain.call('task.waiting', { taskId: task.id, runType, resources: task.resources, worktree: task.worktree }, { role: 'system', id: 'execution-queue' }).reasons.map((reason: string) => reason === 'technical worker capacity reached' ? 'technical_worker_capacity' : reason === 'GUI controller capacity reached' ? 'gui_controller_capacity' : reason));
    const capability = runtimes.find(item => item.name === runtime);
    if (!capability?.eligible && runtime !== 'codex-app') reasons.push(`runtime_unavailable:${runtime}`);
    else { const denial = policyDenial(task, runtime); if (denial) reasons.push(denial); }
    const limitRuntime = isProfileRuntime(runtime) ? profileForTask(task).runtime : runtime;
    if (limits?.blockedRuntimes?.includes(runtime) || limits?.blockedRuntimes?.includes(limitRuntime) || limitReached(store.get<any>('runtime_limit', limitRuntime))) reasons.push(`runtime_limit:${runtime}`);
    if (runtime === 'script' && !task.capability) reasons.push('capability_required');
    return [...new Set(reasons)];
  }

  function compareQueuedTasks(a: any, b: any): number {
    return Number(b.priority ?? 0) - Number(a.priority ?? 0)
      || String(a.createdBy?.at ?? '').localeCompare(String(b.createdBy?.at ?? ''))
      || a.id.localeCompare(b.id);
  }

  async function currentQueue(input: Record<string, any> = {}, actor: Actor): Promise<any[]> {
    const runtimes = await runtimeCapabilities();
    return store.list<any>('task')
      .filter(task => task.state === 'Approved' && (!input.projectId || task.projectId === input.projectId) && (!input.taskId || task.id === input.taskId) && (actor.role !== 'worker' || task.id === actor.taskId))
      .sort(compareQueuedTasks)
      .map(task => {
        const reasons = queueReasons(task, runtimes);
        return { id: `queue:${task.id}`, taskId: task.id, projectId: task.projectId, state: task.state, priority: task.priority ?? 0, runtime: task.runtime, reason: reasons[0] ?? null, reasons, checkedAt: now() };
      });
  }

  function queueStatus(task: any, reason?: string) {
    const key = `queue:${task.id}`;
    const previous = store.get<any>('execution_queue', key);
    return store.put('execution_queue', { ...(previous ?? {}), id:key, taskId:task.id, projectId:task.projectId, reason:reason ?? null, checkedAt:now() }, previous?.rev);
  }

  async function dispatchQueue(onlyProfileRuntimes = false): Promise<any> {
    const runtimes = await runtimeCapabilities();
    const limits=store.get<any>('execution_limits','global');
    if(limits?.stopNewWork) return {started:[],waiting:await currentQueue({}, {role:'system',id:'execution-scheduler'}),dispatchPaused:true,reason:limits.reason??'execution_limit',capacity:{technical:{limit:2},gui:{limit:1}}};
    const runs = store.list<RunRecord>('run');
    const active = runs.filter(run => ['running','awaiting_session','cancel_requested','pause_requested'].includes(run.status)||(!run.status&&run.state==='Running'));
    for(const limit of store.list<any>('runtime_limit').filter(limitReached)) {
      const warningKey=`runtime-limit:${limit.id}:${limit.rev}`;
      store.event('runtime.limit.warning',null,{runtime:limit.runtime,limitRev:limit.rev,source:limit.source,observedAt:limit.observedAt},warningKey);
      const projectId=active.find(run=>profileBaseRuntime(run.runtime)===limit.runtime)?.projectId??store.list<any>('project')[0]?.id;
      if(projectId) logicalFollowup(`runtime-limit:${limit.runtime}`,projectId,'runtime limit',`New ${limit.runtime} work is paused at its configured threshold`,{limit},`${limit.id}:${limit.rev}`);
      for(const run of active.filter(run=>profileBaseRuntime(run.runtime)===limit.runtime&&run.taskId)) checkpoint(run,`runtime-limit-${limit.rev}`);
    }
    let technical = active.filter(run => run.runType === 'technical').length;
    let gui = active.filter(run => run.runType === 'gui').length;
    const tasks = store.list<any>('task').filter(task => task.state === 'Approved' && (!onlyProfileRuntimes || isProfileRuntime(task.runtime)))
      .sort(compareQueuedTasks);
    const started: string[] = [];
    const waiting: any[] = [];
    for (const task of tasks) {
      const runtime = selectRuntime(task,runtimes);
      const runType = (task.runType ?? (runtime === 'script' ? 'script' : runtime === 'codex-app' ? 'gui' : 'technical')) as RunRecord['runType'];
      const reason = queueReasons(task, runtimes)[0];
      if (reason) { queueStatus(task,reason); waiting.push({taskId:task.id,reason}); continue; }
      try {
        const run = await claimAndStart(task,{runtime,runType,resources:task.resources,worktree:task.worktree,capability:task.capability,capabilityInput:task.capabilityInput}, {role:'system',id:'execution-scheduler'});
        queueStatus(task);
        started.push(run.id);
        if (runType === 'technical') technical++;
        if (runType === 'gui') gui++;
      } catch (error) {
        const failure = `start_failed:${safeError(error)}`;
        queueStatus(task,failure); waiting.push({taskId:task.id,reason:failure});
      }
    }
    return {started,waiting,capacity:{technical:{active:technical,limit:2},gui:{active:gui,limit:1}}};
  }

  async function observeWatch(watch: WatchRecord): Promise<any> {
    if (watch.kind === 'git-ref') {
      const candidate = await git(['rev-parse','--verify',`${watch.ref ?? 'HEAD'}^{commit}`], resolve(watch.repository));
      return {kind:'git-ref',ref:watch.ref ?? 'HEAD',candidate};
    }
    const view=await execFileAsync('gh',['pr','view',String(watch.pr),'--json','headRefOid,state,url,statusCheckRollup'],{cwd:resolve(watch.repository),timeout:60_000,env:cleanEnvironment(),maxBuffer:4*1024*1024});
    const head = JSON.parse(String(view.stdout));
    const normalized = [...(head.statusCheckRollup??[])].map((row:any) => ({name:row.name??row.context,status:row.status,conclusion:row.conclusion,workflow:row.workflowName,link:row.detailsUrl})).sort((a:any,b:any)=>String(a.name).localeCompare(String(b.name)));
    const exact = !watch.expectedCandidate || head.headRefOid === watch.expectedCandidate;
    const terminal=normalized.length>0&&normalized.every((row:any)=>String(row.status).toUpperCase()==='COMPLETED'||Boolean(row.conclusion));
    const failed=normalized.some((row:any)=>['FAILURE','CANCELLED','TIMED_OUT','ACTION_REQUIRED','STARTUP_FAILURE'].includes(String(row.conclusion).toUpperCase()));
    const passing=exact&&terminal&&!failed&&normalized.every((row:any)=>['SUCCESS','SKIPPED','NEUTRAL'].includes(String(row.conclusion).toUpperCase()));
    return {kind:'pr-checks',pr:watch.pr,candidate:head.headRefOid,expectedCandidate:watch.expectedCandidate,commitExact:exact,terminal,passing,failed,state:head.state,url:head.url,checks:normalized};
  }

  function logicalFollowup(key:string,projectId:string,kind:string,summary:string,data:any,identity:string):boolean {
    return store.tx(()=>{
      const previous=store.get<any>('followup',key);
      const priorInbox=previous?.inboxId?store.get<any>('inbox',previous.inboxId):undefined;
      if(previous&&(priorInbox?.status==='pending'||previous.identity===identity)) {
        store.put('followup',{...previous,latest:data,updatedAt:now(),observations:(previous.observations??1)+1},previous.rev);
        return false;
      }
      const inbox=domain.call('inbox.create',{projectId,kind,summary,data},{role:'system',id:'execution-watch'});
      store.put('followup',{...(previous??{}),id:key,projectId,kind,summary,identity,latest:data,status:'pending',createdAt:previous?.createdAt??now(),updatedAt:now(),inboxId:inbox.id,observations:(previous?.observations??0)+1,generation:(previous?.generation??0)+1},previous?.rev);
      return true;
    });
  }

  async function tickWatches(): Promise<any> {
    const launchesBefore = modelLaunches;
    const changed: string[] = [], unchanged: string[] = [], failures: string[] = [], expired: string[] = [];
    for (const original of store.list<WatchRecord>('watch')) {
      let watch = original;
      if (watch.status !== 'active') continue;
      if (watch.expiresAt && Date.parse(watch.expiresAt) <= Date.now()) {
        watch = store.put<WatchRecord>('watch',{...watch,status:'expired',health:'expired',nextCheckAt:watch.nextCheckAt},watch.rev);
        store.event('watch.expired',watch.projectId,{watchId:watch.id},`${watch.id}:expired`); expired.push(watch.id); continue;
      }
      if (Date.parse(watch.nextCheckAt) > Date.now()) continue;
      try {
        const observation = await observeWatch(watch);
        const current=store.require<WatchRecord>('watch',watch.id);
        if(current.status!=='active'||(current.expiresAt&&Date.parse(current.expiresAt)<=Date.now())) continue;
        watch=current;
        const observationHash = hash(JSON.stringify(observation));
        const isChanged = watch.observationHash !== observationHash;
        const at = now();
        const recentEvents = [...(watch.recentEvents ?? []), ...(isChanged ? [{at,type:'changed',candidate:observation.candidate}] : [])].slice(-20);
        const next = new Date(Date.now()+watch.intervalMs).toISOString();
        const priorCandidate = watch.lastObservation?.candidate;
        const outsideChanged=watch.kind==='git-ref'&&priorCandidate&&priorCandidate!==observation.candidate;
        const reconciliationKey = outsideChanged ? `reconcile:${hash(`${watch.projectId}:${watch.repository}:${watch.ref??'HEAD'}`)}` : watch.pendingReconciliation;
        watch = store.put<WatchRecord>('watch',{...watch,health:'healthy',lastSuccessAt:at,nextCheckAt:next,lastObservation:observation,observationHash,retryCount:0,lastError:undefined,recentEvents,pendingReconciliation:reconciliationKey},watch.rev);
        if (isChanged) {
          store.event('watch.observation.changed',watch.projectId,{watchId:watch.id,observation},`${watch.id}:observation:${observationHash}`);
          if (outsideChanged&&reconciliationKey) {
            const data={watchId:watch.id,repository:watch.repository,ref:watch.ref,previousCandidate:priorCandidate,candidate:observation.candidate,classification:'observation_only',acceptedSpecificationChanged:false};
            const first=logicalFollowup(reconciliationKey,watch.projectId,'outside commit',`Outside commit observed on ${watch.ref??'HEAD'}`,data,String(observation.candidate));
            store.event('outside_commit.observed',watch.projectId,{...data,coalesced:!first},`outside:${watch.id}:${observation.candidate}`);
          }
          if(watch.kind==='pr-checks'&&observation.terminal) {
            const key=`pr-checks:${hash(`${watch.projectId}:${watch.repository}:${watch.pr}:${observation.candidate}`)}`;
            const outcome=observation.commitExact?(observation.passing?'passed':'failed'):'stale';
            logicalFollowup(key,watch.projectId,'PR checks',`PR ${watch.pr} checks ${outcome} for ${observation.candidate}`,{watchId:watch.id,observation,outcome},observationHash);
          }
          changed.push(watch.id);
        } else unchanged.push(watch.id);
      } catch (error) {
        const current=store.require<WatchRecord>('watch',watch.id);
        if(current.status!=='active'||(current.expiresAt&&Date.parse(current.expiresAt)<=Date.now())) continue;
        watch=current;
        const retryCount=(watch.retryCount??0)+1;
        const delay=Math.min(watch.intervalMs*Math.pow(2,Math.min(retryCount,5)),60*60_000);
        watch=store.put<WatchRecord>('watch',{...watch,health:'unhealthy',lastError:safeError(error),retryCount,nextCheckAt:new Date(Date.now()+delay).toISOString(),recentEvents:[...(watch.recentEvents??[]),{at:now(),type:'error',error:safeError(error)}].slice(-20)},watch.rev);
        store.event('watch.health.failed',watch.projectId,{watchId:watch.id,error:watch.lastError,retryCount},`${watch.id}:failure:${retryCount}:${hash(watch.lastError??'')}`); failures.push(watch.id);
        logicalFollowup(`watch-health:${hash(`${watch.projectId}:${watch.kind}:${watch.repository}:${watch.ref??watch.pr??''}`)}`,watch.projectId,'monitor health',`Watch ${watch.id} could not observe its source`,{watchId:watch.id,error:watch.lastError,retryCount},watch.lastError??'');
      }
    }
    return {changed,unchanged,failures,expired,modelInvocations:modelLaunches-launchesBefore};
  }

  let workflowTick:(()=>Promise<any>)|undefined;
  function setWorkflowTick(callback:()=>Promise<any>){workflowTick=callback;}
  async function doTick(onlyProfileRuntimes = false) {
    const workflowBefore=await workflowTick?.();
    const controls=await processTaskControls(onlyProfileRuntimes);
    const reconciled: string[] = [];
    for (const run of store.list<RunRecord>('run').filter(item => (['reserved','running','awaiting_session','cancel_requested','canceling','pause_requested'].includes(item.status) || (item.status === 'completed' && !item.resultReported) || (item.status === 'failed' && item.state === 'Running') || (item.status === undefined && item.state === 'Running' && item.workerId === `execution:${item.taskId}`) || (['failed','paused'].includes(item.status) && item.taskId && store.get('task',item.taskId)?.state==='Running' && store.get('task',item.taskId)?.runId===item.id)) && (!onlyProfileRuntimes || isProfileRuntime(item.runtime)))) {
      let next = await reconcileRun(run);
      if (next.rev !== run.rev) reconciled.push(next.id);
      if(next.status==='failed') next=closeDomainRun(next,'Failed');
      if(next.taskId&&['failed','paused'].includes(next.status)) {
        const task=store.require<any>('task',next.taskId);
        if(task.state==='Running'&&!task.requested) {
          next=await captureRunCandidate(next);
          checkpoint(next,next.error?.includes('deadline')?'deadline':'interrupted');
          if(next.status==='failed') { stopTask(next,'fail',next.error??'Run failed','execution-tick',{runId:next.id,logs:next.paths,candidate:next.checkpointCandidate,summary:next.error??'Run failed'}); continue; }
          const requested=domain.call('task.control',{taskId:task.id,expectedRev:task.rev,command:'pause'},{role:'system',id:'execution-tick'});
          domain.call('task.ack',{taskId:task.id,expectedRev:requested.rev,command:'pause',checkpoint:{runId:next.id,logs:next.paths,summary:next.error??`Run ${next.status}`}},{role:'system',id:'execution-tick'});
        }
      }
      if (next.taskId && next.status==='completed' && !next.resultReported) {
        try { await collectResult(next,{role:'system',id:'execution-tick'}); } catch(error) {next=updateRun(store.require<RunRecord>('run',next.id),{status:'paused',error:`Result collection needs attention: ${safeError(error)}`});next=await captureRunCandidate(next);checkpoint(next,'result-collection');runEvent(next,'run.result_collection_failed',{error:next.error},`${next.id}:collection-failed`);const current=store.require('task',next.taskId!);if(current.state==='Running'&&!current.requested){const requested=domain.call('task.control',{taskId:current.id,expectedRev:current.rev,command:'pause'},{role:'system',id:'execution-result'});domain.call('task.ack',{taskId:current.id,expectedRev:requested.rev,command:'pause',checkpoint:{runId:next.id,logs:next.paths,candidate:next.checkpointCandidate,summary:next.error}},{role:'system',id:'execution-result'});}}
      }
    }
    const watches = onlyProfileRuntimes ? {changed:[],unchanged:[],failures:[],expired:[],modelInvocations:0} : await tickWatches();
    const workflowAfter=await workflowTick?.();
    const queue = await dispatchQueue(onlyProfileRuntimes);
    const inferenceLaunches=queue.started.filter((runId:string)=>['pi','codex','claude'].includes(profileBaseRuntime(store.require<RunRecord>('run',runId).runtime))).length;
    return {controls,reconciled,watches,queue,inferenceLaunches,workflowBefore,workflowAfter,at:now()};
  }

  async function call(action: string, input: Record<string, any> = {}, actor: Actor): Promise<any> {
    ensureOpen(); authorize(action,actor); assert(input && typeof input === 'object' && !Array.isArray(input), 'Input must be an object');
    if (action === 'runtime.capabilities') return runtimeCapabilities(Boolean(input.refresh));
    if(action==='runtime.limits') {
      const values=store.list<any>('runtime_limit');
      return input.runtime?(store.get<any>('runtime_limit',String(input.runtime))??{runtime:input.runtime,provider:{status:'unknown'},context:{status:'unknown'},task:{status:'unknown'},source:'unavailable',observedAt:null}):values;
    }
    if(action==='runtime.limit_set') {
      assert(typeof input.runtime==='string'&&typeof input.source==='string'&&input.source.trim(),'runtime and source are required');
      const numberOrUnknown=(value:any)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
      const previous=store.get<any>('runtime_limit',input.runtime);
      const providerRemaining=numberOrUnknown(input.providerRemaining),contextUsed=numberOrUnknown(input.contextUsed),contextCapacity=numberOrUnknown(input.contextCapacity),taskTimeoutMs=numberOrUnknown(input.taskTimeoutMs);
      const value=store.put('runtime_limit',{id:input.runtime,runtime:input.runtime,provider:{status:providerRemaining===undefined?'unknown':'known',remaining:providerRemaining,unit:input.providerUnit},context:{status:contextUsed===undefined||contextCapacity===undefined?'unknown':'known',used:contextUsed,capacity:contextCapacity},task:{status:taskTimeoutMs===undefined?'unknown':'known',timeoutMs:taskTimeoutMs},warningThreshold:{providerRemaining:numberOrUnknown(input.warningThreshold?.providerRemaining??input.warningThreshold),contextRatio:numberOrUnknown(input.warningThreshold?.contextRatio)},stopNewWork:input.stopNewWork===true,source:input.source.trim(),observedAt:input.observedAt??now(),recordedAt:now(),recordedBy:actor.id},previous?.rev);
      capabilityCache.delete('runtimes');
      store.event('runtime.limit.recorded',null,{runtime:value.runtime,rev:value.rev,source:value.source,observedAt:value.observedAt,providerStatus:value.provider.status,contextStatus:value.context.status},`runtime-limit:${value.runtime}:${value.rev}`);
      return value;
    }
    if (action === 'capability.list') {
      const saved = store.list<Procedure>('capability_procedure').filter(item => (item.status === 'approved' || (input.includeProposed === true && actor.role !== 'worker')) );
      return [...[...registry.values()].map(({args,...item})=>({...item,source:'built-in'})), ...saved.map(item => { const {args,...capability} = procedureCapability(item); return {...capability,fixedArgs:item.args,status:item.status,proposedBy:item.proposedBy,approvedBy:item.approvedBy??null}; })];
    }
    if (action === 'capability.propose') return proposeProcedure(input, actor);
    if (action === 'capability.approve') return approveProcedure(input, actor);
    if (action === 'capability.run') {
      if (actor.role === 'worker') {
        assert(actor.taskId && (!input.taskId || input.taskId === actor.taskId), 'Worker is not bound to this task');
        const task=store.require<any>('task',actor.taskId);
        assert(task.state==='Running' && task.capability===input.capability,'Capability is outside the worker task approval');
        if(input.input!==undefined) assert(canonicalJson(input.input)===canonicalJson(task.capabilityInput??{}),'Capability input differs from the approved task');
        const root=taskRepository(task);
        const cwd=typeof task.worktree==='string'?resolvedPath(task.worktree):root;
        assert(within(root,cwd),'Capability working directory is outside the task project');
        assert(input.cwd===undefined||resolvedPath(String(input.cwd))===cwd,'Working directory differs from the approved task');
        assert(input.deadline===undefined||input.deadline===task.deadline,'Deadline differs from the approved task');
        const parent=store.require<RunRecord>('run',task.runId);
        const budgetDeadline=Date.parse(parent.startedAt??now())+approvedTimeout(task,task.runtime??'script');
        const bounds=[budgetDeadline,...[task.deadline,parent.deadline].filter(value=>value!==undefined).map(value=>Date.parse(String(value)))];
        assert(bounds.every(Number.isFinite)&&Math.min(...bounds)>Date.now(),'Execution deadline is invalid or expired');
        const deadline=new Date(Math.min(...bounds)).toISOString();
        return startCapability(String(input.capability),task.capabilityInput??{},cwd,{deadline,idempotencyKey:input.idempotencyKey,approvedTaskRev:parent.approvedTaskRev??task.rev,parentTaskId:task.id,parentRunId:parent.id,projectId:task.projectId,actorId:actor.id});
      }
      assert(!input.taskId,'Direct capability runs cannot attach themselves to a domain task');
      return startCapability(String(input.capability),input.input??{},input.cwd,{deadline:input.deadline,idempotencyKey:input.idempotencyKey,actorId:actor.id});
    }
    if (action === 'runtime.start') {
      assert(typeof input.taskId === 'string', 'taskId is required');
      const task=store.require<any>('task',input.taskId);
      assert(task.state==='Approved','Task is not Approved');
      const selectedRuntime=input.runtime??task.runtime;
      if(selectedRuntime==='script') {
        assert(task.capability,'Approved script task has no named capability');
        if(input.capability!==undefined) assert(input.capability===task.capability,'Capability differs from the approved task');
        if(input.capabilityInput!==undefined) assert(canonicalJson(input.capabilityInput)===canonicalJson(task.capabilityInput??{}),'Capability input differs from the approved task');
        input={...input,capability:task.capability,capabilityInput:task.capabilityInput??{}};
      }
      return claimAndStart(task,input,actor);
    }
    if (action === 'runtime.inspect') return reconcileRun(requireRun(String(input.runId),actor));
    if (action === 'runtime.events') {
      const run=requireRun(String(input.runId),actor);
      return store.events(Number(input.after??0),run.projectId).filter(event=>event.data?.runId===run.id);
    }
    if (action === 'runtime.cancel') return cancelRun(requireRun(String(input.runId),actor),actor);
    if (action === 'runtime.collect_result') return collectResult(requireRun(String(input.runId),actor),actor);
    if (action === 'watch.create') {
      assert(input.kind==='git-ref'||input.kind==='pr-checks','Unsupported watch kind');
      assert(typeof input.projectId==='string'&&typeof input.repository==='string','projectId and repository are required');
      assert(existsSync(resolve(input.repository)),'Watch repository is unavailable');
      if(input.kind==='pr-checks') assert(input.pr!==undefined,'pr is required for a PR checks watch');
      const intervalMs=Math.max(1000,Math.min(Number(input.intervalMs??60_000),24*60*60_000));
      const watch:WatchRecord={id:id('watch'),rev:0,projectId:input.projectId,kind:input.kind,repository:resolve(input.repository),ref:input.ref,pr:input.pr,expectedCandidate:input.expectedCandidate,intervalMs,status:'active',health:'unknown',createdAt:now(),nextCheckAt:now(),expiresAt:input.expiresAt,retryCount:0,recentEvents:[]};
      const saved=store.put<WatchRecord>('watch',watch);
      store.event('watch.created',saved.projectId,{watchId:saved.id,kind:saved.kind},`${saved.id}:created`);
      return saved;
    }
    if (action === 'watch.list') {
      const boundTask = actor.role === 'worker' ? domain.call('task.get', { taskId: actor.taskId }, actor) : undefined;
      if (boundTask && input.projectId) assert(input.projectId === boundTask.projectId, 'Worker may access only its project');
      return store.list<WatchRecord>('watch').filter(watch => (!input.projectId || watch.projectId === input.projectId) && (!boundTask || watch.projectId === boundTask.projectId));
    }
    if (action === 'watch.control') {
      const watch=store.require<WatchRecord>('watch',String(input.watchId));
      assert(['pause','resume','cancel'].includes(input.command),'Unsupported watch command');
      const status=input.command==='pause'?'paused':input.command==='resume'?'active':'canceled';
      const saved=store.put<WatchRecord>('watch',{...watch,status,nextCheckAt:input.command==='resume'?now():watch.nextCheckAt},watch.rev);
      store.event(`watch.${input.command}d`,saved.projectId,{watchId:saved.id},`${saved.id}:${input.command}:${saved.rev}`);
      return saved;
    }
    if (action === 'watch.tick') return tickWatches();
    if(action==='run.changelog') {
      if(actor.role==='worker') { assert(actor.taskId&&!input.projectId&&(input.runId?requireRun(String(input.runId),actor):input.taskId===actor.taskId),'Worker is not bound to this task'); }
      return runChangelogs(store,input);
    }
    if(action==='execution.queue') return currentQueue(input, actor);
    if (action === 'execution.tick') return tick();
    if (action === 'execution.tick_profiles') return tickProfiles();
    if (action === 'worker.claude_auth') {
      assert(input.decision==='approve'||input.decision==='revoke','decision must be approve or revoke');
      const saved=input.decision==='approve'?approveClaudeAuthorization(store,actor,input.source):revokeClaudeAuthorization(store,actor,input.source);
      capabilityCache.delete('runtimes');
      return saved;
    }
    throw new Error(`Unknown execution action: ${action}`);
  }

  async function tick(): Promise<any> {
    ensureOpen();
    if (!ticking) ticking=doTick().finally(()=>{ticking=undefined});
    return ticking;
  }

  async function tickProfiles(): Promise<any> {
    ensureOpen();
    if (!ticking) ticking=doTick(true).finally(()=>{ticking=undefined});
    return ticking;
  }

  async function close(): Promise<void> {
    if (ticking) await ticking;
    closed=true;
  }

  return { call, actions:()=>actionDescriptors.map(item=>({...item,roles:[...item.roles],inputSchema:structuredClone(item.inputSchema)})), tick, tickProfiles, setWorkflowTick, close };
}
