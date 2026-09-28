#!/usr/bin/env node
// Reproducible source inventory. Private runtime artifacts are never included.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const destination=resolve(process.argv[2]??join(root,'.wimzo/evidence/publication/source-audit.json'));
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const findings=[];
const patterns=[/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{20,}/,/github_pat_[A-Za-z0-9_]{20,}/,new RegExp('sk'+'-[A-Za-z0-9_-]{25,}')];
const entries=files.map(path=>{
 const bytes=readFileSync(join(root,path)),content=bytes.toString('utf8');
 if(/^\.wimzo\/|^node_modules\/|\.(?:sqlite|log)$/.test(path))findings.push({path,kind:'private artifact staged'});
 if(content.includes(String.fromCodePoint(0x2014)))findings.push({path,kind:'forbidden punctuation'});
 for(const pattern of patterns)if(pattern.test(content))findings.push({path,kind:'credential pattern'});
 return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
});
let commit=null;try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
const report={format:1,createdAt:new Date().toISOString(),root,commit,files:entries,findings,note:'Pattern scan and explicit Git inventory, not a guarantee against every kind of sensitive content. Review the publication scope before pushing.'};
mkdirSync(dirname(destination),{recursive:true,mode:0o700});writeFileSync(destination,JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({report:destination,files:entries.length,bytes:entries.reduce((sum,e)=>sum+e.bytes,0),findings}));
process.exitCode=findings.length?1:0;
