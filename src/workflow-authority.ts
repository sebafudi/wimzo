import { assert, type Store } from './store.ts';

/** Resolve original feature authority plus an exact owner-approved rework receipt. */
export function approvedWorkflowFeature(store:Store,task:any) {
 const feature=store.require('workflow_feature',task.workflow.featureId);
 assert(feature.projectId===task.projectId&&typeof feature.approvalId==='string','Workflow source lacks exact feature approval');
 const owner=store.require('workflow_owner_approval',feature.approvalId);
 assert(owner.actor?.role==='owner'&&owner.projectId===task.projectId,'Workflow source owner approval is unavailable');
 const authorityId=task.inheritedAuthorization?.ownerApprovalId;
 if(authorityId!==feature.approvalId){
  const authority=store.require('workflow_owner_approval',authorityId);
  assert(authority.kind==='result_rework'&&authority.projectId===task.projectId&&authority.featureId===feature.id&&authority.actor?.role==='owner'&&authority.sourceOwnerApprovalId===feature.approvalId,'Workflow rework approval is stale');
  const receipt=store.require('workflow_result_rework',feature.rework?.receiptId);
  assert(receipt.projectId===task.projectId&&receipt.featureId===feature.id&&receipt.reworkApprovalId===authority.id&&receipt.sourceOwnerApprovalId===feature.approvalId,'Workflow rework receipt is stale');
  const boundTask=task.workflow.purpose==='verification'?store.require('task',task.workflow.targetTaskId):task;
  assert(boundTask.projectId===task.projectId&&boundTask.workflow?.featureId===feature.id&&boundTask.inheritedAuthorization?.ownerApprovalId===authorityId,'Workflow rework target authority is stale');
  const replacement=receipt.replacements?.find((value:any)=>value.taskId===boundTask.id);
  assert(replacement&&replacement.rejectedTaskId===boundTask.workflow.reworkOf&&boundTask.workflow.reworkApprovalId===authority.id,'Workflow task is not an approved rework replacement');
  const rejected=authority.children?.find((value:any)=>value.taskId===replacement.rejectedTaskId&&value.taskRev===replacement.rejectedTaskRev);
  assert(rejected&&rejected.candidate?.materializedCommit===boundTask.sourceCandidate?.commit&&rejected.reworkSource?.commit===boundTask.sourceCandidate?.commit,'Workflow rework source differs from the reviewed candidate');
 }
 return {feature,owner};
}
