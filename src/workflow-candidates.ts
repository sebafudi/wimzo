import { approvedWorkflowFeature } from './workflow-authority.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { assert, hash, type Store } from './store.ts';
const execute=promisify(execFile);
const exact=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
function environment(extra:NodeJS.ProcessEnv={}) {return {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'C',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Wimzo worker',GIT_AUTHOR_EMAIL:'worker@wimzo.local',GIT_COMMITTER_NAME:'Wimzo worker',GIT_COMMITTER_EMAIL:'worker@wimzo.local',...extra};}
async function git(cwd:string,args:string[],extra:NodeJS.ProcessEnv={}){const value=await execute('git',['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd,env:environment(extra),timeout:30000,maxBuffer:4*1024*1024});return value.stdout.trim();}
async function commitTree(cwd:string,tree:string,parents:string[],message:string) {
 const dates=await Promise.all(parents.map(parent=>git(cwd,['show','-s','--format=%ct',parent])));
 const seconds=Math.max(...dates.map(Number))+1;assert(Number.isSafeInteger(seconds)&&seconds>0,'Invalid candidate parent timestamp');
 const date=`${seconds} +0000`;
 return git(cwd,['commit-tree',tree,...parents.flatMap(parent=>['-p',parent]),'-m',message],{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date});
}

// The temporary index leaves both the worktree and its ordinary index untouched.
export async function materializeCandidate(cwd:string,candidate:any,runId:string,stateDir:string) {
 const base=candidate.baseCommit??candidate.id;assert(typeof base==='string'&&exact.test(base),'Workflow candidate needs an exact Git base');
 assert(await git(cwd,['rev-parse','HEAD'])===base,'Workflow candidate HEAD changed before snapshot');
 if(candidate.dirty!==true)return {...candidate,materializedCommit:base};
 const folder=join(stateDir,'runs',runId);mkdirSync(folder,{recursive:true,mode:0o700});const index=join(folder,`candidate-index-${hash(JSON.stringify(candidate)).slice(0,16)}`);
 try{await git(cwd,['read-tree',base],{GIT_INDEX_FILE:index});await git(cwd,['add','-A','--','.'],{GIT_INDEX_FILE:index});const tree=await git(cwd,['write-tree'],{GIT_INDEX_FILE:index});const commit=await commitTree(cwd,tree,[base],`Wimzo bounded worker candidate ${runId}`);assert(exact.test(commit),'Invalid materialized candidate');await git(cwd,['update-ref',`refs/wimzo/candidates/${hash(runId).slice(0,24)}`,commit]);return {...candidate,materializedCommit:commit};}
 finally{rmSync(index,{force:true});rmSync(index+'.lock',{force:true});}
}
function sameCandidate(left:any,right:any){return JSON.stringify(left)===JSON.stringify(right);}

function verifiedCommit(store:Store,target:any,candidate:any){assert(sameCandidate(target.candidate,candidate),'Workflow dependency candidate changed');assert(['Needs result review','Accepted'].includes(target.state)&&target.dimensions?.verified===true,'Workflow dependency is not verified');const commit=candidate.materializedCommit;assert(typeof commit==='string'&&exact.test(commit),'Workflow dependency has no materialized source');return commit;}
export async function workflowSource(store:Store,task:any,repository:string) {
 if(!task.workflow?.featureId)return null;
 // Requirements preparation has configuration authority, not implementation authority.
 if(task.workflow.purpose==='requirements_preparation'||task.workflow.purpose==='planning')return null;
 const {feature}=approvedWorkflowFeature(store,task);
 if(task.workflow.purpose==='verification'){
  const target=store.require('task',task.workflow.targetTaskId);assert(target.projectId===task.projectId&&target.workflow?.featureId===feature.id&&target.state==='Verifying','Verification target is stale');assert(sameCandidate(target.candidate,task.workflow.targetCandidate),'Verification candidate changed');const commit=target.candidate?.materializedCommit;assert(typeof commit==='string'&&exact.test(commit),'Verification candidate has no materialized source');return {commit,kind:'verification',candidates:[{taskId:target.id,candidate:target.candidate}]};
 }
 const candidates:any[]=[];
 for(const dependencyId of task.dependencies??[]){const target=store.require('task',dependencyId);assert(target.projectId===task.projectId&&target.workflow?.featureId===feature.id,'Workflow dependency belongs to another feature');const receipt=store.require('workflow_continuation',`workflow_continuation:${target.id}:${task.id}`);assert(receipt.projectId===task.projectId&&receipt.featureId===feature.id&&receipt.ownerApprovalId===task.inheritedAuthorization?.ownerApprovalId&&receipt.successorTaskId===task.id&&receipt.specId===target.specId&&receipt.specHash===target.specHash,'Workflow continuation receipt is stale');candidates.push({taskId:target.id,candidate:target.candidate,commit:verifiedCommit(store,target,receipt.candidate)});}
 if(!candidates.length)return null;
 const reworkBase=task.workflow.reworkOf?task.sourceCandidate?.commit:null;
 if(reworkBase)assert(typeof reworkBase==='string'&&exact.test(reworkBase),'Rework source is not an exact candidate');
 let commit=reworkBase??candidates[0].commit;
 for(const item of reworkBase?candidates:candidates.slice(1)){if(item.commit===commit)continue;let tree:string;try{tree=(await git(repository,['merge-tree','--write-tree',commit,item.commit])).split('\n')[0];}catch{throw new Error('Verified worker changes conflict; save an integration plan before continuing');}assert(exact.test(tree),'Workflow merge did not produce an exact tree');commit=await commitTree(repository,tree,[commit,item.commit],`Integrate verified feature dependencies for ${task.id}`);}
 await git(repository,['update-ref',`refs/wimzo/continuations/${hash(task.id).slice(0,24)}`,commit]);
 return {commit,kind:'verified-dependencies',candidates:candidates.map(({taskId,candidate})=>({taskId,candidate}))};
}
