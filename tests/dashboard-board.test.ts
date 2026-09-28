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
const profileOne = { id: 'codex-terra-low', runtime: 'codex', model: 'gpt-5.6-terra', thinking: 'low', label: 'Terra, low', source: 'local-metadata', verified: true };
const profileTwo = { id: 'codex-astra-high', runtime: 'codex', model: 'gpt-6-astra', thinking: 'high', label: 'Astra, high', source: 'local-metadata', verified: true };

async function setup(options: { holdApproval?: boolean; lanes?: Record<string, any[]>; features?: any[]; diff?: any; tasks?: any[] } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const timers: Array<() => void> = [];
  let releaseApproval: (() => void) | undefined;
  let watermark = 1;
  const columns = [
    { id: 'ideas', title: 'Ideas', cards: [{ id: 'idea:i1', kind: 'idea', title: 'Offline notes', column: 'ideas', status: 'new', summary: 'Capture thoughts without a connection.' }] },
    { id: 'prd_review', title: 'PRD review', cards: [{ id: 'proposal:p1', kind: 'proposal', title: 'Add export flow', column: 'prd_review', status: 'Needs approval', summary: 'Add a bounded export flow.', specId: 'draft', path: 'spec/export.md', rev: 2, waitingReasons: ['owner approval required'] }] },
    { id: 'ready', title: 'Ready', cards: [{ id: 'spec:accepted', kind: 'spec', title: 'spec/ready.md', column: 'ready', status: 'Accepted', summary: 'Accepted requirements await bounded work.', specId: 'accepted', path: 'spec/ready.md', rev: 3 }] },
    { id: 'running', title: 'Running', cards: [] },
    { id: 'review', title: 'Review', cards: [] },
    { id: 'done', title: 'Done', cards: [] },
    { id: 'blocked', title: 'Blocked', cards: [] },
  ].map(column => options.lanes?.[column.id] ? { ...column, cards: options.lanes[column.id] } : column);
  const data = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }, { id: 'two', name: 'Second project' }];
    if (action === 'project.get') return { id: input.projectId, name: input.projectId === 'one' ? 'First project' : 'Second project' };
    if (action === 'task.list') return options.tasks ?? [];
    if (action === 'inbox.list' || action === 'watch.list') return [];
    if (action === 'review.tree') return { files: [{ path: 'spec/ready.md', title: 'Ready requirements', status: 'Accepted' }, { path: 'spec/export.md', title: 'Export requirements', status: 'Draft' }], warnings: [] };
    if (action === 'review.history') return { versions: [{ id: input.path === 'spec/ready.md' ? 'spec:accepted' : 'spec:draft', label: 'Saved', at: '2026-09-21T12:00:00Z', source: 'snapshot', status: input.path === 'spec/ready.md' ? 'Accepted' : 'Draft', previousVersionId: null }], nextOffset: null, warnings: [] };
    if (action === 'review.compare') return { kind: 'document', title: input.path, status: input.path === 'spec/ready.md' ? 'Accepted' : 'Draft', baseLabel: 'Empty', afterLabel: 'Saved', files: [{ path: input.path, status: 'added', patch: '', markdown: { before: null, after: '# Exact saved requirement\n' } }], warnings: [], identity: {} };
    if (action === 'review.prepare') return { target: input.target, fingerprint: 'review', canAccept: true, canRequest: true, feedback: [] };
    if (action === 'board.list') return { columns, watermark };
    if (action === 'workflow.list') return options.features ?? [];
    if (action === 'review.diff' && options.diff) return options.diff;
    if (action === 'evidence.list') return [];
    if (action === 'board.idea') return { idea: { id: 'new-idea' } };
    if (action === 'worker.options') return { profiles: [profileOne, profileTwo], catalog: { runtime: 'codex', eligible: true } };
    if (action === 'worker.recommend') return { profile: profileOne, source: 'jev', confidence: 0.8, reason: 'Best fit for this bounded change.' };
    if (action === 'board.prepare') {
      const profile = input.profile ?? null;
      return { fingerprint: profile ? `ready-${profile.id}` : 'unprofiled', title: 'Add export flow', scope: 'Implement only the accepted export path.', criteria: ['Exports one local file', 'Keeps private data local'], permissions: ['workspace-write'], budget: { maxExecutionMs: 300000 }, deadline: '2026-10-01T12:00:00Z', spec: { id: 'draft', hash: 'hash', rev: 2, status: 'Draft', path: 'spec/export.md' }, profile, canApprove: !!profile, reason: profile ? null : 'Select a supported worker profile before approval.' };
    }
    if (action === 'board.approve') return { task: { id: 'queued' } };
    return [];
  };
  const context: any = {
    document, crypto: { randomUUID }, lexer, markdownRenderer, URL, URLSearchParams, Intl,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '#key=fixture', pathname: '/', search: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    setInterval: (callback: () => void) => { timers.push(callback); return timers.length; }, clearInterval() {},
    fetch: async (_: string, request: any) => { const call = JSON.parse(request.body); calls.push(call);if(options.holdApproval&&call.action==='board.approve')await new Promise<void>(resolve=>{releaseApproval=resolve;});return { ok: true, status: 200, json: async () => ({ result: data(call.action, call.input) }) }; },
    console,
  };
  vm.runInNewContext(source, context);
  for (let index = 0; index < 8; index++) await turn();
  return { document, calls, timers, setWatermark: (value: number) => { watermark = value; }, releaseApproval: () => releaseApproval?.() };
}

function click(document: any, label: string) {
  const target = [...document.querySelectorAll('button')].find((button: any) => button.textContent === label) as any;
  assert.ok(target, `Missing button ${label}`);
  target.click();
}

test('Board is lazy, shows actual-state lanes, and saves a durable idea', async () => {
  const ui = await setup();
  assert.equal(ui.calls.some(call => call.action === 'board.list'), false);
  assert.deepEqual([...ui.document.querySelectorAll('.surface-tab')].map((node: any) => node.textContent), ['Requirements', 'Board', 'Workers', 'Models']);
  click(ui.document, 'Board');
  for (let index = 0; index < 6; index++) await turn();
  assert.equal(ui.document.querySelectorAll('.board-lane').length, 7);
  assert.deepEqual([...ui.document.querySelectorAll('.lane-head h2')].map((node: any) => node.textContent), ['Ideas', 'PRD review', 'Ready', 'In progress', 'Result review', 'Done', 'Blocked']);
  const title = ui.document.querySelector('[aria-label="Idea title"]') as any;
  const description = ui.document.querySelector('[aria-label="Idea description"]') as any;
  title.value = 'Add printable summary'; title.oninput();
  description.value = 'Let the owner print an exact saved result.'; description.oninput();
  (ui.document.querySelector('.idea-form') as any).onsubmit({ preventDefault() {} });
  for (let index = 0; index < 6; index++) await turn();
  const saved = ui.calls.find(call => call.action === 'board.idea')!;
  assert.deepEqual({ ...saved.input, submissionId: '<id>' }, { projectId: 'one', title: 'Add printable summary', description: 'Let the owner print an exact saved result.', submissionId: '<id>' });
  assert.equal(typeof saved.input.submissionId, 'string');
  assert.match(ui.document.body.textContent!, /Idea added to the board/);
});

test('proposal approval shows exact bounds and sends one supported full profile', async () => {
  const ui = await setup(); click(ui.document, 'Board');
  for (let index = 0; index < 5; index++) await turn();
  ([...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('Add export flow')) as any).click();
  for (let index = 0; index < 12; index++) await turn();
  assert.equal(ui.calls.filter(call => call.action === 'worker.recommend').length, 1);
  assert.deepEqual(ui.calls.filter(call => call.action === 'board.prepare').map(call => call.input.profile ?? null), [null, profileOne]);
  assert.match(ui.document.querySelector('.board-drawer')!.textContent!, /Implement only the accepted export path/);
  assert.match(ui.document.querySelector('.board-drawer')!.textContent!, /Exports one local file/);
  assert.match(ui.document.querySelector('.board-drawer')!.textContent!, /spec\/export.md \(Draft\)/);
  assert.match(ui.document.querySelector('.board-drawer')!.textContent!, /Execution limit5 minutes/);
  assert.ok([...ui.document.querySelectorAll('button')].find((button: any) => button.textContent === 'Approve PRD and queue work'));

  const model = ui.document.querySelector('[aria-label="Model"]') as any;
  for (const option of model.children) option.selected = option.value === 'gpt-6-astra'; model.onchange();
  const thinking = ui.document.querySelector('[aria-label="Thinking"]') as any;
  for (const option of thinking.children) option.selected = option.value === 'high'; thinking.onchange();
  for (let index = 0; index < 8; index++) await turn();
  click(ui.document, 'Approve PRD and queue work');
  for (let index = 0; index < 6; index++) await turn();
  const approved = ui.calls.find(call => call.action === 'board.approve')!;
  assert.equal(approved.input.fingerprint, 'ready-codex-astra-high');
  assert.deepEqual(approved.input.profile, profileTwo);
  assert.equal(typeof approved.input.submissionId, 'string');
  const completed = [...ui.document.querySelectorAll('button')].find((button: any) => button.textContent === 'Approved and queued') as any;
  assert.ok(completed?.disabled);
  assert.ok([...ui.document.querySelectorAll('.profile-picker select')].every((select: any) => select.disabled));
});

test('polling keeps form text, avoids repeated recommendations, and project requirement cards open exact versions', async () => {
  const ui = await setup(); click(ui.document, 'Board');
  for (let index = 0; index < 5; index++) await turn();
  const title = ui.document.querySelector('[aria-label="Idea title"]') as any; title.value = 'Unsaved board draft'; title.oninput();
  ([...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('Add export flow')) as any).click();
  for (let index = 0; index < 10; index++) await turn();
  ui.setWatermark(2); ui.timers.at(-1)!();
  for (let index = 0; index < 6; index++) await turn();
  assert.equal((ui.document.querySelector('[aria-label="Idea title"]') as any).value, 'Unsaved board draft');
  assert.equal(ui.calls.filter(call => call.action === 'worker.recommend').length, 1);
  click(ui.document, 'Close');
  ([...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('spec/ready.md')) as any).click();
  for (let index = 0; index < 8; index++) await turn();
  assert.equal(ui.document.querySelector('.surface-tab[aria-current="true"]')?.textContent, 'Requirements');
  assert.equal(ui.calls.filter(call => call.action === 'review.compare').at(-1)!.input.afterVersion, 'spec:accepted');
  assert.match(ui.document.querySelector('.markdown-document')!.textContent!, /Exact saved requirement/);
});

test('a late approval response cannot update a different project or board card', async () => {
  const ui = await setup({ holdApproval: true }); click(ui.document, 'Board');
  for (let index = 0; index < 5; index++) await turn();
  ([...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('Add export flow')) as any).click();
  for (let index = 0; index < 10; index++) await turn();
  click(ui.document, 'Approve PRD and queue work'); await turn();
  const project = ui.document.querySelector('[aria-label="Project"]') as any;
  for (const option of project.children) option.selected = option.value === 'two'; project.onchange();
  for (let index = 0; index < 6; index++) await turn();
  ui.releaseApproval(); for (let index = 0; index < 8; index++) await turn();
  assert.equal((ui.document.querySelector('[aria-label="Project"]') as any).value, 'two');
  assert.equal(ui.document.querySelector('.board-drawer'), null);
  assert.doesNotMatch(ui.document.body.textContent!, /Approved and queued/);
});

function laneTexts(document: any) {
  return Object.fromEntries([...document.querySelectorAll('.board-lane')].map((lane: any) => [lane.querySelector('.lane-head h2').textContent, [...lane.querySelectorAll('.board-card')].map((card: any) => card.textContent)]));
}

test('Board lanes show queued waiting reasons, running, blocked and completed tasks and features', async () => {
  const task = (id: string, column: string, status: string, waitingReasons: string[] = []) => ({ id: `task:${id}`, kind: 'task', title: `Work ${id}`, column, status, summary: `Scope ${id}.`, taskId: id, specId: 'accepted', path: 'spec/ready.md', rev: 1, waitingReasons });
  const feature = (id: string, phase: string, extra: Record<string, unknown> = {}) => ({ id: `feature:${id}`, projectId: 'one', title: `Feature ${id}`, description: `Feature ${id} outcome.`, phase, taskIds: [], documentIds: [], ...extra });
  const ui = await setup({
    lanes: {
      ready: [task('queued', 'ready', 'Approved', ['resource busy: export.lock', 'dependency pending'])],
      running: [task('running', 'running', 'Running (implementing)'), task('duplicate', 'running', 'Running')],
      done: [task('done', 'done', 'Accepted')],
      blocked: [task('blocked', 'blocked', 'Blocked', ['missing fixture credentials'])],
    },
    features: [feature('queued', 'ready', { waitingFor: 'planner' }), feature('running', 'implementing', { taskIds: ['duplicate'] }), feature('blocked', 'blocked'), feature('done', 'done')],
  });
  click(ui.document, 'Board');
  for (let index = 0; index < 6; index++) await turn();
  const lanes = laneTexts(ui.document);
  assert.equal(lanes.Ready.length, 2);
  assert.ok(lanes.Ready.some((text: string) => /Work queued/.test(text) && /resource busy: export\.lock/.test(text)));
  assert.ok(lanes.Ready.some((text: string) => /Feature queued/.test(text) && /Awaiting planner/.test(text)));
  assert.equal(lanes['In progress'].length, 2);
  assert.ok(lanes['In progress'].some((text: string) => /Work running/.test(text) && /Running \(implementing\)/.test(text)));
  assert.ok(lanes['In progress'].some((text: string) => /Feature running/.test(text) && /Implementing/.test(text)));
  assert.equal(lanes['In progress'].some((text: string) => /Work duplicate/.test(text)), false);
  assert.equal(lanes.Blocked.length, 2);
  assert.ok(lanes.Blocked.some((text: string) => /Work blocked/.test(text) && /missing fixture credentials/.test(text)));
  assert.ok(lanes.Blocked.some((text: string) => /Feature blocked/.test(text)));
  assert.equal(lanes.Done.length, 2);
  assert.ok(lanes.Done.some((text: string) => /Work done/.test(text) && /Accepted/.test(text)));
  assert.ok(lanes.Done.some((text: string) => /Feature done/.test(text)));
  const counts = [...ui.document.querySelectorAll('.lane-count')].map((node: any) => node.textContent);
  assert.deepEqual(counts, ['1', '1', '2', '2', '0', '2', '2']);
});

test('a task in result review renders its code patch as a readable line diff', async () => {
  const reviewTask = { id: 'code-change', objective: 'Rename the export helper', title: 'Rename the export helper', state: 'Needs result review', scope: 'Rename only the export helper.', candidate: { id: 'candidate-code' }, createdBy: { at: '2026-09-21T12:00:00Z' } };
  const diff = { kind: 'task', title: 'Rename the export helper', status: 'Needs result review', baseLabel: 'Before', afterLabel: 'After', files: [{ path: 'src/export.ts', status: 'modified', patch: '@@ -1,3 +1,3 @@\n import { write } from "./io";\n-export function oldExport() {}\n+export function newExport() {}\n const unchanged = true;' }], warnings: [], identity: { candidate: { id: 'candidate-code' } } };
  const ui = await setup({ tasks: [reviewTask], diff, lanes: { review: [{ id: 'task:code-change', kind: 'task', title: 'Rename the export helper', column: 'review', status: 'Needs result review', summary: 'Rename only the export helper.', taskId: 'code-change', specId: 'accepted', path: 'spec/ready.md', rev: 1, waitingReasons: [] }] } });
  click(ui.document, 'Board');
  for (let index = 0; index < 6; index++) await turn();
  ([...ui.document.querySelectorAll('.board-card')].find((card: any) => card.textContent.includes('Rename the export helper')) as any).click();
  for (let index = 0; index < 12; index++) await turn();
  assert.deepEqual(ui.calls.filter(call => call.action === 'review.diff').at(-1)!.input, { taskId: 'code-change' });
  assert.match(ui.document.querySelector('.file-heading')!.textContent!, /src\/export\.ts/);
  assert.match(ui.document.querySelector('.file-heading')!.textContent!, /Modified/);
  const cells = (row: any) => [...row.querySelectorAll('td')].map((cell: any) => cell.textContent);
  const split = ui.document.querySelector('.diff-table.split') as any;
  assert.ok(split, 'Missing side-by-side code diff table');
  assert.deepEqual([...split.querySelectorAll('th')].map((node: any) => node.textContent), ['Before', 'After']);
  assert.deepEqual(cells(split.querySelector('td.removed').parentNode), ['2', 'export function oldExport() {}', '2', 'export function newExport() {}']);
  assert.equal(split.querySelector('td.removed').getAttribute('aria-label'), 'Removed');
  assert.equal(split.querySelector('td.added').getAttribute('aria-label'), 'Added');
  click(ui.document, 'Unified');
  for (let index = 0; index < 4; index++) await turn();
  const unified = ui.document.querySelector('.diff-table') as any;
  assert.equal(unified.classList.contains('split'), false);
  const rows = (kind: string) => [...unified.querySelectorAll(`tr.${kind}`)].map(cells);
  assert.deepEqual(rows('removed'), [['2', '', '-', 'export function oldExport() {}']]);
  assert.deepEqual(rows('added'), [['', '2', '+', 'export function newExport() {}']]);
  assert.deepEqual(rows('context').map(row => row[3]), ['import { write } from "./io";', 'const unchanged = true;']);
  assert.equal(ui.document.querySelector('.markdown-document'), null);
});
