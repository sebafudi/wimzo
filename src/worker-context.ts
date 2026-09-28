import { approvedWorkflowFeature } from './workflow-authority.ts';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { Store, assert, now, hash } from './store.ts';
import { saveRunChangelog, workerChangelog } from './run-changelog.ts';

export function estimateContextTokens(value:string) { return Math.ceil(Buffer.byteLength(value,'utf8')/2); }

export const DEFAULT_CONTEXT_POLICY = { targetTokens:150_000, checkpointTokens:120_000, reserveTokens:30_000, exceptionMaxTokens:180_000 };
export function contextBudget(value: unknown) {
  if (value === undefined) return undefined;
  assert(value && typeof value === 'object' && !Array.isArray(value), 'budget.context must be an object');
  const context: any = value;
  const reason = context.exceptionReason;
  assert(reason === undefined || typeof reason === 'string' && reason.trim() && reason.length <= 1000, 'context.exceptionReason must be a bounded non-empty string');
  const target = context.targetTokens ?? DEFAULT_CONTEXT_POLICY.targetTokens;
  const cap = context.exceptionMaxTokens ?? context.maxTokens ?? DEFAULT_CONTEXT_POLICY.exceptionMaxTokens;
  assert(Number.isInteger(target) && target > 0 && Number.isInteger(cap) && cap > 0, 'Context token targets must be positive integers');
  assert(target <= DEFAULT_CONTEXT_POLICY.exceptionMaxTokens && cap <= DEFAULT_CONTEXT_POLICY.exceptionMaxTokens, `Context exception cap is ${DEFAULT_CONTEXT_POLICY.exceptionMaxTokens} tokens`);
  assert(target <= DEFAULT_CONTEXT_POLICY.targetTokens || reason, `Context targets above ${DEFAULT_CONTEXT_POLICY.targetTokens} tokens require context.exceptionReason`);
  return context;
}
export function contextDecision(used: number | null, capacity: number | null, policy: any = {}, exceptionReason?: string) {
  const { exceptionReason: policyReason, ...thresholds } = policy ?? {};
  exceptionReason ??= typeof policyReason === 'string' ? policyReason : undefined;
  const config={...DEFAULT_CONTEXT_POLICY,...thresholds};
  for(const value of Object.values(config)) assert(typeof value==='number'&&Number.isFinite(value)&&value>0,'Invalid context policy');
  assert(config.checkpointTokens<config.targetTokens&&config.targetTokens<=config.exceptionMaxTokens,'Invalid context threshold order');
  assert(config.targetTokens<=DEFAULT_CONTEXT_POLICY.targetTokens||exceptionReason?.trim(),`Context targets above ${DEFAULT_CONTEXT_POLICY.targetTokens} tokens require an exception reason`);
  const requested=exceptionReason?.trim()?config.exceptionMaxTokens:config.targetTokens;
  const limit=Math.min(requested,capacity===null?requested:Math.max(0,capacity-config.reserveTokens));
  const checkpointAt=Math.min(config.checkpointTokens,Math.max(0,limit-config.reserveTokens));
  return {used,capacity,limit,checkpointAt,exceptionReason:exceptionReason?.trim()||null,action:used===null?'unknown':used>=limit?'stop':used>=checkpointAt?'checkpoint':'continue'};
}

function activeWorkerTask(store: Store, taskId: string, runId: string) {
  const task = store.require<any>('task', taskId);
  assert(task.runId === runId && task.state === 'Running', 'Worker run is stale');
  const run = store.require<any>('run', runId);
  assert(run.taskId === taskId && run.projectId === task.projectId, 'Worker run is stale');
  return task;
}

function pageNumber(value: unknown, fallback: number, maximum: number, label: string) {
  if (value === undefined) return fallback;
  assert(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum, `${label} is invalid`);
  return Number(value);
}

export function readWorkerSpecification(store: Store, taskId: string, runId: string, input: any = {}) {
  const task = activeWorkerTask(store, taskId, runId);
  const requestedId = typeof input.specId === 'string' && input.specId.trim();
  assert(requestedId, 'specId is required');
  const allowed = new Map<string, { id: string; hash: string; rev: number; path?: string }>();
  const add = (reference: any) => {
    assert(reference && typeof reference.id === 'string' && typeof reference.hash === 'string' && Number.isInteger(reference.rev), 'Owner-approved specification reference is invalid');
    const existing = allowed.get(reference.id);
    assert(!existing || existing.hash === reference.hash && existing.rev === reference.rev, 'Owner-approved specification references conflict');
    allowed.set(reference.id, { id: reference.id, hash: reference.hash, rev: reference.rev, ...(typeof reference.path === 'string' ? { path: reference.path } : {}) });
  };
  const primary = store.require<any>('spec', task.specId);
  assert(primary.projectId === task.projectId && primary.hash === task.specHash && primary.status === 'Accepted' && hash(primary.content) === primary.hash, 'Worker specification is stale');
  add({ id: task.specId, hash: task.specHash, rev: primary.rev, path: primary.path });
  const featureId = typeof task.workflow?.featureId === 'string' ? task.workflow.featureId : null;
  if (task.workflow?.purpose === 'requirements_preparation') {
    assert(featureId, 'Requirements preparation is not bound to a feature');
    const feature = store.require<any>('workflow_feature', featureId);
    assert(feature.projectId === task.projectId && feature.preparationTaskId === task.id, 'Requirements preparation is stale');
    const authorizationId = task.inheritedAuthorization?.ownerApprovalId;
    const authorization = store.require<any>('workflow_owner_approval', authorizationId);
    assert(authorization.projectId === task.projectId && authorization.actor?.role === 'owner', 'Requirements preparation authorization is unavailable');
    const workflowConfig = store.require<any>('workflow_config', task.projectId);
    assert(workflowConfig.enabled === true, 'Requirements preparation workflow is disabled');
    if (authorization.kind === 'configuration') assert(authorization.id === workflowConfig.approvalId, 'Requirements preparation configuration approval is stale');
    else {
      assert(authorization.kind === 'requirements_revision' && authorization.sourceOwnerApprovalId === workflowConfig.approvalId, 'Requirements preparation revision approval is stale');
      const configurationApproval = store.require<any>('workflow_owner_approval', workflowConfig.approvalId);
      assert(configurationApproval.kind === 'configuration' && configurationApproval.projectId === task.projectId && configurationApproval.actor?.role === 'owner', 'Requirements preparation configuration approval is unavailable');
    }
    const references = task.workflow.preparationSpecs;
    assert(Array.isArray(references) && references.length > 0 && references.length <= 200, 'Requirements preparation specification index is invalid');
    for (const reference of references) add(reference);
  } else if (featureId) {
    const {owner: approval} = approvedWorkflowFeature(store,task);
    assert(approval.kind === 'feature' && approval.projectId === task.projectId && approval.actor?.role === 'owner', 'Workflow owner approval is unavailable');
    for (const reference of approval.approvedSpecs ?? []) add(reference);
    if (typeof approval.specId === 'string' && typeof approval.specHash === 'string' && Number.isInteger(approval.specRev)) add({ id: approval.specId, hash: approval.specHash, rev: approval.specRev });
  }
  const reference = allowed.get(requestedId);
  assert(reference, 'Specification is not part of this task’s owner-approved scope');
  const spec = store.require<any>('spec', requestedId);
  assert(spec.projectId === task.projectId && spec.status === 'Accepted' && spec.hash === reference.hash && spec.rev === reference.rev && hash(spec.content) === spec.hash, 'Owner-approved specification is stale');
  if (reference.path !== undefined) assert(spec.path === reference.path, 'Owner-approved specification path changed');
  const offset = pageNumber(input.offset, 0, 10_000_000, 'offset');
  const maxChars = pageNumber(input.maxChars, 12_000, 30_000, 'maxChars');
  assert(maxChars > 0, 'maxChars is invalid');
  const content = spec.content.slice(offset, offset + maxChars);
  const nextOffset = offset + content.length;
  return { spec: { id: spec.id, path: spec.path, hash: spec.hash, rev: spec.rev, status: spec.status }, offset, maxChars, content, truncated: nextOffset < spec.content.length, nextOffset: nextOffset < spec.content.length ? nextOffset : null };
}

export function workerContext(store:Store,taskId:string,runId?:string) {
  const task=store.require('task',taskId),project=store.require('project',task.projectId);
  if(runId) assert(task.runId===runId&&task.state==='Running','Worker run is stale');
  const run=runId?store.require('run',runId):null;
  if(runId) assert(run?.taskId===taskId&&run?.projectId===project.id,'Worker run is stale');
  const spec=store.require('spec',task.specId);
  assert(spec.projectId===project.id&&spec.hash===task.specHash&&spec.status==='Accepted','Worker specification is stale');
  const source={path:spec.path,hash:spec.hash,content:spec.content,status:spec.status};
  const instructions:any[]=[];
  const executionRoot=typeof run?.cwd==='string'?realpathSync(run.cwd):null;
  if(executionRoot){const rel=relative(realpathSync(project.root),executionRoot);assert(!rel.startsWith('..')&&!isAbsolute(rel),'Worker instruction context escapes its project');}
  const roots=[project.root,typeof task.worktree==='string'?task.worktree:null,executionRoot].filter(Boolean).map(root=>existsSync(root)?realpathSync(root):root);
  for(const root of [...new Set(roots)])for(const filename of ['AGENTS.md','README.md']){
    const path=resolve(root,filename);if(!existsSync(path))continue;
    const actual=realpathSync(path),rel=relative(realpathSync(root),actual);
    assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Repository instruction escapes its root');
    const content=readFileSync(actual,'utf8');
    instructions.push({path,origin:root===executionRoot?'execution-worktree':'project',content:content.slice(0,filename==='AGENTS.md'?16000:12000),truncated:content.length>(filename==='AGENTS.md'?16000:12000)});
  }
  const handoffs=store.list('worker_checkpoint').filter(x=>x.taskId===taskId).slice(-2).map(x=>({at:x.at,summary:x.summary,next:x.next,checks:x.checks,candidate:x.candidate}));
  const policy=store.get('project_worker_policy',project.id);
  const featureId=typeof task.workflow?.featureId==='string'?task.workflow.featureId:null;
  const feature=featureId?store.get<any>('workflow_feature',featureId):null;
  assert(!feature||feature.projectId===project.id,'Workflow feature belongs to another project');
  const workflowFeature=feature?{id:feature.id,phase:feature.phase??null,objective:String(feature.objective??task.objective??'').slice(0,1000),scope:String(feature.scope??'').slice(0,8000),criteria:Array.isArray(feature.criteria)?feature.criteria.filter((value:any)=>typeof value==='string').slice(0,40):[],implementationBudget:feature.implementationBudget??null,implementationWorkBudget:feature.implementationWorkBudget??null,profiles:{default:feature.profile??null,planning:feature.planningProfile??null,implementation:feature.implementationProfile??null},sourceCandidate:feature.sourceCandidate??null,acceptedDocuments:store.list<any>('workflow_document').filter(document=>document.featureId===feature.id&&document.status==='Accepted').slice(0,20).map(document=>({id:document.id,path:document.path,baseHash:document.baseHash,proposedHash:document.proposedHash,acceptedSpec:document.acceptedSpec??null})),acceptedSpecs:Array.isArray(feature.acceptedSpecs)?feature.acceptedSpecs.slice(0,20):[]}:null;
  const preparationSpecs=task.workflow?.purpose==='requirements_preparation'&&Array.isArray(task.workflow.preparationSpecs)?task.workflow.preparationSpecs.slice(0,200).map((reference:any)=>({id:reference?.id,path:reference?.path,hash:reference?.hash,rev:reference?.rev})):null;
  const packet={project:{id:project.id,name:project.name,root:project.root},task:{id:task.id,objective:task.objective,scope:task.scope,criteria:task.criteria,permissions:task.permissions,sourceCandidate:task.sourceCandidate,runSourceCandidate:run?.sourceCandidate??null,resolvedWorkflowSource:run?.resolvedWorkflowSource??null,dependencySetup:run?.dependencySetup?{status:run.dependencySetup.status,dependencyRoot:run.dependencySetup.dependencyRoot??null,donor:run.dependencySetup.donor??null,reason:run.dependencySetup.reason??null}:null,workflow:task.workflow&&typeof task.workflow==='object'?{featureId,purpose:task.workflow.purpose??null,reworkOf:task.workflow.reworkOf??null,reworkApprovalId:task.workflow.reworkApprovalId??null,targetTaskId:task.workflow.targetTaskId??null,targetCandidate:task.workflow.targetCandidate??null,continuation:task.workflow.continuation??null,preparationSpecs,feature:workflowFeature}:null,deadline:task.deadline,budget:task.budget},specification:source,instructions,handoffs,policy:policy?.policy??null,contextPolicy:{...DEFAULT_CONTEXT_POLICY,...task.budget?.context},guidance:['Use wimzo_specification to read a listed immutable accepted specification. Requirements preparation may use only task.workflow.preparationSpecs as its proposal base; other roles may use only owner-approved feature references.'],omissions:['Unrelated projects','Unselected specifications','Provider credentials','Full conversation history']};
  const text=JSON.stringify(packet);
  assert(Buffer.byteLength(text,'utf8')<=220_000,'Initial worker context is too large; split this task or its specification before launching');
  return {...packet,receipt:{at:now(),estimatedInputTokens:estimateContextTokens(text),estimated:true,sourceHash:hash(text)}};
}
export function saveWorkerCheckpoint(store:Store,taskId:string,runId:string,input:any) {
  const task=store.require('task',taskId),run=store.require('run',runId);
  assert(task.runId===runId&&run.taskId===taskId&&task.state==='Running','Worker checkpoint belongs to an inactive run');
  assert(typeof input.summary==='string'&&input.summary.trim()&&input.summary.length<=12000,'A bounded checkpoint summary is required');
  const submission=typeof input.submissionId==='string'?input.submissionId:hash(JSON.stringify(input));
  const key=hash(JSON.stringify([runId,submission]));const prior=store.get('worker_checkpoint',key);if(prior)return prior;
  const saved=store.tx(()=>{const checkpoint=store.put('worker_checkpoint',{id:key,taskId,runId,projectId:task.projectId,at:now(),summary:input.summary,next:String(input.next??'').slice(0,12000),checks:Array.isArray(input.checks)?input.checks.slice(0,30):[],candidate:input.candidate??null,changelog:workerChangelog(input.changelog)});store.event('worker.checkpoint.saved',task.projectId,{taskId,runId,checkpointId:checkpoint.id});return checkpoint;});
  saveRunChangelog(store,runId,'checkpoint');
  return saved;
}
