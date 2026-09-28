import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {approvedWorkflowFeature} from '../src/workflow-authority.ts';

function fixture(){
 const store=new Store(':memory:');
 store.put('workflow_owner_approval',{id:'original',projectId:'project',kind:'feature',actor:{role:'owner'}});
 store.put('workflow_owner_approval',{id:'rework',projectId:'project',featureId:'feature',kind:'result_rework',actor:{role:'owner'},sourceOwnerApprovalId:'original',children:[{taskId:'rejected',taskRev:7,candidate:{materializedCommit:'reviewed-commit'},reworkSource:{commit:'reviewed-commit'}}]});
 store.put('workflow_result_rework',{id:'receipt',projectId:'project',featureId:'feature',sourceOwnerApprovalId:'original',reworkApprovalId:'rework',replacements:[{taskId:'replacement',rejectedTaskId:'rejected',rejectedTaskRev:7}]});
 store.put('workflow_feature',{id:'feature',projectId:'project',approvalId:'original',rework:{receiptId:'receipt'}});
 const task=store.put('task',{id:'replacement',projectId:'project',workflow:{featureId:'feature',purpose:'implementation',reworkOf:'rejected',reworkApprovalId:'rework'},inheritedAuthorization:{ownerApprovalId:'rework'},sourceCandidate:{commit:'reviewed-commit'}});
 return {store,task};
}
test('exact rework and its independent verifier retain original feature specification authority',()=>{
 const {store,task}=fixture();try{
  assert.equal(approvedWorkflowFeature(store,task).owner.id,'original');
  assert.equal(approvedWorkflowFeature(store,{id:'verifier',projectId:'project',workflow:{featureId:'feature',purpose:'verification',targetTaskId:task.id},inheritedAuthorization:{ownerApprovalId:'rework'}}).owner.id,'original');
 }finally{store.close();}
});
test('rework cannot substitute another task or source under an existing owner receipt',()=>{
 const {store,task}=fixture();try{
  assert.throws(()=>approvedWorkflowFeature(store,{...task,id:'forged'}),/approved rework replacement/);
  assert.throws(()=>approvedWorkflowFeature(store,{...task,sourceCandidate:{commit:'unreviewed'}}),/reviewed candidate/);
  const approval=store.require('workflow_owner_approval','rework');store.put('workflow_owner_approval',{...approval,sourceOwnerApprovalId:'different'},approval.rev);
  assert.throws(()=>approvedWorkflowFeature(store,task),/approval is stale/);
 }finally{store.close();}
});
