import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { lexer } from 'marked';
import { markdownRenderer } from '../src/markdown.js';

const source = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '');
const turn = () => new Promise(resolve => setImmediate(resolve));
const planner = { id: 'codex-terra-low', runtime: 'codex', model: 'gpt-5.6-terra', thinking: 'low', label: 'Terra, low', source: 'local-metadata', verified: true };
const implementer = { id: 'codex-astra-high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', label: 'Astra, high', source: 'local-metadata', verified: true };

async function setup(resultReady = false, reworkReady = false) {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const columns = ['ideas', 'prd_review', 'ready', 'running', 'review', 'done', 'blocked'].map(id => ({ id, title: id, cards: id === 'ideas' ? [{ id: 'idea:idea-one', kind: 'idea', title: 'Export summaries', column: 'ideas', status: 'new', summary: 'Duplicate source idea' }] : id === 'running' ? [{ id: 'task:child-one', kind: 'task', title: 'Prepare export', column: 'running', status: 'Running', summary: 'Duplicate child task' }] : [] }));
  let feature: any = { id: 'feature:one', projectId: 'one', ideaId: 'idea-one', title: 'Export summaries', description: 'Create a bounded export for reviewed summaries.', phase: 'prd_review', documentIds: ['workflow_document:one'], linkedSpecIds: [], taskIds: ['child-one'], revisionNote: 'Clarify export behavior', documents: [{ id: 'workflow_document:one', rev: 1, path: 'spec/export.md', status: 'Draft' }], tasks: [{ id: 'child-one', title: 'Prepare export', state: 'Running' }] };
  let review: any = { feature, documents: [{ id: 'workflow_document:one', rev: 1, path: 'spec/export.md', status: 'Draft', baseSpecId: 'base', baseHash: 'base-hash', proposedHash: 'draft-hash', revisionNote: 'Clarify export behavior', requestNote: null, acceptedSpec: null, base: { id: 'base', rev: 2, path: 'spec/export.md', hash: 'base-hash', status: 'Accepted', content: '# Export\n\nOld behavior.\n' }, proposed: { hash: 'draft-hash', content: '# Export\n\nNew reviewed behavior.\n' } }], specs: [], tasks: [{ id: 'child-one', title: 'Prepare export', state: 'Running', phase: 'requirements' }] };
  if (resultReady) {
    const children = [{ id: 'child-a', title: 'Export writer', state: 'Needs result review', rev: 7, candidate: 'candidate-a' }, { id: 'child-b', title: 'Export checks', state: 'Needs result review', rev: 9, candidate: 'candidate-b' }];
    feature = { ...feature, phase: 'result_review', approvalId: 'feature-approval', taskIds: children.map(task => task.id), implementationTaskIds: children.map(task => task.id), implementationBudget: { maxExecutionMs: 300_000 }, ...(reworkReady ? { aggregateResult: { decision: 'rework' } } : {}) };
    review = { ...review, feature, documents: [], tasks: children };
  }
  const result = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }];
    if (action === 'project.get') return { id: 'one', name: 'First project' };
    if (action === 'task.list') return resultReady ? review.tasks : [];
    if (action === 'inbox.list' || action === 'watch.list') return [];
    if (action === 'review.tree') return { files: [{ path: 'spec/export.md', title: 'Export', status: 'Accepted' }], warnings: [] };
    if (action === 'board.list') return { columns, watermark: 1 };
    if (action === 'workflow.list') return [feature];
    if (action === 'workflow.review') return review;
    if (action === 'review.diff') return { kind: 'task', title: 'Implementation child', status: 'Needs result review', files: [{ path: 'checked.txt', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }], warnings: [], identity: {} };
    if (action === 'review.prepare') return { target: input.target, fingerprint: 'child-review', canAccept: true, canRequest: true, feedback: [] };
    if (action === 'evidence.list') return [];
    if (action === 'worker.options') return { profiles: [planner, implementer], catalog: {} };
    if (action === 'worker.recommend') return input.subject.startsWith('Plan implementation') ? { profile: planner, source: 'jev', reason: 'Strong at bounded decomposition.' } : { profile: implementer, source: 'jev', reason: 'Strong at focused implementation.' };
    if (action === 'workflow.requestChanges') return { feature: { ...feature, phase: 'preparing_prd' }, document: { ...review.documents[0], status: 'Changes requested' }, task: { id: 'revision' } };
    if (action === 'workflow.acceptRequirements') {
      const spec = { id: 'accepted-export', path: 'spec/export.md', hash: 'accepted-hash', rev: 4, status: 'Accepted', requirementIds: ['H-100'], acceptedRequirementIds: ['H-100'], content: review.documents[0].proposed.content };
      feature = { ...feature, acceptedSpecs: [{ id: spec.id, path: spec.path, hash: spec.hash, rev: spec.rev }], linkedSpecIds: [spec.id] };
      review = { ...review, feature, documents: [{ ...review.documents[0], status: 'Accepted', rev: 2, acceptedSpec: { id: spec.id, hash: spec.hash, rev: spec.rev } }], specs: [spec] };
      return { feature, accepted: [{ document: review.documents[0], spec, approval: { id: 'approval' } }] };
    }
    if (action === 'workflow.approve') {
      feature = { ...feature, phase: 'ready', waitingFor: input.directImplementation ? 'implementation' : 'planner', approvalId: 'feature-approval', reviewedSpec: { id: input.specId, hash: input.specHash, rev: input.specRev } };
      review = { ...review, feature };
      return { feature, task: { id: 'plan-task', title: 'Plan implementation', state: 'Approved' }, approval: { id: 'feature-approval' } };
    }
    if (action === 'workflow.reviewResult') {
      feature = { ...feature, phase: input.decision === 'accept' ? 'done' : 'blocked', aggregateResult: { decision: input.decision } };
      review = { ...review, feature, tasks: review.tasks.map((task: any) => ({ ...task, rev: task.rev + 1, state: input.decision === 'accept' ? 'Accepted' : 'Blocked', resultReview: { decision: input.decision } })) };
      return { feature, receipt: feature.aggregateResult, children: review.tasks };
    }
    if (action === 'workflow.resumeResult') {
      feature = { ...feature, phase: 'ready', waitingFor: 'implementation', aggregateResult: { decision: 'rework' }, implementationTaskIds: ['replacement-a', 'replacement-b'] };
      review = { ...review, feature, tasks: review.tasks.concat([{ id: 'replacement-a', title: 'Export writer', state: 'Approved' }, { id: 'replacement-b', title: 'Export checks', state: 'Approved' }]) };
      return { feature, replacements: input.children.map((child: any, index: number) => ({ rejectedTaskId: child.taskId, task: review.tasks.at(index - 2) })), receipt: { id: 'rework-receipt' } };
    }
    return [];
  };
  const context: any = {
    document, crypto: { randomUUID }, lexer, markdownRenderer, URL, URLSearchParams, Intl,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '#key=fixture', pathname: '/', search: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false }), setInterval: () => 1, clearInterval() {},
    fetch: async (_: string, request: any) => { const call = JSON.parse(request.body); calls.push(call); return { ok: true, status: 200, json: async () => ({ result: result(call.action, call.input) }) }; },
    console,
  };
  vm.runInNewContext(source, context);
  for (let index = 0; index < 8; index++) await turn();
  return { document, calls };
}

function click(document: any, label: string) {
  const target = [...document.querySelectorAll('button')].find((button: any) => button.textContent === label) as any;
  assert.ok(target, `Missing button ${label}`);
  target.click();
}

function selectOnly(select: any, value: string) {
  ([...select.children].find((option: any) => option.value === value) as any).selected = true;
  select.onchange();
}

async function openFeature(ui: Awaited<ReturnType<typeof setup>>) {
  click(ui.document, 'Board'); for (let index = 0; index < 8; index++) await turn();
  const featureCard = [...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('Export summaries')) as any;
  assert.ok(featureCard); featureCard.click(); for (let index = 0; index < 8; index++) await turn();
}

test('Board projects one feature card and renders its exact draft comparison', async () => {
  const ui = await setup(); await openFeature(ui);
  assert.equal(ui.document.querySelectorAll('.board-card.workflow').length, 1);
  assert.equal([...ui.document.querySelectorAll('.board-card')].filter((card: any) => card.textContent.includes('Duplicate source idea') || card.textContent.includes('Duplicate child task')).length, 0);
  assert.deepEqual(ui.calls.find(call => call.action === 'workflow.review')!.input, { featureId: 'feature:one' });
  const drawer = ui.document.querySelector('.board-drawer')!;
  assert.match(drawer.textContent!, /Old behavior/);
  assert.match(drawer.textContent!, /New reviewed behavior/);
  assert.match(drawer.textContent!, /This does not approve implementation/);
});

test('requesting changes binds the exact draft revision and keeps the owner note', async () => {
  const ui = await setup(); await openFeature(ui);
  const note = ui.document.querySelector('[aria-label="Change request for spec/export.md"]') as any;
  note.value = 'State which formats remain local.'; note.oninput(); click(ui.document, 'Request changes');
  for (let index = 0; index < 8; index++) await turn();
  const call = ui.calls.find(item => item.action === 'workflow.requestChanges')!;
  assert.equal(call.input.featureId, 'feature:one'); assert.equal(call.input.documentId, 'workflow_document:one'); assert.equal(call.input.expectedRev, 1); assert.equal(call.input.note, 'State which formats remain local.'); assert.equal(typeof call.input.submissionId, 'string');
});

test('acceptance stays separate from work approval and planner and implementer profiles remain distinct', async () => {
  const ui = await setup(); await openFeature(ui); click(ui.document, 'Accept exact requirements');
  for (let index = 0; index < 12; index++) await turn();
  const accepted = ui.calls.find(item => item.action === 'workflow.acceptRequirements')!;
  assert.deepEqual(accepted.input.documents, [{ documentId: 'workflow_document:one', expectedRev: 1 }]);
  assert.equal(ui.calls.some(item => item.action === 'workflow.approve'), false);
  assert.ok([...ui.document.querySelectorAll('button')].some((node: any) => node.textContent === 'Review accepted specification'));
  const direct = ui.document.querySelector('[aria-label="Implement directly"]') as any;
  direct.checked = true; direct.onchange();
  assert.equal((ui.document.querySelector('[aria-label="Planner profile"]') as any).disabled, true);
  const separatePlan = ui.document.querySelector('[aria-label="Implement directly"]') as any;
  separatePlan.checked = false; separatePlan.onchange();
  const values: Record<string, string> = { 'Workflow objective': 'Deliver reviewed export', 'Workflow scope': 'Implement only the accepted export behavior.', 'Workflow acceptance criteria, one per line': 'Exports reviewed summary\nKeeps data local' };
  for (const [label, value] of Object.entries(values)) { const field = ui.document.querySelector(`[aria-label="${label}"]`) as any; field.value = value; field.oninput(); }
  selectOnly(ui.document.querySelector('[aria-label="Planner profile"]'), planner.id);
  selectOnly(ui.document.querySelector('[aria-label="Implementer profile"]'), implementer.id);
  click(ui.document, 'Approve planning'); for (let index = 0; index < 10; index++) await turn();
  const approved = ui.calls.find(item => item.action === 'workflow.approve')!;
  assert.equal(approved.input.specId, 'accepted-export'); assert.equal(approved.input.specHash, 'accepted-hash'); assert.equal(approved.input.specRev, 4);
  assert.deepEqual(approved.input.profile, implementer); assert.deepEqual(approved.input.planningProfile, planner); assert.deepEqual(approved.input.implementationProfile, implementer); assert.equal(approved.input.directImplementation, false);
  assert.deepEqual(approved.input.criteria, ['Exports reviewed summary', 'Keeps data local']); assert.deepEqual(approved.input.permissions, ['workspace-write']);
});

test('worker suggestions run only on request and stay editable for planner and implementer', async () => {
  const ui = await setup(); await openFeature(ui); click(ui.document, 'Accept exact requirements');
  for (let index = 0; index < 12; index++) await turn();
  assert.equal(ui.calls.some(item => item.action === 'worker.recommend'), false);
  click(ui.document, 'Suggest workers'); for (let index = 0; index < 10; index++) await turn();
  const recommendations = ui.calls.filter(item => item.action === 'worker.recommend');
  assert.equal(recommendations.length, 2);
  assert.match(recommendations[0].input.subject, /^Plan implementation/);
  assert.deepEqual(recommendations[0].input.permissions, []);
  assert.match(recommendations[1].input.subject, /^Implement accepted feature/);
  assert.deepEqual(recommendations[1].input.permissions, ['workspace-write']);
  assert.equal((ui.document.querySelector('[aria-label="Planner profile"]') as any).value, planner.id);
  assert.equal((ui.document.querySelector('[aria-label="Implementer profile"]') as any).value, implementer.id);
  assert.match(ui.document.querySelector('.workflow-approval')!.textContent!, /Jev suggestion/);
  assert.match(ui.document.querySelector('.workflow-approval')!.textContent!, /bounded dependent slices/);
});

test('aggregate result review binds every exact child candidate after exposing its changes', async () => {
  const ui = await setup(true); await openFeature(ui);
  assert.equal(ui.document.querySelectorAll('.workflow-task-list button').length, 2);
  assert.match(ui.document.querySelector('.workflow-review')!.textContent!, /Review each child change above/);
  click(ui.document, 'Review changes'); for (let index = 0; index < 10; index++) await turn();
  assert.match(ui.document.querySelector('.review-decision')!.textContent!, /decide the complete feature result together/);
  assert.equal([...ui.document.querySelectorAll('.review-decision button')].some((button: any) => button.textContent === 'Accept changes' || button.textContent === 'Request changes'), false);
  click(ui.document, 'Back to feature result review'); for (let index = 0; index < 12; index++) await turn();
  assert.ok(ui.document.querySelector('[aria-label="Feature result review notes"]'));
  assert.equal(ui.calls.some(item => item.action === 'review.submit'), false);
  const note = ui.document.querySelector('[aria-label="Feature result review notes"]') as any;
  note.value = 'Both slices satisfy the accepted behavior.'; note.oninput();
  click(ui.document, 'Accept feature result'); for (let index = 0; index < 10; index++) await turn();
  const call = ui.calls.find(item => item.action === 'workflow.reviewResult')!;
  assert.deepEqual(call.input.children, [
    { taskId: 'child-a', expectedRev: 7, candidate: 'candidate-a' },
    { taskId: 'child-b', expectedRev: 9, candidate: 'candidate-b' },
  ]);
  assert.equal(call.input.decision, 'accept');
  assert.equal(call.input.notes, 'Both slices satisfy the accepted behavior.');
  assert.equal(typeof call.input.submissionId, 'string');
});

test('aggregate rejection offers exact bounded rework and resumes every rejected child together', async () => {
  const ui = await setup(true); await openFeature(ui);
  click(ui.document, 'Reject feature result'); for (let index = 0; index < 12; index++) await turn();
  const rejected = ui.calls.find(item => item.action === 'workflow.reviewResult')!;
  assert.equal(rejected.input.decision, 'reject');
  const decision = ui.document.querySelector('[aria-label="Feature rework decision"]') as any;
  assert.ok(decision);
  assert.match(ui.document.querySelector('.workflow-review')!.textContent!, /fresh replacement work from each exact rejected candidate/);
  assert.match(ui.document.querySelector('.workflow-review')!.textContent!, /same total implementation budget of 5 minutes/);
  assert.match(ui.document.querySelector('.workflow-review')!.textContent!, /fresh deadline starts when you approve/);
  decision.value = 'Correct the export filename while retaining the reviewed scope.'; decision.oninput();
  click(ui.document, 'Approve correction and resume'); for (let index = 0; index < 14; index++) await turn();
  const resumed = ui.calls.find(item => item.action === 'workflow.resumeResult')!;
  assert.deepEqual(resumed.input.children, [
    { taskId: 'child-a', expectedRev: 8, candidate: 'candidate-a' },
    { taskId: 'child-b', expectedRev: 10, candidate: 'candidate-b' },
  ]);
  assert.equal(resumed.input.decision, 'Correct the export filename while retaining the reviewed scope.');
  assert.equal(resumed.input.source, 'dashboard workflow result rework');
  assert.equal(typeof resumed.input.submissionId, 'string');
});

test('completed replacement work enters a fresh exact aggregate result review', async () => {
  const ui = await setup(true, true); await openFeature(ui);
  assert.ok(ui.document.querySelector('[aria-label="Feature result review notes"]'));
  assert.ok([...ui.document.querySelectorAll('button')].some((button: any) => button.textContent === 'Accept feature result'));
  assert.ok([...ui.document.querySelectorAll('button')].some((button: any) => button.textContent === 'Reject feature result'));
});
