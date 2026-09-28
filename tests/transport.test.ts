import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { App, root } from '../src/app.ts';
import { serveHttp } from '../src/server.ts';

function client(state:string,role='owner',task?:string){
  const args=[join(root,'src/cli.ts'),'--state',state,'--role',role,'--actor',role==='worker'?'fixture-worker':'fixture-owner',...(task?['--task',task]:[]),'mcp'];
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe']});
  let sequence=0;const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>();let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line);const wait=pending.get(response.id);if(!wait)return;pending.delete(response.id);if(response.error)wait.reject(new Error(response.error.message));else wait.resolve(response.result);});
  child.once('exit',()=>{for(const waiter of pending.values())waiter.reject(new Error(stderr||'MCP exited'));pending.clear();});
  const rpc=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {rpc,async call(name:string,input:any={}){const response=await rpc('tools/call',{name:name.replaceAll('.','_'),arguments:input});if(response.isError)throw new Error(response.content[0].text);return JSON.parse(response.content[0].text);},async close(){child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));}};
}

test('complete fixture chat workflow over real MCP stdio, reconnect, role isolation and result review',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wimzo-chat-')),state=join(temp,'state'),project=join(temp,'project');mkdirSync(join(project,'spec'),{recursive:true});
  writeFileSync(join(project,'spec/PRD.md'),'**H-001 Fictional behavior.**\nThe fixture retains a result.\n');
  const owner=client(state);let worker:ReturnType<typeof client>|undefined;
  try {
    const hello=await owner.rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'fixture-chat',version:'1'},capabilities:{}});assert.equal(hello.serverInfo.name,'wimzo');
    const tools=await owner.rpc('tools/list');assert.ok(tools.tools.length>20);assert.ok(tools.tools.every((t:any)=>t.inputSchema.type==='object'));
    await owner.call('project.register',{id:'fixture',name:'Fixture',root:project,purpose:'Isolated chat acceptance test'});
    const spec=await owner.call('spec.capture',{projectId:'fixture',path:'spec/PRD.md'});
    assert.equal(spec.status,'Draft');
    await owner.call('spec.accept',{specId:spec.id,hash:spec.hash,expectedRev:spec.rev,decision:'Accept fixture PRD',source:'automated fixture only'});
    let task=await owner.call('task.create',{projectId:'fixture',specId:spec.id,specHash:spec.hash,requirements:['H-001'],objective:'Fixture result',criteria:['fixture check'],scope:'One fictional check',permissions:['read'],budget:{maxExecutionMs:60_000},runtime:'manual'});
    task=(await owner.call('task.approve',{taskId:task.id,expectedRev:task.rev,decision:'Approve fixture task',source:'automated fixture only'})).task;
    assert.equal(task.state,'Approved');
    worker=client(state,'worker',task.id);
    const workerTools=await worker.rpc('tools/list');assert.ok(!workerTools.tools.some((t:any)=>t.name==='task_review'));
    const claim=await worker.call('task.claim',{taskId:task.id,expectedRev:task.rev,runtime:'manual'});
    const candidate={id:'fixture-candidate',sha256:'test-only',specHash:spec.hash};
    task=(await worker.call('task.workerResult',{taskId:task.id,runId:claim.run.id,expectedTaskRev:claim.task.rev,candidate,summary:'Fictional result'})).task;
    assert.equal(task.state,'Verifying');
    await worker.call('evidence.record',{taskId:task.id,candidate,specHash:spec.hash,check:'fixture check',environment:'isolated transport fixture',result:'pass'});
    task=await worker.call('task.verify',{taskId:task.id,expectedRev:task.rev,candidate,specHash:spec.hash});
    assert.equal(task.state,'Needs result review');
    await assert.rejects(worker.call('task.review',{taskId:task.id,expectedRev:task.rev,candidate,decision:'accept',source:'fixture'}),/unavailable/);
    const reconnect=client(state);
    try {assert.ok((await reconnect.call('inbox.list',{projectId:'fixture'})).some((item:any)=>item.kind==='result review'));}finally{await reconnect.close();}
    task=(await owner.call('task.review',{taskId:task.id,expectedRev:task.rev,candidate,decision:'accept',source:'automated fixture only'})).task;
    assert.equal(task.state,'Accepted');assert.equal(task.dimensions.released,false);
    await owner.call('release.decide',{taskId:task.id,candidate,decision:'defer',source:'automated fixture only'});
    const triage=await owner.call('triage.classify',{projectId:'fixture',classification:'unreproduced report',summary:'Fixture report',evidence:[]});assert.equal(triage.classification,'unreproduced report');
  }finally{if(worker)await worker.close();await owner.close();rmSync(temp,{recursive:true,force:true});}
});

test('loopback HTTP rejects unauthenticated, foreign-origin and actor spoofing requests',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wimzo-http-'));const app=new App(temp);const server=serveHttp(app,0);await new Promise<void>(resolve=>server.once('listening',resolve));
  const port=(server.address() as any).port,url=`http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(url+'/health')).status,200);
    assert.equal((await fetch(url+'/tools')).status,401);
    const token=Object.entries(app.tokens()).find(([,actor])=>actor.role==='guide')![0];
    assert.equal((await fetch(url+'/tools',{headers:{Authorization:`Bearer ${token}`,Origin:'https://example.com'}})).status,403);
    const response=await fetch(url+'/call',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'project.register',actor:{role:'owner'},input:{name:'spoof',root:temp,purpose:'spoof'}})});
    assert.equal(response.status,400);assert.match(await response.text(),/unavailable/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();rmSync(temp,{recursive:true,force:true});}
});

test('HTTP shutdown waits for an in-flight scheduler tick before closing',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wimzo-http-close-'));const app=new App(temp);
  let releaseTick!:()=>void;let markStarted!:()=>void;
  const started=new Promise<void>(resolve=>{markStarted=resolve;});
  const blocked=new Promise<void>(resolve=>{releaseTick=resolve;});
  app.execution.tick=async()=>{markStarted();await blocked;return {fixture:true};};
  const server=serveHttp(app,0);await new Promise<void>(resolve=>server.once('listening',resolve));
  try {
    await started;
    let closed=false;
    const closing=new Promise<void>((resolve,reject)=>server.close(error=>{if(error)reject(error);else{closed=true;resolve();}}));
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(closed,false);
    releaseTick();await closing;assert.equal(closed,true);
  }finally{
    releaseTick();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await app.close();rmSync(temp,{recursive:true,force:true});
  }
});

test('fresh MCP clients discover focused schemas and read live queue and reconciled inbox without a dashboard', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-m2-mcp-'));
  const state = join(temp, 'state'), project = join(temp, 'project');
  mkdirSync(join(project, 'spec'), { recursive: true });
  writeFileSync(join(project, 'spec/PRD.md'), '**H-024 Queue.** Approved tasks wait for available capacity.\n');
  const owner = client(state);
  try {
    await owner.rpc('initialize', { protocolVersion: '2025-06-18' });
    const catalog = await owner.rpc('tools/list');
    assert.ok(JSON.stringify(catalog).length < 48500);
    assert.ok(catalog.tools.find((tool: any) => tool.name === 'context_build').inputSchema.properties.requirementIds);
    await assert.rejects(owner.call('project.list', { candidate: {} }), /Unknown input.candidate/);
    await owner.call('project.register', { id: 'm2', name: 'M2', root: project, purpose: 'MCP fixture' });
    const spec = await owner.call('spec.capture', { projectId: 'm2', path: 'spec/PRD.md' });
    const inbox = await owner.call('inbox.create', { projectId: 'm2', kind: 'PRD review', summary: 'Review fixture', data: { specId: spec.id, hash: spec.hash } });
    await owner.call('spec.accept', { specId: spec.id, hash: spec.hash, expectedRev: spec.rev, decision: 'Accept fixture', source: 'isolated MCP fixture' });
    assert.equal((await owner.call('inbox.list', { projectId: 'm2', status: 'pending' })).some((item: any) => item.id === inbox.id), false);
    const context = await owner.call('context.build', { projectId: 'm2', requirementIds: ['H-024'], omittedCategories: ['unrelated fixture content'] });
    assert.equal(context.rules[0].requirementId, 'H-024');
    let task = await owner.call('task.create', { projectId: 'm2', specId: spec.id, specHash: spec.hash, requirements: ['H-024'], objective: 'MCP queue fixture', criteria: ['fixture'], scope: 'No execution', permissions: [], budget: {}, runtime: 'script', capability: 'node.test' });
    task = (await owner.call('task.approve', { taskId: task.id, expectedRev: task.rev, decision: 'Fixture approval', source: 'isolated MCP fixture' })).task;
    await owner.call('dispatch.pause', { projectId: 'm2', decision: 'Fixture pause' });
    task = await owner.call('task.control', { taskId: task.id, expectedRev: task.rev, command: 'cancel' });
    await owner.call('conversation.focus', { conversationId: 'm2-conversation', projectId: 'm2', focus: { taskId: task.id }, handoff: 'Resume review of the paused queue.' });
    const reconnect = client(state);
    try {
      const queue = await reconnect.call('execution.queue', { projectId: 'm2' });
      assert.equal(queue[0].taskId, task.id);
      assert.match(queue[0].reason, /dispatch_paused:m2/);
      assert.equal((await reconnect.call('conversation.get', { conversationId: 'm2-conversation' })).handoff, 'Resume review of the paused queue.');
      const pending = await reconnect.call('task.get', { taskId: task.id });
      assert.equal(pending.state, 'Approved');
      assert.equal(pending.requested.command, 'cancel');
      const system = client(state, 'system');
      try {
        await system.call('task.ack', { taskId: task.id, expectedRev: pending.rev, command: 'cancel', checkpoint: { summary: 'No process launched; fixture cancellation acknowledged.' } });
      } finally { await system.close(); }
      assert.equal((await reconnect.call('task.get', { taskId: task.id })).state, 'Canceled');
      assert.deepEqual(await reconnect.call('execution.queue', { projectId: 'm2' }), []);
    } finally { await reconnect.close(); }
  } finally { await owner.close(); rmSync(temp, { recursive: true, force: true }); }
});
