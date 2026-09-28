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

async function setup() {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const data = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }];
    if (action === 'project.get') return { id: 'one', name: 'First project' };
    if (action === 'task.list' || action === 'inbox.list' || action === 'watch.list' || action === 'spec.list') return [];
    if (action === 'review.tree') return { files: [{ path: 'spec/web/export.md', title: 'Export flow', status: 'Accepted' }, { path: 'spec/workers/runtime.md', title: 'Worker runtime', status: 'Draft' }], warnings: [] };
    if (action === 'review.map') return {
      nodes: [
        { id: 'project', kind: 'project', title: 'First project' },
        { id: 'web', kind: 'folder', title: 'Web app' },
        { id: 'export', kind: 'document', path: 'spec/web/export.md', title: 'Export flow', status: 'Accepted', delivery: { intended: true, requirementCount: 4, implemented: 3, verified: 2, accepted: 1, released: 1, taskCount: 3, basis: 'saved state' } },
        { id: 'workers', kind: 'folder', title: 'Workers' },
        { id: 'runtime', kind: 'document', path: 'spec/workers/runtime.md', title: 'Worker runtime', status: 'Draft', workingChange: 'M' },
      ],
      edges: [{ from: 'project', to: 'web', kind: 'contains' }, { from: 'web', to: 'export', kind: 'contains' }, { from: 'project', to: 'workers', kind: 'contains' }, { from: 'workers', to: 'runtime', kind: 'contains' }, { from: 'export', to: 'runtime', kind: 'references' }], warnings: [],
    };
    if (action === 'review.history') return { versions: [{ id: 'spec:v1', label: 'Accepted snapshot', at: '2026-09-22T10:00:00Z', source: 'snapshot', status: 'Accepted', previousVersionId: null }], nextOffset: null, warnings: [] };
    if (action === 'review.compare') return { kind: 'document', title: input.path, status: 'Accepted', baseLabel: 'Empty', afterLabel: 'Accepted snapshot', files: [{ path: input.path, status: 'added', patch: '', markdown: { before: null, after: '# Export flow\n\nReviewed behavior.\n' } }], warnings: [], identity: {} };
    if (action === 'review.prepare') return { target: { kind: 'spec', projectId: 'one', specId: 'v1', specHash: 'hash', specRev: 1 }, fingerprint: 'review', canAccept: false, canRequest: false, feedback: [] };
    if (action === 'review.provenance') return { versionId: input.versionId, lines: [{ line: 1, text: '# Export flow', versionId: 'spec:v1' }, { line: 2, text: '', versionId: null }, { line: 3, text: 'Reviewed behavior.', versionId: 'spec:v1' }], origins: [{ versionId: 'spec:v1', label: 'Export workflow revision', featureId: 'feature:export', ideaId: 'idea:export', revisionNote: 'Add local export', originKnown: true, reviewed: true, note: 'Keep exported data local.' }], complete: false, warnings: ['One blank line has no saved origin.'] };
    if (action === 'board.list') return { columns: ['ideas', 'prd_review', 'ready', 'running', 'review', 'done', 'blocked'].map(id => ({ id, title: id, cards: [] })), watermark: 1 };
    if (action === 'workflow.list') return [{ id: 'feature:export', projectId: 'one', title: 'Export workflow revision', description: 'Keep exported data local.', phase: 'prd_review' }];
    if (action === 'workflow.review') return { feature: { id: 'feature:export', projectId: 'one', title: 'Export workflow revision', description: 'Keep exported data local.', phase: 'prd_review' }, documents: [], specs: [], tasks: [] };
    if (action === 'worker.options') return { profiles: [], catalog: {} };
    return [];
  };
  const context: any = {
    document, crypto: { randomUUID }, lexer, markdownRenderer, URL, URLSearchParams, Intl,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '#key=fixture', pathname: '/', search: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false }), setInterval: () => 1, clearInterval() {},
    fetch: async (_: string, request: any) => { const call = JSON.parse(request.body); calls.push(call); return { ok: true, status: 200, json: async () => ({ result: data(call.action, call.input) }) }; },
    console,
  };
  vm.runInNewContext(source, context);
  for (let index = 0; index < 10; index++) await turn();
  return { document, calls };
}

function click(document: any, label: string) {
  const target = [...document.querySelectorAll('button')].find((button: any) => button.textContent === label) as any;
  assert.ok(target, `Missing button ${label}`);
  target.click();
}

test('the product map loads lazily, preserves nesting, and opens document nodes', async () => {
  const ui = await setup();
  assert.equal(ui.calls.some(call => call.action === 'review.map'), false);
  click(ui.document, 'Map'); for (let index = 0; index < 8; index++) await turn();
  assert.deepEqual(ui.calls.find(call => call.action === 'review.map')!.input, { projectId: 'one' });
  assert.equal(ui.document.querySelectorAll('.map-branch').length, 3);
  const web = [...ui.document.querySelectorAll('.map-card.folder')].find((node: any) => node.textContent.includes('Web app')) as any;
  assert.match(web.parentNode.textContent, /Export flow/);
  assert.match(ui.document.querySelector('.product-map')!.textContent!, /1 reference/);
  assert.match(ui.document.querySelector('.product-map')!.textContent!, /Intended · Built 3\/4 · Verified 2\/4 · Released 1\/4/);
  const runtime = [...ui.document.querySelectorAll('.map-card.document')].find((node: any) => node.textContent.includes('Worker runtime')) as any;
  runtime.click(); for (let index = 0; index < 8; index++) await turn();
  assert.equal(ui.calls.filter(call => call.action === 'review.history').at(-1)!.input.path, 'spec/workers/runtime.md');
});

test('line origins use the exact snapshot and disclose change requests and unknown lines', async () => {
  const ui = await setup();
  click(ui.document, 'Show line origins'); for (let index = 0; index < 8; index++) await turn();
  const call = ui.calls.find(item => item.action === 'review.provenance')!;
  assert.deepEqual(call.input, { projectId: 'one', path: 'spec/workers/runtime.md', versionId: 'spec:v1' });
  const panel = ui.document.querySelector('.provenance-panel')!;
  assert.match(panel.textContent!, /Export workflow revision/);
  assert.match(panel.textContent!, /Change request: Keep exported data local/);
  assert.match(panel.textContent!, /Origin unavailable/);
  assert.match(panel.textContent!, /Partial saved history/);
  click(ui.document, 'Open change request'); for (let index = 0; index < 10; index++) await turn();
  assert.equal(ui.calls.filter(item => item.action === 'workflow.list').at(-1)!.input.projectId, 'one');
  assert.match(ui.document.querySelector('.board-drawer')!.textContent!, /Export workflow revision/);
});
