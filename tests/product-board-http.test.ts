import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/app.ts';
import {startReviewDashboard} from '../scripts/review-dashboard.ts';

test('board HTTP ideas are durable, idempotent and available through the shared chat actions',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wimzo-board-http-')),root=join(temp,'project'),state=join(temp,'state');
  mkdirSync(join(root,'spec'),{recursive:true});
  writeFileSync(join(root,'spec/PRD.md'),'# Board fixture\n\n**H-001 Board.** Show actual project progress.\n');
  const owner={role:'owner' as const,id:'fixture-owner'},admin=new App(state);
  await admin.call('project.register',{id:'fixture',name:'Board fixture',purpose:'Test',root,canonicalPaths:['spec/PRD.md']},owner);
  await admin.call('spec.capture',{projectId:'fixture',path:'spec/PRD.md'},owner);
  const dashboard=await startReviewDashboard({stateDir:state,port:0});
  const token=Object.entries(dashboard.app.tokens()).find(([,actor])=>actor.role==='owner')![0];
  const call=async(action:string,input:any)=>{
    const response=await fetch(`http://127.0.0.1:${dashboard.port}/call`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,input})});
    return {status:response.status,value:await response.json() as any};
  };
  try {
    const input={projectId:'fixture',title:'Save a preferred document',description:'Keep the last opened requirement for this project.',submissionId:'fixture-idea'};
    const first=await call('board.idea',input);
    assert.equal(first.status,200,JSON.stringify(first.value));
    const again=await call('board.idea',input);
    assert.equal(again.status,200,JSON.stringify(again.value));
    assert.deepEqual(again.value.result,first.value.result);
    const board=await admin.call('board.list',{projectId:'fixture'},{role:'guide',id:'later-chat'});
    assert.equal(board.columns.find((column:any)=>column.id==='ideas').cards.filter((card:any)=>card.title===input.title).length,1);
    assert.equal(board.columns.find((column:any)=>column.id==='prd_review').cards.length,1);
    assert.equal((await call('board.idea',{...input,title:'Changed payload'})).status,400);
    assert.equal((await call('board.list',{projectId:'missing-project'})).status,400);
    assert.equal((await call('runtime.start',{taskId:'unrelated'})).status,400);
    assert.equal((await call('task.approve',{taskId:'unrelated',expectedRev:1,decision:'test',source:'fixture'})).status,400);
    const before=admin.store.list('task').length;
    await dashboard.app.execution.tick();
    assert.equal(admin.store.list('task').length,before);
  } finally {
    await new Promise<void>((resolve,reject)=>dashboard.server.close(error=>error?reject(error):resolve()));
    await admin.close();rmSync(temp,{recursive:true,force:true});
  }
});
