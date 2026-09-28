import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {App} from '../src/app.ts';
import {runCodex,runClaude} from '../src/sdk-workers.ts';
import {workerContext,saveWorkerCheckpoint} from '../src/worker-context.ts';
import {assertProfileRouteAuthorized} from '../src/worker-profile.ts';
import {assertClaudeAuthorized} from '../src/claude-profile.ts';
import {now} from '../src/store.ts';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));const app=new App(config.stateDir);
const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());process.once('SIGINT',()=>abort.abort());
function persist(event:any){
 app.store.tx(()=>{
 const run=app.store.require('run',config.runId);
 app.store.put('run',{...run,...(event.sessionId?{sdkSessionId:event.sessionId}:{}),...(event.context?{contextTelemetry:{...event.context,observedAt:now()}}:{}),...(event.usage?{sdkUsage:event.usage}:{}),lastProgress:{at:now(),summary:event.summary??event.type}},run.rev);
 });
 if(event.type==='turn_limit_checkpoint')saveWorkerCheckpoint(app.store,config.taskId,config.runId,{summary:'Worker reached its run turn limit. Worktree and process logs are saved.',next:'Start a fresh bounded continuation after inspecting changes and the exact remaining checks.',candidate:config.sourceCandidate,submissionId:'turn-limit'});
 if(event.type==='context_checkpoint')saveWorkerCheckpoint(app.store,config.taskId,config.runId,{summary:'Worker reached its context checkpoint threshold. Worktree and process logs are saved.',next:'Start a fresh bounded continuation after inspecting changes and the exact remaining checks.',candidate:config.sourceCandidate,submissionId:'context-threshold'});
}
function assertAuthorized(){
 const task=app.store.require<any>('task',config.taskId);if(task.runId!==config.runId||task.state!=='Running')throw new Error('Worker run is no longer active');
 assertProfileRouteAuthorized(app.store,task);
 if(config.runtime==='claude')assertClaudeAuthorized(app.store);
}
try{
 const packet=workerContext(app.store,config.taskId,config.runId);
 const prompt=['Work only within this approved task and isolated workspace.', 'Use wimzo_context, wimzo_phase and wimzo_checkpoint tools. Save meaningful progress and a final checkpoint. Do not accept requirements or results, publish source, invoke another model runtime, or alter provider authentication. Never change billing routes.','Plan before implementation. Keep responses and tool results bounded. If the work cannot fit, save a precise handoff and stop.',...(config.write&&!packet.task.workflow?['Before stopping, commit only your intended changes and leave the worktree clean. Uncommitted changes pause the task instead of being collected.']:[]),'In wimzo_checkpoint, include a plain-language changelog: what changed for the user, what is possible now, availability and limits. Say plainly when nothing new became available.','Task context:',JSON.stringify(packet)].join('\n');
 const options={...config,prompt,env:config.env??{},bridgeConfigPath:process.argv[2],signal:abort.signal,onEvent:persist,assertAuthorized};
 let result:any;
 if(config.runtime==='codex')result=await runCodex(options);
 else if(config.runtime==='claude')result=await runClaude(options);
 else if(config.runtime==='pi'){
  const {runPi}=await import('../src/pi-sdk.ts');
  const {scopedWorkerTools}=await import('../src/worker-bridge.ts');const bridge=scopedWorkerTools(app,config.taskId,config.runId);
  const customTools=bridge.definitions.map(d=>({name:d.name,label:d.name,description:d.description,parameters:d.inputSchema,execute:async(_id:string,args:any)=>({content:[{type:'text',text:JSON.stringify(await bridge.invoke(d.name,args))}],details:{}})}));
  result=await runPi({...options,model:config.model,sessionDir:config.sessionDir,customTools,policyCheck:assertAuthorized});
 }else throw new Error('Unsupported SDK harness');
 const stoppedEarly=result.outcome!==undefined&&result.outcome!=='completed';
 app.store.tx(()=>{const run=app.store.require('run',config.runId);app.store.put('run',{...run,sdkResult:result,sdkSessionId:result.sessionId??null,sdkUsage:result.usage??null,contextTelemetry:{...result.context,observedAt:now()},needsContinuation:result.needsContinuation===true,...(stoppedEarly?{workerOutcome:{status:result.outcome,summary:String(result.summary).slice(0,12000)}}:{})},run.rev);});
 saveWorkerCheckpoint(app.store,config.taskId,config.runId,{summary:String(result.summary).slice(0,12000),next:result.needsContinuation?'Continue from the saved candidate in a fresh bounded run.':stoppedEarly?`Worker reported ${result.outcome}. Review the saved candidate and resolve the blocker before a fresh continuation.`:'Run independent verification and review the exact candidate.',candidate:config.sourceCandidate,submissionId:'sdk-final'});
 const output=JSON.stringify(result,null,2);const temp=config.resultFile+'.tmp';writeFileSync(temp,output,{mode:0o600});renameSync(temp,config.resultFile);process.stdout.write(result.summary+'\n');
 if(result.needsContinuation)process.exitCode=75;else if(stoppedEarly)process.exitCode=76;
}catch(error){const message=String((error as Error).message).slice(0,2000);try{app.store.tx(()=>{const run=app.store.require('run',config.runId);app.store.put('run',{...run,error:message},run.rev);});}catch{}process.stderr.write(message+'\n');process.exitCode=1;}finally{await app.close();}
