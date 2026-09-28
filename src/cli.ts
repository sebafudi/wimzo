#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { App, defaultState, type Actor } from './app.ts';
import { externalRecommendationConfiguration } from './recommendations.ts';
import { serveMcp } from './mcp.ts';
import { serveHttp } from './server.ts';

const args=process.argv.slice(2);
const flag=(key:string,fallback?:string)=>{const n=args.indexOf(key);if(n<0)return fallback;const value=args[n+1];args.splice(n,2);return value;};
const state=flag('--state',defaultState());
const role=flag('--role','owner') as Actor['role'];
const actor:Actor={role,id:flag('--actor',`local-${role}`)!,taskId:flag('--task')};
const port=Number(flag('--port','4317'));
const dashboard=args.includes('--dashboard');if(dashboard)args.splice(args.indexOf('--dashboard'),1);
const json=(value:any)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
let app:App|undefined;
try {
  if(!['owner','guide','worker','system'].includes(role))throw new Error('Invalid role');
  const command=args.shift()??'help';
  if(command==='help') {
    json({name:'Wimzo',commands:['setup (node scripts/setup.ts)','serve [--port 4317]','mcp [--role owner|guide|worker] [--task ID]','tools','call ACTION JSON_OR_@FILE','status','doctor','stop','backup/restore (node scripts/recover.mjs)'],options:['--state PATH','--actor ID'],approval:'Only record real user decisions. Fixture approvals belong in separate state directories.'});
  } else {
    app=new App(state);
    if(command==='tools') json(app.actions(actor));
    else if(command==='call') {const name=args.shift();if(!name)throw new Error('Action is required');const raw=args.shift()??'{}';const input=JSON.parse(raw.startsWith('@')?readFileSync(raw.slice(1),'utf8'):raw);json(await app.call(name,input,actor));}
    else if(command==='status') json({projects:app.store.list('project'),tasks:app.store.list('task'),pending:app.store.list('inbox'),watches:app.store.list('watch'),watermark:app.store.watermark()});
    else if(command==='doctor') {
      let service:any={running:false};
      const file=join(app.stateDir,'service.json');
      if(existsSync(file)) {
        try {const saved=JSON.parse(readFileSync(file,'utf8'));const response=await fetch(`http://127.0.0.1:${saved.port}/health`,{signal:AbortSignal.timeout(2000)});const health=await response.json() as any;service={...health,running:response.ok&&health.instanceId===saved.instanceId};}
        catch(error){service={running:false,error:(error as Error).message};}
      }
      json({node:process.version,sqlite:app.store.db.prepare('PRAGMA integrity_check').get(),state:app.stateDir,loopbackOnly:true,externalRecommendations:externalRecommendationConfiguration(),actions:app.actions(actor).length,runtime:await app.execution.call('runtime.capabilities',{},actor).catch((e:Error)=>({error:e.message})),service,notifications:'Persisted inbox, retrieved on next interaction; no guaranteed unsolicited delivery'});
    }
    else if(command==='mcp') await serveMcp(app,actor);
    else if(command==='serve') {
      const file=join(app.stateDir,'service.json');
      if(existsSync(file)){const previous=JSON.parse(readFileSync(file,'utf8'));try{process.kill(previous.pid,0);throw new Error('Service already running');}catch(error){if((error as any).code!=='ESRCH')throw error;}}
      const server=serveHttp(app,port,dashboard);
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any;
      writeFileSync(file,JSON.stringify({pid:process.pid,port,instanceId:health.instanceId,state:app.stateDir,startedAt:new Date().toISOString()}),{mode:0o600});
      json({running:true,pid:process.pid,url:`http://127.0.0.1:${port}`,dashboard});
      await new Promise<void>(resolve=>{const stop=()=>server.close();server.once('close',resolve);process.once('SIGTERM',stop);process.once('SIGINT',stop);});
      unlinkSync(file);
    } else if(command==='stop') {
      const file=join(app.stateDir,'service.json'); if(!existsSync(file))json({running:false});
      else { const service=JSON.parse(readFileSync(file,'utf8'));const token=Object.entries(app.tokens()).find(([,a])=>a.role==='owner')![0];const response=await fetch(`http://127.0.0.1:${service.port}/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({instanceId:service.instanceId})});if(!response.ok)throw new Error('Service refused stop request');json(await response.json()); }
    } else if(command==='dashboard') {
      const service=JSON.parse(readFileSync(join(app.stateDir,'service.json'),'utf8'));const token=Object.entries(app.tokens()).find(([,a])=>a.role==='owner')![0];json({url:`http://127.0.0.1:${service.port}/#key=${token}`,note:'Private local link. Keep it on this Mac.'});
    } else throw new Error(`Unknown command: ${command}`);
  }
} catch(error) {process.stderr.write(JSON.stringify({error:(error as Error).message})+'\n');process.exitCode=1;}
finally {if(app)await app.close();}
