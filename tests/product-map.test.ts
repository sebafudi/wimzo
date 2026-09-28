import test from 'node:test';import assert from 'node:assert/strict';import {Store,hash} from '../src/store.ts';import {productMap,documentProvenance} from '../src/product-map.ts';
function fixture(){const store=new Store(':memory:');store.put('project',{id:'p',name:'Product'});return store;}
test('map delivery counts exact current requirement coverage without inheriting stale or preparation results',()=>{
 const store=fixture();try {
  store.put('spec',{id:'s',projectId:'p',path:'spec/PRD.md',hash:'current',status:'Accepted',acceptedRequirementIds:['one','two'],content:'# Product'});
  for(const task of [{id:'current',specHash:'current',requirements:['one'],dimensions:{implemented:true,verified:true}},{id:'stale',specHash:'old',requirements:['two'],dimensions:{implemented:true,verified:true,released:true}},{id:'planner',specHash:'current',requirements:['two'],workflow:{purpose:'planning'},dimensions:{implemented:true,verified:true}}])store.put('task',{projectId:'p',specId:'s',...task});
  const node=productMap(store,'p',[{path:'spec/PRD.md'}]).nodes.find(n=>n.kind==='document');
  assert.equal(node.delivery.requirementCount,2);assert.equal(node.delivery.implemented,1);assert.equal(node.delivery.verified,1);assert.equal(node.delivery.released,0);assert.equal(node.delivery.taskCount,1);
 }finally {store.close();}
});
test('feature map contains real folders and only explicit local links to known documents',()=>{
 const store=fixture();try{store.put('spec',{id:'s',projectId:'p',path:'spec/PRD.md',status:'Accepted',content:'# Product\n[Worker](workers/PRD.md) [Other](https://example.invalid) [Escape](../../../secret.md) [Same](workers/PRD.md#tools)'});
 const map=productMap(store,'p',[{path:'spec/PRD.md',title:'Product'},{path:'spec/workers/PRD.md',title:'Workers',workingChange:'M',workingDiff:{additions:3,deletions:1}}]);assert.ok(map.nodes.some(n=>n.id==='folder:spec/workers'));assert.equal(map.edges.filter(e=>e.kind==='references').length,1);assert.deepEqual(map.edges.find(e=>e.kind==='references'),{from:'spec/PRD.md',to:'spec/workers/PRD.md',kind:'references'});assert.equal(map.nodes.find(n=>n.title==='Workers').workingDiff.additions,3);
 }finally{store.close();}
});
test('provenance preserves unchanged lines and links changed lines to the saved change request',()=>{
 const store=fixture();try{const first='# Worker\n\nKeep this rule.\nOld behavior.\n',second='# Worker\n\nKeep this rule.\nNew behavior.\n';store.put('spec',{id:'first',projectId:'p',path:'spec/PRD.md',content:first,hash:hash(first),status:'Superseded',capturedAt:'2026-09-21'});store.put('spec',{id:'second',projectId:'p',path:'spec/PRD.md',content:second,hash:hash(second),status:'Accepted',previousId:'first',capturedAt:'2026-09-22'});store.put('workflow_feature',{id:'feature',projectId:'p',title:'Improve worker behavior',ideaId:'idea'});store.put('workflow_document',{id:'draft',projectId:'p',featureId:'feature',path:'spec/PRD.md',proposedHash:hash(second),revisionNote:'Make the worker resumable'});store.put('idea',{id:'idea',projectId:'p',title:'Improve worker behavior'});store.put('approval',{id:'approval',kind:'specification',subjectId:'second',projectId:'p'});
 const result=documentProvenance(store,'p','spec/PRD.md');assert.equal(result.lines[2].versionId,'spec:first');assert.equal(result.lines[3].versionId,'spec:second');assert.equal(result.origins[0].originKnown,false);assert.equal(result.origins[1].featureId,'feature');assert.equal(result.origins[1].reviewed,true);assert.equal(result.origins[1].revisionNote,'Make the worker resumable');assert.throws(()=>documentProvenance(store,'p','spec/PRD.md','spec:other'),/No matching/);
 store.put('spec',{id:'foreign',projectId:'other',path:'spec/PRD.md',content:'secret',hash:hash('secret')});const current=store.require('spec','second');store.put('spec',{...current,previousId:'foreign'},current.rev);assert.equal(documentProvenance(store,'p','spec/PRD.md').complete,false);assert.equal(documentProvenance(store,'p','spec/PRD.md').origins.length,1);
 }finally{store.close();}
});

test('document moves retain exact prior passage origins across paths and flag cyclic history',()=>{
 const store=fixture();try{
  const content='# Workers\n\nKeep this rule.\n';
  store.put('spec',{id:'before-move',projectId:'p',path:'spec/workers.md',content,hash:hash(content),status:'Superseded'});
  store.put('spec',{id:'after-move',projectId:'p',path:'spec/workers/PRD.md',content,hash:hash(content),status:'Accepted',previousId:'before-move'});
  store.put('workflow_feature',{id:'original-request',projectId:'p',title:'Define the worker rule'});
  store.put('workflow_document',{id:'original-draft',projectId:'p',featureId:'original-request',path:'spec/workers.md',proposedHash:hash(content),acceptedSpec:{id:'before-move'},revisionNote:'Require the saved rule'});
  const result=documentProvenance(store,'p','spec/workers/PRD.md');
  assert.equal(result.complete,true);assert.equal(result.lines[2].versionId,'spec:before-move');
  assert.equal(result.origins.find(origin=>origin.versionId===result.lines[2].versionId).featureId,'original-request');
  assert.equal(result.origins.find(origin=>origin.versionId==='spec:before-move').path,'spec/workers.md');
  const earlier=store.require('spec','before-move');store.put('spec',{...earlier,previousId:'after-move'},earlier.rev);
  assert.equal(documentProvenance(store,'p','spec/workers/PRD.md').complete,false);
 }finally{store.close();}
});
