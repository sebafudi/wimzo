import test from 'node:test';
import assert from 'node:assert/strict';
import {codexOptions,runCodex,runClaude,claudeOptions,type SdkOptions} from '../src/sdk-workers.ts';
const base:SdkOptions={cwd:'/tmp/fixture',model:'fixture-model',thinking:'low',write:false,prompt:'Read only the approved fixture',env:{HOME:'/tmp/home',OPENAI_API_KEY:'fixture-secret',ANTHROPIC_AUTH_TOKEN:'fixture-secret',PATH:'/usr/bin'},bridgeConfigPath:'/tmp/sdk-config.json',onEvent:()=>{}};
test('Codex SDK carries exact profile, scoped bridge and subscription-only environment',async()=>{
 let configured:any,threadOptions:any;const events:any[]=[];
 class FakeCodex{constructor(options:any){configured=options;}startThread(options:any){threadOptions=options;return {async runStreamed(){return {events:(async function*(){yield {type:'thread.started',thread_id:'real-session'};yield {type:'item.completed',item:{type:'agent_message',text:'Checked fixture'}};yield {type:'turn.completed',usage:{input_tokens:42,output_tokens:5,cached_input_tokens:0}};})()};}};}}
 const result=await runCodex({...base,onEvent:e=>events.push(e)},{Codex:FakeCodex});
 assert.equal(configured.env.OPENAI_API_KEY,undefined);assert.equal(configured.env.ANTHROPIC_AUTH_TOKEN,undefined);
 assert.equal(configured.config.forced_login_method,'chatgpt');assert.equal(configured.config.mcp_servers.wimzo.args.at(-1),base.bridgeConfigPath);
 assert.deepEqual([threadOptions.model,threadOptions.modelReasoningEffort,threadOptions.sandboxMode,threadOptions.approvalPolicy,threadOptions.networkAccessEnabled],['fixture-model','low',undefined,'never',undefined]);assert.equal(configured.config.default_permissions,'wimzo-workspace-v1');assert.match(configured.env.WIMZO_CODEX_PERMISSION_OVERRIDES,/:read-only/);
 assert.equal(configured.env.TMPDIR,undefined);assert.equal(configured.env.TMP,undefined);assert.equal(configured.env.TEMP,undefined);assert.match(JSON.parse(configured.env.WIMZO_CODEX_PERMISSION_OVERRIDES)[0],/":tmpdir"="deny"/);assert.match(JSON.parse(configured.env.WIMZO_CODEX_PERMISSION_OVERRIDES)[0],/\.wimzo\/codex-scratch\/[a-f0-9]{64}"="write"/);
 assert.equal(result.summary,'Checked fixture');assert.equal(result.sessionId,'real-session');assert.equal(result.context.estimated,true);assert.ok(result.context.used<42);assert.equal(result.usage.input_tokens,42);assert.equal(events.at(-1).type,'usage');
});
test('Codex context threshold returns a durable continuation indication without another turn',async()=>{
 let turns=0;const events:any[]=[];
 class FakeCodex{startThread(){return {async runStreamed(){turns++;return {events:(async function*(){yield {type:'thread.started',thread_id:'context-session'};yield {type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(300)}};throw new Error('Abort fixture');})()};}};}}
 const result=await runCodex({...base,prompt:'short',contextPolicy:{targetTokens:150,checkpointTokens:80,reserveTokens:20,exceptionMaxTokens:180},onEvent:e=>events.push(e)},{Codex:FakeCodex});
 assert.equal(turns,1);assert.equal(result.needsContinuation,true);assert.equal(result.sessionId,'context-session');assert.ok(events.some(e=>e.type==='context_checkpoint'));
 let initialized=false;class Never{constructor(){initialized=true;}}
 await assert.rejects(runCodex({...base,prompt:'x'.repeat(500),contextPolicy:{targetTokens:150,checkpointTokens:80,reserveTokens:20,exceptionMaxTokens:180}},{Codex:Never}),/Initial context/);assert.equal(initialized,false);
});
test('Codex context threshold also stops an agent-message-only turn',async()=>{
 const events:any[]=[];
 class FakeCodex{startThread(){return {async runStreamed(){return {events:(async function*(){yield {type:'thread.started',thread_id:'message-context-session'};yield {type:'item.completed',item:{type:'agent_message',text:'x'.repeat(400)}};yield {type:'turn.completed',usage:{input_tokens:400}};})()};}};}}
 const result=await runCodex({...base,prompt:'short',contextPolicy:{targetTokens:150,checkpointTokens:80,reserveTokens:20,exceptionMaxTokens:180},onEvent:e=>events.push(e)},{Codex:FakeCodex});
 assert.equal(result.needsContinuation,true);assert.ok(events.some(e=>e.type==='context_checkpoint'));
});
test('Claude SDK cannot start without a supported authentication route',async()=>{
 let called=false;await assert.rejects(runClaude(base,{query:()=>{called=true;}}),/no confirmed supported authentication route/);assert.equal(called,false);
 const settings=claudeOptions({...base,approvedClaudeAuth:true});assert.deepEqual(settings.settingSources,[]);assert.equal(settings.sandbox.failIfUnavailable,true);assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(settings.effort,'low');
 assert.equal(codexOptions(base).env.HOME,'/tmp/home');
});
test('revoked project policy aborts an active SDK stream and preserves the denial reason',async()=>{
 let checks=0;let signal:AbortSignal|undefined;
 class FakeCodex{startThread(){return {async runStreamed(_prompt:string,options:any){signal=options.signal;return {events:(async function*(){yield {type:'thread.started',thread_id:'revoked-session'};})()};}};}}
 await assert.rejects(runCodex({...base,assertAuthorized:()=>{if(++checks>1)throw new Error('Project worker policy revoked');}},{Codex:FakeCodex}),/Project worker policy revoked/);
 assert.equal(signal?.aborted,true);
});
test('Claude stream failure interrupts the session and refuses an oversized initial context',async()=>{
 let interrupted=false;
 const query=()=>({interrupt:async()=>{interrupted=true;},async *[Symbol.asyncIterator](){throw new Error('Fixture stream failed');}});
 await assert.rejects(runClaude({...base,approvedClaudeAuth:true},{query}),/Fixture stream failed/);assert.equal(interrupted,true);
 let started=false;await assert.rejects(runClaude({...base,approvedClaudeAuth:true,prompt:'x'.repeat(500),contextPolicy:{targetTokens:150,checkpointTokens:80,reserveTokens:20,exceptionMaxTokens:180}},{query:()=>{started=true;}}),/Initial context/);assert.equal(started,false);
});
