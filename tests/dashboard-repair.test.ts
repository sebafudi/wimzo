import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { lexer } from 'marked';
import { markdownRenderer } from '../src/markdown.js';

const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '');
const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = async (count = 10) => { for (let index = 0; index < count; index++) await turn(); };

async function setup(compareFile: any = { status: 'modified', patch: '' }) {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const data = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }];
    if (action === 'project.get') return { id: 'one', name: 'First project' };
    if (action === 'task.list') return [{ id: 'task:export', projectId: 'one', objective: 'Ship local export', state: 'Accepted', requirements: [] }];
    if (action === 'inbox.list' || action === 'watch.list' || action === 'spec.list') return [];
    if (action === 'review.tree') return { files: [{ path: 'spec/moved/PRD.md', title: 'Moved requirements', status: 'Draft', workingChange: 'M', workingDiff: { additions: 4, deletions: 1 } }, { path: 'spec/other.md', title: 'Other requirements', status: 'Accepted', workingChange: 'M', workingDiff: { additions: 7, deletions: 2 } }], warnings: [] };
    if (action === 'review.history') return { versions: [{ id: 'spec:v2', label: 'Draft snapshot', at: '2026-09-23T10:00:00Z', source: 'snapshot', status: 'Draft', previousVersionId: 'spec:v1' }, { id: 'spec:v1', label: 'Accepted snapshot', at: '2026-09-22T10:00:00Z', source: 'snapshot', status: 'Accepted', previousVersionId: null }], nextOffset: null, warnings: [] };
    if (action === 'review.compare') return { kind: 'document', title: input.path, status: 'Draft', baseLabel: 'Accepted snapshot', afterLabel: 'Draft snapshot', files: [{ path: input.path, markdown: { before: '# Moved\n', after: '# Moved\n\nProposed line.\n' }, ...compareFile }], warnings: [], identity: {} };
    if (action === 'review.prepare') return { target: { kind: 'spec', projectId: 'one', specId: 'v2', specHash: 'hash', specRev: 1 }, fingerprint: 'review', canAccept: false, canRequest: false, feedback: [] };
    if (action === 'review.provenance') return { path: 'spec/moved/PRD.md', versionId: input.versionId, lines: [{ line: 1, text: '# Moved', versionId: 'spec:v0' }, { line: 2, text: 'Accepted rule.', versionId: 'spec:v1' }, { line: 3, text: 'Proposed line.', versionId: 'spec:v2' }], origins: [{ versionId: 'spec:v0', path: 'spec/old.md', label: 'Original request', originKnown: true, reviewed: true, accepted: true, proposed: false, acceptedAt: '2026-09-20T10:00:00Z', movedFrom: null }, { versionId: 'spec:v1', path: 'spec/moved/PRD.md', label: 'Reviewed specification change', originKnown: false, reviewed: true, accepted: true, proposed: false, acceptedAt: '2026-09-22T10:00:00Z', movedFrom: 'spec/old.md' }, { versionId: 'spec:v2', path: 'spec/moved/PRD.md', label: 'Proposed specification change', originKnown: false, reviewed: false, accepted: false, proposed: true, acceptedAt: null, movedFrom: null }], complete: true, warnings: ['1 never-accepted draft snapshot was skipped; lines appear under the next accepted revision.'] };
    if (action === 'release.list') return [{ id: 'release:1', projectId: 'one', taskId: 'task:export', decision: 'approve', version: '1.2.0', notes: 'Local only', provenance: { decision: 'Ship it', source: 'owner chat' }, at: '2026-09-24T10:00:00Z' }];
    if (action === 'decision.list') return [{ id: 'decision:1', projectId: 'one', summary: 'Keep exports local', requirements: ['R-7'], source: 'owner chat', status: 'open', at: '2026-09-25T10:00:00Z' }];
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
  await settle();
  return { document, calls };
}

const fileButton = (document: any, path: string) => document.querySelector(`.tree-file[aria-label="${path}"]`) as any;

test('the selected tree file follows the Compare to basis while other files keep Git HEAD counts', async () => {
  const unchanged = await setup();
  assert.equal(fileButton(unchanged.document, 'spec/moved/PRD.md').className, 'tree-file');
  assert.equal(fileButton(unchanged.document, 'spec/moved/PRD.md').querySelector('.change-badge'), null);
  assert.equal(fileButton(unchanged.document, 'spec/other.md').querySelector('.tree-diff-size').textContent, '+7-2');
  assert.match(unchanged.document.querySelector('.tree-legend')!.textContent!, /Selected file compares with Accepted snapshot; other files compare with Git HEAD/);
  assert.equal(unchanged.document.querySelector('.folder-changes')!.textContent, '1');
  const added = await setup({ status: 'added', patch: '@@ -0,0 +1,3 @@\n+# Moved\n+\n+Proposed line.\n' });
  const selected = fileButton(added.document, 'spec/moved/PRD.md');
  assert.match(selected.className, /working-A/);
  assert.equal(selected.querySelector('.tree-diff-size').textContent, '+3-0');
  assert.match(selected.querySelector('.change-badge').getAttribute('aria-label'), /Added compared with Accepted snapshot/);
  const unavailable = await setup({ status: 'modified', patch: '', unavailableReason: 'Comparison too large' });
  assert.equal(fileButton(unavailable.document, 'spec/moved/PRD.md').querySelector('.tree-diff-unknown').getAttribute('aria-label'), 'Comparison too large');
});

test('line origins show accepted revisions, proposed draft lines and moved paths', async () => {
  const ui = await setup();
  const toggle = [...ui.document.querySelectorAll('button')].find((item: any) => item.textContent === 'Show line origins') as any;
  toggle.click(); await settle(8);
  const panel = ui.document.querySelector('.provenance-panel')!;
  assert.match(panel.textContent!, /Accepted history traced/);
  assert.match(panel.textContent!, /never-accepted draft snapshot was skipped/);
  assert.equal(panel.querySelectorAll('.origin-accepted').length, 2);
  assert.match(panel.querySelector('.origin-accepted')!.textContent!, /^Accepted revision, /);
  assert.equal(panel.querySelector('.origin-proposed')!.textContent, 'Proposed, not accepted');
  assert.match(panel.textContent!, /Saved at spec\/old\.md/);
  assert.match(panel.textContent!, /Moved from spec\/old\.md/);
  const origins = [...panel.querySelectorAll('.provenance-origin')].map((cell: any) => cell.textContent);
  assert.deepEqual(origins, ['Original request', 'Origin unavailable', 'Proposed (not accepted)']);
});

test('decisions and releases load lazily into a read-only panel', async () => {
  const ui = await setup();
  assert.equal(ui.calls.some(call => call.action === 'release.list' || call.action === 'decision.list'), false);
  const panel = ui.document.querySelector('.records-panel') as any;
  assert.equal(panel.querySelector('summary').textContent, 'Decisions and releases');
  panel.open = true; panel.ontoggle(); await settle();
  assert.deepEqual(ui.calls.filter(call => call.action === 'release.list' || call.action === 'decision.list').map(call => [call.action, call.input]), [['release.list', { projectId: 'one' }], ['decision.list', { projectId: 'one' }]]);
  const records = ui.document.querySelector('.records-panel')!;
  assert.match(records.textContent!, /Read only/);
  const release = records.querySelector('.release-record')!.textContent!;
  assert.match(release, /Release approved/); assert.match(release, /Version 1\.2\.0/); assert.match(release, /Work: Ship local export/); assert.match(release, /Owner decision: Ship it/);
  const decision = records.querySelector('.decision-record')!.textContent!;
  assert.match(decision, /Keep exports local/); assert.match(decision, /Requirements: R-7/); assert.match(decision, /Source: owner chat/);
  assert.equal(records.querySelectorAll('button, input, textarea, select').length, 0);
});

test('pages use the full window width while reading columns keep a measured width', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  const last = (selector: string, property: string) => [...topLevel.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(match => match[1].split(',').map(item => item.trim()).includes(selector)).map(match => match[2].match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1]).filter(Boolean).at(-1);
  for (const selector of ['.page', '.workers-page', '.models-page', '.board-page']) assert.equal(last(selector, 'max-width'), 'none', selector);
  assert.equal(last('.markdown-document', 'max-width'), '76ch');
  assert.equal(last('.description', 'max-width'), '85ch');
  assert.match(css, /@media\(min-width:761px\)\{\.board-lane\{flex:1 0 270px;max-width:420px\}/);
});
