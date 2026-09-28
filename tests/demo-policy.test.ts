import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/app.ts';
import {serveHttp} from '../src/server.ts';
import {restrictDemo} from '../scripts/demo-policy.ts';

test('demo rejects direct execution and inference HTTP calls before dispatch',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wimzo-demo-policy-'));
 const app=new App(state); let dispatched=0;
 app.call=async()=>{dispatched++;throw new Error('Unexpected dispatch');};
 restrictDemo(app);
 const server=serveHttp(app,0,true);
 await new Promise<void>((yes,no)=>{server.once('listening',yes);server.once('error',no);});
 try{
  const address=server.address();assert(address&&typeof address==='object');
  const token=Object.entries(app.tokens()).find(([,a])=>a.role==='owner')![0];
  for(const action of ['worker.recommend','capability.run','runtime.start','task.approve','workflow.approve','project.register']){
   const response: Response=await fetch(`http://127.0.0.1:${address.port}/call`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action,input:{}})});
   assert.equal(response.status,400);assert.match(await response.text(),/Demo mode/);
  }
  assert.equal(dispatched,0);
  assert(!app.actions({role:'owner',id:'test'}).some(a=>a.name==='worker.recommend'));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();rmSync(state,{recursive:true,force:true});}
});
