#!/usr/bin/env node
// Stable launcher survives a broken candidate and never imports its modules.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const base=resolve(import.meta.dirname,'..');
const state=resolve(process.env.WIMZO_STATE_DIR??join(base,'.wimzo'));
const pointer=join(state,'active.json');
let active={current:base};
if(existsSync(pointer)) {
  try {
    const parsed=JSON.parse(readFileSync(pointer,'utf8'));
    if(!parsed||typeof parsed.current!=='string'||(parsed.previous!==undefined&&typeof parsed.previous!=='string'))throw new Error('invalid activation fields');
    active=parsed;
  } catch {
    console.error('Activation pointer is invalid. The candidate was not started.');
    console.error(`Recover with: node ${join(base,'scripts/recover.mjs')} inspect ${state}`);
    process.exit(1);
  }
}
const child=spawn(process.execPath,[join(active.current,'src','cli.ts'),'--state',state,...process.argv.slice(2)],{stdio:'inherit',env:process.env});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
let settled=false;
child.on('error',(error)=>{
  if(settled)return;settled=true;
  console.error(`Candidate could not start: ${error.message}`);
  if(active.previous)console.error(`Recover with: node ${join(base,'scripts/recover.mjs')} rollback ${state}`);
  process.exitCode=1;
});
child.on('exit',(code)=>{
  if(settled)return;settled=true;
  if(code!==0&&active.previous)console.error(`Candidate failed. Recover with: node ${join(base,'scripts/recover.mjs')} rollback ${state}`);
  process.exitCode=code??1;
});
