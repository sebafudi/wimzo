import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/app.ts';
import {startReviewDashboard} from '../scripts/review-dashboard.ts';

test('review-only HTTP dashboard saves to shared state and refuses execution actions',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wimzo-live-review-')),root=join(temp,'project'),state=join(temp,'state');
  mkdirSync(join(root,'spec'),{recursive:true});writeFileSync(join(root,'spec/PRD.md'),'# Review fixture\n\n**H-001 Review.** Keep user feedback.\n');
  const owner={role:'owner' as const,id:'fixture-owner'},admin=new App(state);
  await admin.call('project.register',{id:'fixture',name:'Review fixture',purpose:'Test',root,canonicalPaths:['spec/PRD.md']},owner);
  const spec=await admin.call('spec.capture',{projectId:'fixture',path:'spec/PRD.md'},owner);
  const dashboard=await startReviewDashboard({stateDir:state,port:0});
  const token=Object.entries(dashboard.app.tokens()).find(([,actor])=>actor.role==='owner')![0];
  const call=async(action:string,input:any)=>{const response=await fetch(`http://127.0.0.1:${dashboard.port}/call`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,input})});return{status:response.status,value:await response.json() as any};};
  try {
    const target={kind:'document',projectId:'fixture',path:'spec/PRD.md',beforeVersion:null,afterVersion:'spec:'+spec.id};
    const prepared=await call('review.prepare',{target});assert.equal(prepared.status,200);
    const input={target,fingerprint:prepared.value.result.fingerprint,decision:'request_changes',note:'Persist this exact note for the next agent.',submissionId:'http-fixture-request'};
    const saved=await call('review.submit',input);assert.equal(saved.status,200,JSON.stringify(saved.value));
    const repeated=await call('review.submit',input);assert.equal(repeated.status,200);
    const inbox=await admin.call('inbox.list',{projectId:'fixture',status:'pending'},owner);
    assert.equal(inbox.filter((item:any)=>item.kind==='review change request').length,1);
    assert.equal(inbox.find((item:any)=>item.kind==='review change request').data.note,input.note);
    assert.equal((await call('task.approve',{taskId:'unrelated',expectedRev:1,decision:'bad',source:'fixture'})).status,400);
    const watermark=admin.store.watermark();await dashboard.app.execution.tick();assert.equal(admin.store.watermark(),watermark);
  } finally {
    await new Promise<void>((resolve,reject)=>dashboard.server.close(error=>error?reject(error):resolve()));
    await admin.close();rmSync(temp,{recursive:true,force:true});
  }
});
