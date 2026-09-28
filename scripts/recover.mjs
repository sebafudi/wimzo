#!/usr/bin/env node
// This recovery entry point deliberately imports no candidate application code.
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checksum = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const check = (condition,message) => {if(!condition)throw new Error(message);};
const canonicalJson = value => Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`:JSON.stringify(value);
const write = (path,value) => {mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});renameSync(temp,path);};
function stopped(state) {
  const file=join(state,'service.json');
  if(!existsSync(file)) return;
  const saved=JSON.parse(readFileSync(file,'utf8'));
  try { process.kill(saved.pid,0); } catch(error) {if(error.code==='ESRCH')return;throw error;}
  throw new Error('Stop the service before restore or activation. Its recorded process is still present.');
}
function activeRunProcessCount(state) {
  const path=join(state,'state.sqlite');if(!existsSync(path))return 0;
  const db=open(path);
  try {
    return db.prepare("SELECT data FROM records WHERE kind='run'").all().map(row=>JSON.parse(row.data)).filter(run=>{
      if(!(run.state==='Running'||['reserved','running','cancel_requested','canceling','pause_requested'].includes(run.status)))return false;
      const group=run.processGroupId??run.pid;if(!Number.isInteger(group)||group<2)return false;
      try{process.kill(-group,0);return true;}catch{return false;}
    }).length;
  } finally {db.close();}
}
function open(path) {const db=new DatabaseSync(path);const result=db.prepare('PRAGMA integrity_check').get();check(result.integrity_check==='ok','SQLite integrity check failed');return db;}
export async function createBackup(state, destination) {
  state=resolve(state);destination=resolve(destination??join(state,'backups',`${Date.now()}-${randomUUID().slice(0,8)}`));
  check(!existsSync(destination),'Backup destination already exists');
  mkdirSync(destination,{recursive:true,mode:0o700});
  const db=open(join(state,'state.sqlite'));
  try {await backup(db,join(destination,'state.sqlite'));} finally {db.close();}
  // Live run logs and worktrees retain their canonical paths and are never deleted by restore.
  if(existsSync(join(state,'active.json')))copyFileSync(join(state,'active.json'),join(destination,'active.json'));
  const manifest={format:1,createdAt:new Date().toISOString(),state,databaseSha256:checksum(join(destination,'state.sqlite')),preservedExternalArtifacts:['runs/','worktrees/'],excludedSecrets:['clients.json'],note:'Run logs and saved edits remain in the original state directory. Client credentials are not copied or rolled back. Copy private artifacts separately for migration.'};
  write(join(destination,'manifest.json'),manifest);
  return {backup:destination,manifest};
}
export async function restoreBackup(state, source) {
  state=resolve(state);source=resolve(source);stopped(state);
  check(activeRunProcessCount(state)===0,'Cancel or pause active run processes before restore');
  const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));
  check(manifest.format===1,'Unsupported backup format');
  check(checksum(join(source,'state.sqlite'))===manifest.databaseSha256,'Backup checksum mismatch');
  const validation=open(join(source,'state.sqlite'));validation.close();
  const previous=existsSync(join(state,'state.sqlite'))?await createBackup(state):undefined;
  mkdirSync(state,{recursive:true,mode:0o700});
  copyFileSync(join(source,'state.sqlite'),join(state,'restore.tmp.sqlite'));
  for(const suffix of ['-wal','-shm'])if(existsSync(join(state,'state.sqlite'+suffix)))rmSync(join(state,'state.sqlite'+suffix));
  renameSync(join(state,'restore.tmp.sqlite'),join(state,'state.sqlite'));
  // Never replay tasks from an older snapshot. Resume requires an explicit reconciliation.
  const db=open(join(state,'state.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  try {
    const restoredAt=new Date().toISOString();
    for(const row of db.prepare("SELECT id,data,rev FROM records WHERE kind='task'").all()) {
      const task=JSON.parse(row.data);
      if(['Running','Approved'].includes(task.state)) {
        const restoredRunId=task.runId;
        task.state='Paused';task.waitingReasons=['Restored backup: reconcile saved work and incomplete effects before resume'];task.restoredRunId=restoredRunId;delete task.runId;task.rev=row.rev+1;
        db.prepare("UPDATE records SET data=?,rev=? WHERE kind='task' AND id=?").run(JSON.stringify(task),task.rev,row.id);
        if(restoredRunId) {
          const checkpoint={id:`checkpoint_recovery_${randomUUID()}`,projectId:task.projectId,taskId:task.id,runId:restoredRunId,data:{reason:'Backup restored with an incomplete run',next:'Inspect persisted logs and saved work before explicitly resuming',outcome:'unknown'},at:restoredAt,actor:'recovery',rev:1};
          db.prepare("INSERT INTO records(kind,id,rev,data) VALUES('checkpoint',?,?,?)").run(checkpoint.id,checkpoint.rev,JSON.stringify(checkpoint));
        }
      }
    }
    for(const row of db.prepare("SELECT id,data,rev FROM records WHERE kind='run'").all()) {
      const run=JSON.parse(row.data);
      if(run.state==='Running'||['reserved','running','cancel_requested','canceling','pause_requested'].includes(run.status)) {
        const previousStatus=run.status??run.state;
        run.state='Paused';run.status='paused';run.launchState='restored-outcome-unknown';run.error='Backup restored: prior process identity is stale and the outcome requires reconciliation';run.restoredAt=restoredAt;run.restoredPreviousStatus=previousStatus;delete run.pid;delete run.childPid;delete run.processGroupId;run.rev=row.rev+1;
        db.prepare("UPDATE records SET data=?,rev=? WHERE kind='run' AND id=?").run(JSON.stringify(run),run.rev,row.id);
      }
    }
    db.prepare('INSERT INTO events(project,type,data,at) VALUES(NULL,?,?,?)').run('recovery.restored',JSON.stringify({source,previous:previous?.backup,credentials:'preserved-current',activeRuns:'paused-with-stale-process-identities-cleared'}),restoredAt);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
  return {restored:true,source,previous:previous?.backup,dispatch:'paused tasks require reconciliation',artifacts:'Existing run logs and worktrees preserved',credentials:'Current client credentials preserved; backup credentials are never restored'};
}
export function inspectRecovery(state) {
  state=resolve(state);
  const pointer=join(state,'active.json');let active=null;let activeError;
  if(existsSync(pointer)) {
    try {const parsed=JSON.parse(readFileSync(pointer,'utf8'));check(parsed&&typeof parsed.current==='string'&&(parsed.previous===undefined||typeof parsed.previous==='string'),'Invalid activation fields');active=parsed;}
    catch {activeError={error:'Activation pointer is invalid',path:pointer,repair:`Replace ${pointer} with active.json from a validated backup, or remove it to use the bundled launcher`};}
  }
  return {state,active,activeError,backups:existsSync(join(state,'backups'))?readdirSync(join(state,'backups')):[],databasePresent:existsSync(join(state,'state.sqlite'))};
}
export async function activate(state,candidate,taskId) {
  state=resolve(state);candidate=resolve(candidate);stopped(state);
  check(activeRunProcessCount(state)===0,'Cancel or pause active run processes before activation');
  const db=open(join(state,'state.sqlite'));
  try {
    const row=db.prepare("SELECT data FROM records WHERE kind='task' AND id=?").get(taskId);
    check(row,'Accepted update task not found');const task=JSON.parse(row.data);
    check(task.state==='Accepted','Update result must be owner accepted');
    const projectRow=db.prepare("SELECT data FROM records WHERE kind='project' AND id=?").get(task.projectId);
    check(projectRow,'Update project not found');const project=JSON.parse(projectRow.data);
    check(project.id==='wimzo'||project.name.toLowerCase()==='wimzo','Update must belong to Wimzo');
    const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:candidate,encoding:'utf8'}).trim();
    check(task.candidate?.id===revision||task.candidate?.commit===revision,'Candidate does not match accepted revision');
    check(!execFileSync('git',['status','--porcelain'],{cwd:candidate,encoding:'utf8'}).trim(),'Candidate must have a clean working tree');
    const releases=db.prepare("SELECT rowid,data FROM records WHERE kind='release' ORDER BY rowid DESC").all().map(r=>JSON.parse(r.data));
    const latestDecision=releases.find(r=>r.taskId===taskId&&canonicalJson(r.candidate)===canonicalJson(task.candidate));
    check(latestDecision?.decision==='approve','Latest exact local activation release decision must be approve');
    check(existsSync(join(candidate,'src','cli.ts')),'Candidate CLI is missing');
    check(task.dimensions?.verified===true,'Candidate verification required');
    const activeTasks=db.prepare("SELECT data FROM records WHERE kind='task'").all().map(r=>JSON.parse(r.data));
    check(!activeTasks.some(t=>t.state==='Running'),'Checkpoint and pause active jobs before activation');
    const snapshot=await createBackup(state);
    const prior=existsSync(join(state,'active.json'))?JSON.parse(readFileSync(join(state,'active.json'),'utf8')):null;
    const previous=prior?.current??project.root;
    const record={current:candidate,previous,revision,taskId,backup:snapshot.backup,activatedAt:new Date().toISOString()};
    write(join(state,'active.json'),record);
    return record;
  }finally{db.close();}
}
export function rollback(state) {
  state=resolve(state);stopped(state);
  const file=join(state,'active.json');const current=JSON.parse(readFileSync(file,'utf8'));
  check(current.previous&&existsSync(join(current.previous,'src','cli.ts')),'Known-good launcher path is unavailable');
  const record={...current,current:current.previous,previous:current.current,rolledBackAt:new Date().toISOString()};write(file,record);return record;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,state=resolve(import.meta.dirname,'../.wimzo'),argument,taskId]=process.argv.slice(2);
  try {
    let result;
    if(command==='backup')result=await createBackup(state,argument);
    else if(command==='restore')result=await restoreBackup(state,argument);
    else if(command==='inspect')result=inspectRecovery(state);
    else if(command==='activate')result=await activate(state,argument,taskId);
    else if(command==='rollback')result=rollback(state);
    else throw new Error('Usage: node scripts/recover.mjs backup|restore|inspect|activate|rollback STATE [PATH] [ACCEPTED_TASK_ID]');
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
}
