#!/usr/bin/env node
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]!=='exec')throw new Error('Only Codex SDK exec is supported');
args.splice(1,0,'--ignore-user-config');
const overrides=JSON.parse(process.env.WIMZO_CODEX_PERMISSION_OVERRIDES??'[]');
if(!Array.isArray(overrides)||overrides.length!==1||typeof overrides[0]!=='string'||!overrides[0].startsWith('permissions.wimzo-workspace-v1='))throw new Error('Exact worker permission profile is required');
if(args.includes('--sandbox')||args.some(value=>value.startsWith('sandbox_mode=')||value.startsWith('sandbox_workspace_write.')))throw new Error('Legacy sandbox settings would bypass the worker permission profile');
args.splice(2,0,...overrides.flatMap(value=>['-c',value]));
const env={...process.env};delete env.WIMZO_CODEX_PERMISSION_OVERRIDES;
const child=spawn(process.env.WIMZO_CODEX_BINARY||'codex',args,{stdio:'inherit',env});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.once('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
child.once('exit',(code)=>{process.exitCode=code??1;});
