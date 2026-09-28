import { existsSync, readdirSync, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// Read only the current SDK session, never another conversation or auth file.
export function codexContext(sessionId:string|undefined,codexHome=join(homedir(),'.codex'),at=new Date()):{used:number;capacity:number|null;estimated:false;source:string}|null {
 if(!sessionId||!/^[-a-zA-Z0-9]{8,100}$/.test(sessionId))return null;
 const root=join(codexHome,'sessions');if(!existsSync(root))return null;
 try{for(const offset of [-1,0,1]){
  const date=new Date(at.getTime()+offset*86400000).toISOString().slice(0,10).split('-');const folder=join(root,...date);if(!existsSync(folder))continue;
  const name=readdirSync(folder).find(name=>name.endsWith(`-${sessionId}.jsonl`));if(!name)continue;
  const file=realpathSync(join(folder,name)),rel=relative(realpathSync(root),file);if(isAbsolute(rel)||rel.startsWith('..'))return null;
  const fd=openSync(file,'r');let text='';try{const size=fstatSync(fd).size,length=Math.min(size,256*1024),buffer=Buffer.alloc(length);readSync(fd,buffer,0,length,size-length);text=buffer.toString('utf8');}finally{closeSync(fd);}
  for(const line of text.split('\n').reverse()){try{const event=JSON.parse(line),info=event.type==='event_msg'&&event.payload?.type==='token_count'?event.payload.info:null;const usage=info?.last_token_usage;if(usage&&Number.isFinite(usage.input_tokens)){return {used:usage.input_tokens+(Number.isFinite(usage.output_tokens)?usage.output_tokens:0),capacity:Number.isFinite(info.model_context_window)?info.model_context_window:null,estimated:false,source:'Codex current session latest model request'};}}catch{}}
 }}catch{}
 return null;
}
