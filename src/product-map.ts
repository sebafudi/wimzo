import { posix } from 'node:path';
import { lineOperations } from './review.ts';
import { Store, assert } from './store.ts';

type File={path:string;title?:string;status?:string;workingChange?:string;workingDiff?:{additions:number;deletions:number}|null};
function deliveryState(store:Store,projectId:string,spec:any) {
 const requirements:string[]=spec?.acceptedRequirementIds??spec?.requirementIds??[];
 const tasks=spec?store.list('task').filter(t=>t.projectId===projectId&&t.specId===spec.id&&t.specHash===spec.hash&&!['requirements_preparation','planning','verification'].includes(t.workflow?.purpose)):[];
 const covered=(dimension:string)=>requirements.filter(requirement=>tasks.some(t=>t.dimensions?.[dimension]===true&&t.requirements?.includes(requirement))).length;
 return {intended:spec?.status==='Accepted',requirementCount:requirements.length,implemented:covered('implemented'),verified:covered('verified'),accepted:covered('accepted'),released:covered('released'),taskCount:tasks.length,basis:'Exact current saved specification and accepted requirement coverage'};
}
export function productMap(store:Store,projectId:string,files:File[]) {
 const nodes:any[]=[{id:'project',kind:'project',title:store.require('project',projectId).name}],edges:any[]=[];const folders=new Set<string>(),known=new Set(files.map(file=>file.path));let linkBudget=2000000;
 for(const file of files){const parts=file.path.split('/');let parent='project';for(let i=1;i<parts.length;i++){const folder=parts.slice(0,i).join('/'),id=`folder:${folder}`;if(!folders.has(folder)){folders.add(folder);nodes.push({id,kind:'folder',path:folder,title:parts[i-1]});edges.push({from:parent,to:id,kind:'contains'});}parent=id;}
  const snapshots=store.list('spec').filter(s=>s.projectId===projectId&&s.path===file.path);const spec=snapshots.filter(s=>s.status==='Accepted').at(-1)??snapshots.at(-1);
  nodes.push({id:file.path,kind:'document',...file,delivery:deliveryState(store,projectId,spec)});edges.push({from:parent,to:file.path,kind:'contains'});
  if(!spec||linkBudget<=0)continue;const content=String(spec.content).slice(0,Math.min(200000,linkBudget));linkBudget-=content.length;
  for(const match of content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)){let target=match[1].split('#')[0];if(!target||/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith('/'))continue;try{target=decodeURIComponent(target);}catch{continue;}const path=posix.normalize(posix.join(posix.dirname(file.path),target));if(known.has(path)&&path!==file.path&&!edges.some(e=>e.from===file.path&&e.to===path&&e.kind==='references'))edges.push({from:file.path,to:path,kind:'references'});}
 }
 return {projectId,nodes,edges,legend:{contains:'Folder membership',references:'Explicit link in a saved PRD'},referencesTruncated:linkBudget<=0,at:new Date().toISOString()};
}

export function documentProvenance(store:Store,projectId:string,path:string,versionId?:string) {
 const snapshots=store.list('spec').filter(s=>s.projectId===projectId&&s.path===path);const selected=versionId?snapshots.find(s=>`spec:${s.id}`===versionId):snapshots.filter(s=>s.status==='Accepted').at(-1)??snapshots.at(-1);
 assert(selected,'No matching saved specification snapshot for this document');
 const chain:any[]=[];let value:any=selected;const seen=new Set<string>();let complete=true;
 while(value){if(seen.has(value.id)||chain.length>=40){complete=false;break;}seen.add(value.id);chain.unshift(value);const previousId=value.previousId;value=previousId?store.get('spec',previousId):null;if(previousId&&!value)complete=false;if(value&&value.projectId!==projectId){complete=false;break;}}
 const approvalFor=(spec:any)=>store.list('approval').filter(a=>a.projectId===projectId&&a.subjectId===spec.id&&a.kind==='specification').at(-1);
 const wasAccepted=(spec:any)=>['Accepted','Superseded'].includes(spec.status)||Boolean(spec.acceptedAt)||Boolean(approvalFor(spec));
 const credited=chain.filter(spec=>spec.id===selected.id||wasAccepted(spec));const skipped=chain.length-credited.length;
 let previous='',lines:Array<{text:string;versionId:string|null}>=[],cells=0;const origins:any[]=[];
 for(const spec of credited){const count=String(spec.content).split('\n').length;assert(count<=2000&&Buffer.byteLength(spec.content)<=200000,'Document exceeds provenance size limits');cells+=(previous.split('\n').length+1)*(count+1);if(cells>20000000){complete=false;lines=String(selected.content).replace(/\n$/,'').split('\n').map(text=>({text,versionId:null}));break;}
  const ops=lineOperations(previous,spec.content);lines=ops.filter(op=>op.type!=='delete').map(op=>op.type==='context'?lines[(op.oldLine??1)-1]:{text:op.text,versionId:`spec:${spec.id}`});previous=spec.content;
  const proposal=store.list('workflow_document').find(d=>d.projectId===projectId&&d.path===spec.path&&d.proposedHash===spec.hash&&(!d.acceptedSpec||d.acceptedSpec.id===spec.id));const feature=proposal?store.get('workflow_feature',proposal.featureId):undefined;
  const approval=approvalFor(spec);const accepted=wasAccepted(spec);
  // Linking an idea to existing requirements does not establish authorship of those lines.
  const linkedIdea=feature?.ideaId?store.get('idea',feature.ideaId):undefined;
  origins.push({versionId:`spec:${spec.id}`,path:spec.path,at:spec.capturedAt,status:spec.status,label:feature?.title??linkedIdea?.title??(!accepted?'Proposed specification change':approval?'Reviewed specification change':'Saved specification change'),accepted,proposed:!accepted,acceptedAt:accepted?spec.acceptedAt??approval?.at??null:null,approvalId:approval?.id??null,movedFrom:spec.movedFrom??null,featureId:feature?.id??null,ideaId:linkedIdea?.id??null,revisionNote:proposal?.revisionNote??null,reviewed:Boolean(approval),originKnown:Boolean(proposal||linkedIdea),note:proposal||linkedIdea?null:'No originating change request is recorded for this snapshot.'});
 }
 return {projectId,path,versionId:`spec:${selected.id}`,lines:lines.map((line,index)=>({line:index+1,...line})),origins,complete,warnings:[complete?'Attribution follows accepted specification snapshots. A first snapshot does not prove the original author or request.':'Earlier attribution is incomplete or exceeds the bounded history limit. Unknown lines are marked explicitly.',...(skipped?[`${skipped} never-accepted draft snapshot${skipped===1?' was':'s were'} skipped; lines appear under the next accepted revision.`]:[]),...(wasAccepted(selected)?[]:['The selected snapshot is not accepted. Lines it introduced are marked as proposed.'])]};
}
