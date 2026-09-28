import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {codexContext} from '../src/codex-telemetry.ts';
test('context telemetry uses the current session last request, never cumulative usage or another session',()=>{
 const root=mkdtempSync(join(tmpdir(),'wimzo-telemetry-')),at=new Date('2026-09-22T01:00:00Z'),folder=join(root,'sessions/2026/09/22');mkdirSync(folder,{recursive:true});
 const record=(input:number)=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:999999},last_token_usage:{input_tokens:input,output_tokens:100},model_context_window:258400}}})+'\n';
 writeFileSync(join(folder,'rollout-other-session.jsonl'),record(98765));writeFileSync(join(folder,'rollout-test-session.jsonl'),'partial-json\n'+record(12000)+record(13200)+'{"incomplete"');
 assert.deepEqual(codexContext('test-session',root,at),{used:13300,capacity:258400,estimated:false,source:'Codex current session latest model request'});
 assert.equal(codexContext('missing-session',root,at),null);assert.equal(codexContext('../../auth',root,at),null);
 const outside=join(root,'outside.jsonl');writeFileSync(outside,record(111));symlinkSync(outside,join(folder,'rollout-link-session.jsonl'));assert.equal(codexContext('link-session',root,at),null);
});
