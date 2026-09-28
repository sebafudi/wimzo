import { codexContext } from './codex-telemetry.ts';
import { Codex } from '@openai/codex-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeMaxTurns } from './claude-profile.ts';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { contextDecision, estimateContextTokens } from './worker-context.ts';
import { assert } from './store.ts';
import { codexRuntime, codexWorkspacePermissionProfile, type CodexWorkspacePermissionInput } from './codex-permissions.ts';

export type SdkOptions={cwd:string;model?:string;thinking?:string;write:boolean;prompt:string;signal?:AbortSignal;env:Record<string,string>;bridgeConfigPath:string;sessionId?:string;contextPolicy?:any;contextCapacity?:number;permissionPaths?:Omit<CodexWorkspacePermissionInput,'workspace'|'write'|'scratchDir'>;onEvent:(event:any)=>void;approvedClaudeAuth?:boolean;claudeExecutable?:string;assertAuthorized?:()=>void;maxTurns?:number};
function runScratchDirectory(bridgeConfigPath:string) {
 const configPath=resolve(bridgeConfigPath);
 if(!isAbsolute(configPath)||basename(configPath)!=='sdk-config.json') throw new Error('Codex scratch directory requires the trusted SDK run configuration');
 const trustedId=createHash('sha256').update(configPath).digest('hex');
 const scratch=resolve(import.meta.dirname,'..','.wimzo','codex-scratch',trustedId);mkdirSync(scratch,{recursive:true,mode:0o700});
 const resolvedParent=realpathSync(dirname(scratch)),resolvedScratch=realpathSync(scratch),part=relative(resolvedParent,resolvedScratch);
 if(part===''||part.startsWith('..')||isAbsolute(part)) throw new Error('Codex scratch directory escapes the trusted SDK scratch root');
 return resolvedScratch;
}
export function codexOptions(options:SdkOptions) {
 const env={...options.env};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD/.test(key))delete env[key];
 const runtime=codexRuntime();
 const scratchDir=runScratchDirectory(options.bridgeConfigPath);
 const permissions=codexWorkspacePermissionProfile({workspace:options.cwd,...options.permissionPaths,scratchDir,write:options.write});
 env.WIMZO_CODEX_BINARY=runtime.executable;
 env.WIMZO_CODEX_PERMISSION_OVERRIDES=JSON.stringify(permissions.configOverrides);
 return {codexPathOverride:resolve(import.meta.dirname,'../scripts/codex-sdk-cli.mjs'),env,config:{...permissions.config,forced_login_method:'chatgpt',mcp_servers:{wimzo:{required:true,default_tools_approval_mode:'approve',command:process.execPath,args:[resolve(import.meta.dirname,'worker-bridge.ts'),options.bridgeConfigPath]}}}};
}
export async function runCodex(options:SdkOptions,dependencies:{Codex?:any}={}) {
 options.assertAuthorized?.();
 const initial=contextDecision(estimateContextTokens(options.prompt),options.contextCapacity??null,options.contextPolicy);
 assert(initial.action==='continue','Initial context exceeds the bounded run threshold; split the task before inference');
 const Controller=dependencies.Codex??Codex;
 const client=new Controller(codexOptions(options));
 const threadOptions={model:options.model,modelReasoningEffort:options.thinking,workingDirectory:options.cwd,approvalPolicy:'never',webSearchMode:'disabled'};
 const thread=options.sessionId?client.resumeThread(options.sessionId,threadOptions):client.startThread(threadOptions);
 const abort=new AbortController();const stop=()=>abort.abort();options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop();
 let authorizationError:unknown;const policyTimer=options.assertAuthorized?setInterval(()=>{try{options.assertAuthorized!();}catch(error){authorizationError=error;abort.abort();}},1000):undefined;policyTimer?.unref();
 let summary='',usage:any=null,sessionId=options.sessionId,estimatedContext=estimateContextTokens(options.prompt),stoppedForContext=false;
 let currentContext:any={used:estimatedContext,capacity:options.contextCapacity??null,estimated:true,source:'Prompt and tool-output estimate'};
 const checkContext=()=>{const decision=contextDecision(currentContext.used,currentContext.capacity,options.contextPolicy);if(!stoppedForContext&&(decision.action==='checkpoint'||decision.action==='stop')){stoppedForContext=true;options.onEvent({type:'context_checkpoint',decision,summary:'Context threshold reached; saved source and run output are ready for a fresh bounded continuation.'});abort.abort();}};
 try{
  const stream=await thread.runStreamed(options.prompt,{signal:abort.signal});
  for await(const event of stream.events){
   options.assertAuthorized?.();
   if(event.type==='thread.started'){sessionId=event.thread_id;options.onEvent({type:'session',sessionId});}
   if(event.type==='item.completed'){
    const item=event.item;
    if(item.type==='agent_message'){summary=item.text??summary;estimatedContext+=estimateContextTokens(String(item.text??''));currentContext={used:estimatedContext,capacity:options.contextCapacity??null,estimated:true,source:'Prompt and tool-output estimate'};checkContext();}
    if(item.type==='command_execution'||item.type==='mcp_tool_call'||item.type==='file_change'){
      estimatedContext+=estimateContextTokens(JSON.stringify(item));
      currentContext=codexContext(sessionId,options.env.CODEX_HOME)||{used:estimatedContext,capacity:options.contextCapacity??null,estimated:true,source:'Prompt and tool-output estimate'};
      options.onEvent({type:'progress',summary:item.type==='command_execution'?'Running project commands':item.type==='file_change'?'Updated project files':'Using scoped Wimzo tools',context:currentContext});
      checkContext();
    }
   }
   if(event.type==='turn.completed'){usage=event.usage;currentContext=codexContext(sessionId,options.env.CODEX_HOME)||{used:estimatedContext,capacity:options.contextCapacity??null,estimated:true,source:'Prompt and tool-output estimate; SDK usage is cumulative'};options.onEvent({type:'usage',usage,context:currentContext});checkContext();}
   if(event.type==='turn.failed'||event.type==='error')throw new Error(event.error?.message??event.message??'Codex SDK turn failed');
  }
 }catch(error){abort.abort();if(authorizationError)throw authorizationError;if(!stoppedForContext)throw error;}finally{if(policyTimer)clearInterval(policyTimer);options.signal?.removeEventListener('abort',stop);}
 if(authorizationError)throw authorizationError;
 return {summary:summary|| (stoppedForContext?'Paused at the context checkpoint threshold. Inspect saved progress before continuing.':'Codex run completed without a final message.'),sessionId,usage,context:currentContext,needsContinuation:stoppedForContext};
}
const CLAUDE_PAID_ROUTE=/^(ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_FOUNDRY_[A-Z_]+|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
const CLAUDE_INHERITED=/^(ANTHROPIC_[A-Z0-9_]+|CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_AGENT_SDK_[A-Z0-9_]+|CLAUDE_PID|CLAUDE_SESSION_[A-Z0-9_]+|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE)$/;
/** Subscription-only Claude environment: refuses paid or cloud routing and drops credentials and parent Claude Code session state. */
export function claudeEnvironment(source:Record<string,string|undefined>):Record<string,string> {
 const paid=Object.keys(source).filter(key=>CLAUDE_PAID_ROUTE.test(key)&&String(source[key]??'').trim()!=='');
 assert(paid.length===0,`Claude worker refuses paid or cloud inference routing: ${paid.join(', ')}`);
 const env:Record<string,string>={};
 for(const [key,value] of Object.entries(source))if(typeof value==='string'&&!CLAUDE_INHERITED.test(key)&&!CLAUDE_PAID_ROUTE.test(key)&&!/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN|SECRET|PASSWORD/.test(key))env[key]=value;
 return env;
}
const CLAUDE_SOCKET_PATH_LIMIT=44;
/**
 * Private temporary root for one Claude run. Claude Code derives its always-writable sandbox temp root as
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>` and falls back to the shared `/tmp/claude-<uid>` when that path exceeds
 * its 44-byte socket limit, so the root stays short and outside the shared per-uid directory.
 */
export function claudeTemporaryDirectory(bridgeConfigPath:string) {
 const uid=process.getuid?.()??0;
 const path=`/tmp/wzc-${createHash('sha256').update(resolve(bridgeConfigPath)).digest('hex').slice(0,12)}`;
 assert(Buffer.byteLength(join(path,`claude-${uid}`))<=CLAUDE_SOCKET_PATH_LIMIT,'Claude temporary root exceeds the sandbox socket path limit');
 mkdirSync(path,{recursive:true,mode:0o700});
 const info=lstatSync(path);
 assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===uid,'Claude temporary root is not a private directory owned by this user');
 if((info.mode&0o077)!==0)chmodSync(path,0o700);
 return {path,real:realpathSync(path)};
}
function sharedClaudeTemporaryRoots() {
 const uid=process.getuid?.()??0;
 return ['/tmp/claude','/private/tmp/claude',`/tmp/claude-${uid}`,`/private/tmp/claude-${uid}`];
}
export const CLAUDE_OUTCOME_SCHEMA={type:'object',additionalProperties:false,required:['status','summary'],properties:{status:{type:'string',enum:['completed','blocked','needs_owner'],description:'completed only when the approved scope is done and checked; blocked when it cannot be finished; needs_owner when an owner decision is required.'},summary:{type:'string',description:'What was done, checks run, and what remains or blocks completion.'}}};
function claudeOutcome(value:any,fallback:string):{status:'completed'|'blocked'|'needs_owner';summary:string} {
 if(value&&typeof value==='object'&&['completed','blocked','needs_owner'].includes(value.status)&&typeof value.summary==='string'&&value.summary.trim())return {status:value.status,summary:value.summary.trim().slice(0,12000)};
 return {status:'blocked',summary:`Claude ended without an explicit completion status. Final message: ${String(fallback??'').slice(0,4000)}`};
}
const CLAUDE_SECRET=/(sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^\s"',}]+)/gi;
/** Bounded, credential-free description of a failed Claude result, led by the most specific error code available. */
export function claudeFailureMessage(message:any,assistantError?:string) {
 const detail=[...(Array.isArray(message?.errors)?message.errors:[]),typeof message?.result==='string'?message.result:''].map(value=>String(value).trim()).filter(Boolean).join('; ');
 const code=detail.match(/(?:apiErrorCode|api_error_code|error_code|errorCode)\W{1,4}([a-z][a-z0-9_]{2,80})/i)?.[1]??assistantError??(message?.subtype&&message.subtype!=='success'?message.subtype:undefined)??'claude_run_failed';
 const context=[message?.subtype,message?.terminal_reason,typeof message?.api_error_status==='number'?`HTTP ${message.api_error_status}`:undefined].filter(value=>typeof value==='string'&&value&&value!==code).join(', ');
 return `${code}: ${context?`${context}: `:''}${detail||'Claude Agent SDK reported a failed run'}`.replace(CLAUDE_SECRET,'[redacted]').replace(/[\r\n]+/g,' ').slice(0,1000);
}
const CLAUDE_WRITE_TOOLS=['Edit','Write','MultiEdit','NotebookEdit'];
const CLAUDE_STRUCTURED_OUTPUT_TOOL='StructuredOutput';
function existingRealPath(path:string) {
 let ancestor=resolve(path);const suffix:string[]=[];
 while(!existsSync(ancestor)&&dirname(ancestor)!==ancestor){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
 return resolve(realpathSync(ancestor),...suffix);
}
function inside(root:string,path:string){const part=relative(root,path);return part===''||(!part.startsWith('..')&&!isAbsolute(part));}
/** Checks listed tools and direct path arguments. Bash commands and recursive search results are not inspected; this is not a shell sandbox guarantee. */
export function claudeToolGuard(input:{cwd:string;write:boolean;readRoots?:string[]}) {
 const workspace=existingRealPath(input.cwd);
 const readRoots=[workspace,...(input.readRoots??[]).filter(path=>isAbsolute(path)).map(existingRealPath)];
 const protectedPaths=['.git','.claude','.codex','.wimzo'].map(name=>join(workspace,name));
 const builtins=input.write?['Read','Glob','Grep','Edit','Write','MultiEdit','Bash']:['Read','Glob','Grep'];
 return (tool:string,toolInput:any):{allowed:true}|{allowed:false;reason:string}=>{
  if(tool.startsWith('mcp__wimzo__')||tool===CLAUDE_STRUCTURED_OUTPUT_TOOL)return {allowed:true};
  if(!builtins.includes(tool))return {allowed:false,reason:`Tool ${tool} is outside the approved Claude worker scope`};
  if(tool==='Bash')return {allowed:true};
  const supplied=toolInput?.file_path??toolInput?.notebook_path??toolInput?.path;
  if(supplied!==undefined&&typeof supplied!=='string')return {allowed:false,reason:'Tool path is invalid'};
  const requested=resolve(workspace,supplied??'.');
  const target=existingRealPath(requested);
  const sensitive=(path:string)=>(inside(workspace,path)?relative(workspace,path):path).split('/').some(part=>/^\.env(?:\.|$)/.test(part)||['.git','.claude','.codex','.wimzo'].includes(part));
  if(sensitive(requested)||sensitive(target))return {allowed:false,reason:'Environment files and protected folders are not available through direct Claude file tools'};
  if(CLAUDE_WRITE_TOOLS.includes(tool))return inside(workspace,target)&&!protectedPaths.some(path=>inside(path,target))?{allowed:true}:{allowed:false,reason:'Direct write path is outside the approved task worktree'};
  return readRoots.some(root=>inside(root,target))?{allowed:true}:{allowed:false,reason:'Direct read path is outside the approved read roots'};
 };
}
export function claudeOptions(options:SdkOptions) {
 assert(options.approvedClaudeAuth===true,'Claude Agent SDK has no confirmed supported authentication route under the current no-paid-API policy');
 const temporary=claudeTemporaryDirectory(options.bridgeConfigPath);
 const env:Record<string,string>={...claudeEnvironment(options.env),CLAUDE_CODE_TMPDIR:temporary.path,TMPDIR:temporary.path};
 const workspace=existingRealPath(options.cwd);
 const gitWorktreeDir=options.permissionPaths?.gitWorktreeDir;
 const guard=claudeToolGuard({cwd:workspace,write:options.write,readRoots:[options.permissionPaths?.gitCommonDir,gitWorktreeDir,...(options.permissionPaths?.runtimeReadPaths??[])].filter((path):path is string=>typeof path==='string')});
 const tools=options.write?['Read','Glob','Grep','Edit','Write','Bash']:['Read','Glob','Grep'];
 const preToolUse=async(input:any)=>{
  let decision=guard(String(input?.tool_name??''),input?.tool_input);
  if(decision.allowed)try{options.assertAuthorized?.();}catch(error){decision={allowed:false,reason:String((error as Error).message)};}
  return decision.allowed?{continue:true}:{hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:'deny' as const,permissionDecisionReason:decision.reason}};
 };
 return {cwd:workspace,model:options.model,...(options.thinking?{effort:options.thinking as any}:{}),settingSources:[] as any[],env,tools,permissionMode:'dontAsk' as const,outputFormat:{type:'json_schema' as const,schema:CLAUDE_OUTCOME_SCHEMA},allowedTools:[...tools,CLAUDE_STRUCTURED_OUTPUT_TOOL,'mcp__wimzo__*'],disallowedTools:['WebFetch','WebSearch','Agent','Task',...(options.write?[]:['Edit','Write','Bash'])],strictMcpConfig:true,hooks:{PreToolUse:[{hooks:[preToolUse]}]},sandbox:{enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,network:{allowedDomains:[] as string[],strictAllowlist:true,allowLocalBinding:false,allowAllUnixSockets:false},filesystem:{allowWrite:[...(options.write?[workspace,...(gitWorktreeDir?[gitWorktreeDir]:[])]:[]),temporary.real],denyWrite:[...['.git','.claude','.codex','.wimzo'].map(name=>join(workspace,name)),...sharedClaudeTemporaryRoots()]}},mcpServers:{wimzo:{command:process.execPath,args:[resolve(import.meta.dirname,'worker-bridge.ts'),options.bridgeConfigPath]}},maxTurns:claudeMaxTurns(options.maxTurns),...(options.claudeExecutable?{pathToClaudeCodeExecutable:options.claudeExecutable}:{}),...(options.sessionId?{resume:options.sessionId}:{})};
}
export async function runClaude(options:SdkOptions,dependencies:{query?:any}={}) {
 options.assertAuthorized?.();
 const initial=contextDecision(estimateContextTokens(options.prompt),options.contextCapacity??null,options.contextPolicy);
 assert(initial.action==='continue','Initial context exceeds the bounded run threshold; split the task before inference');
 const settings=claudeOptions(options);const run=(dependencies.query??query)({prompt:options.prompt,options:settings});
 const stop=()=>{void Promise.resolve(run.interrupt?.()).catch(()=>{});};options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop();
 let authorizationError:unknown;const policyTimer=options.assertAuthorized?setInterval(()=>{try{options.assertAuthorized!();}catch(error){authorizationError=error;stop();}},1000):undefined;policyTimer?.unref();
 let summary='',sessionId=options.sessionId,usage:any=null,context:any={used:null,capacity:null,estimated:false},needsContinuation=false,structured:unknown,assistantError:string|undefined;
 try{for await(const message of run){
  options.assertAuthorized?.();
  if(message.session_id){sessionId=message.session_id;options.onEvent({type:'session',sessionId});}
  if(message.type==='assistant'){
    if(typeof message.error==='string')assistantError=message.error;
    const current=message.message?.usage;if(current){const used=(current.input_tokens??0)+(current.cache_read_input_tokens??0)+(current.cache_creation_input_tokens??0);context={used,capacity:options.contextCapacity??null,estimated:false,source:'Claude SDK latest assistant usage'};options.onEvent({type:'usage',context});const decision=contextDecision(used,options.contextCapacity??null,options.contextPolicy);if(decision.action==='checkpoint'||decision.action==='stop'){needsContinuation=true;options.onEvent({type:'context_checkpoint',decision});await run.interrupt();}}
    options.onEvent({type:'progress',summary:'Claude is working on the scoped task'});
  }
  if(message.type==='result'){usage=message.usage;if(message.subtype==='error_max_turns'){needsContinuation=true;summary=`Reached the run turn limit (${claudeMaxTurns(options.maxTurns)}). Worktree changes are preserved for a fresh bounded continuation.`;options.onEvent({type:'turn_limit_checkpoint'});continue;}if(message.is_error||message.subtype!=='success'&&typeof message.subtype==='string')throw new Error(claudeFailureMessage(message,assistantError));summary=message.result??'Claude run finished';structured=message.structured_output;}
 }}catch(error){stop();if(authorizationError)throw authorizationError;throw error;}finally{if(policyTimer)clearInterval(policyTimer);options.signal?.removeEventListener('abort',stop);}
 if(authorizationError)throw authorizationError;
 if(needsContinuation)return {summary,sessionId,usage,context,needsContinuation};
 const outcome=claudeOutcome(structured,summary);
 return {summary:outcome.summary,outcome:outcome.status,sessionId,usage,context,needsContinuation};
}
