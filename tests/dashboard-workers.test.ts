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

function workerResult(title = 'Index product requirements') {
  return {
    observedAt: '2026-09-22T10:30:00Z',
    capacity: { activeTechnical: 1, maxTechnical: 2, activeGui: 0, maxGui: 1 },
    runtimes: [
      { id: 'codex', label: 'Codex', available: true, eligible: true, access: 'local', reason: null, version: '1.2.3', limits: { concurrent: 2 } },
      { id: 'codex-app', label: 'Codex desktop', available: true, eligible: false, access: 'desktop session', reason: 'Automatic dispatch is not supported for app-driven sessions.', version: null, limits: null },
      { id: 'gui', label: 'Desktop control', available: false, eligible: false, access: null, reason: 'No interactive session is attached.', version: null, limits: null },
    ],
    active: [{
      id: 'run-active', taskId: 'task-active', taskTitle: title, projectId: 'one', projectName: 'First project', status: 'Running', phase: 'Implementing', runtime: 'codex', provider: null, model: null, thinking: null, profileSource: 'codex-default', startedAt: '2026-09-22T10:25:00Z', finishedAt: null, elapsedMs: 300000, deadline: null, worktree: '/private/worktree', permissions: ['workspace-write'], context: { used: null, capacity: null, estimated: false, source: null, observedAt: '2026-09-22T10:30:00Z' }, lastProgress: { at: '2026-09-22T10:29:00Z', summary: 'Validating the product tree.' }, resultSummary: null, sessionId: 'session-private', outputAvailable: false, waitingReasons: [],
    }],
    queued: [{ id: 'run-queued', taskId: 'task-queued', taskTitle: 'Render release notes', projectId: 'two', projectName: 'Second project', status: 'Approved', phase: 'Queued', runtime: 'codex', provider: 'OpenAI', model: 'gpt-6-astra', thinking: 'high', profileSource: 'local-metadata', startedAt: null, finishedAt: null, elapsedMs: null, deadline: null, worktree: null, permissions: [], context: null, lastProgress: null, resultSummary: null, sessionId: null, outputAvailable: null, waitingReasons: ['Technical worker capacity is full.'] }],
    recent: [{ id: 'run-recent', taskId: 'task-recent', taskTitle: 'Check export', projectId: 'one', projectName: 'First project', status: 'Completed', phase: 'Done', runtime: 'codex', provider: 'OpenAI', model: 'gpt-5.6-terra', thinking: 'medium', profileSource: 'local-metadata', startedAt: '2026-09-22T09:00:00Z', finishedAt: '2026-09-22T09:02:00Z', elapsedMs: 120000, deadline: null, worktree: null, permissions: ['workspace-read'], context: { used: 1250, capacity: 8000, estimated: true, source: 'runtime report', observedAt: '2026-09-22T09:02:00Z' }, lastProgress: null, resultSummary: 'All checks passed.', sessionId: null, outputAvailable: true, waitingReasons: [] }],
  };
}

async function setup() {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  let holdNext = false;
  let releaseHeld: (() => void) | null = null;
  let statusTitle = 'Index product requirements';
  const data = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }, { id: 'two', name: 'Second project' }];
    if (action === 'project.get') return { id: input.projectId, name: input.projectId === 'one' ? 'First project' : 'Second project' };
    if (action === 'task.list' || action === 'inbox.list' || action === 'watch.list') return [];
    if (action === 'review.tree') return { files: [], warnings: [] };
    if (action === 'worker.status') return workerResult(input.projectId ? 'Current project run' : statusTitle);
    return [];
  };
  const context: any = {
    document, crypto: { randomUUID }, lexer, markdownRenderer, URL, URLSearchParams, Intl,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '#key=fixture', pathname: '/', search: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    setInterval: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearInterval: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    fetch: async (_: string, request: any) => {
      const call = JSON.parse(request.body); calls.push(call);
      const result = data(call.action, call.input);
      if (call.action === 'worker.status' && holdNext) {
        holdNext = false;
        await new Promise<void>(resolve => { releaseHeld = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({ result }) };
    },
    console,
  };
  vm.runInNewContext(source, context);
  for (let index = 0; index < 8; index++) await turn();
  return {
    document, calls, timers,
    setStatusTitle(value: string) { statusTitle = value; },
    holdNextStatus() { holdNext = true; },
    releaseStatus() { releaseHeld?.(); },
  };
}

function click(document: any, label: string) {
  const target = [...document.querySelectorAll('button')].find((button: any) => button.textContent === label) as any;
  assert.ok(target, `Missing button ${label}`);
  target.click();
}

test('Workers loads lazily, reports actual capacity, and labels unknown context', async () => {
  const ui = await setup();
  assert.equal(ui.calls.some(call => call.action === 'worker.status'), false);
  assert.deepEqual([...ui.document.querySelectorAll('.surface-tab')].map((node: any) => node.textContent), ['Requirements', 'Board', 'Workers', 'Models']);
  click(ui.document, 'Workers');
  for (let index = 0; index < 8; index++) await turn();
  assert.deepEqual(ui.calls.find(call => call.action === 'worker.status')!.input, {});
  assert.match(ui.document.querySelector('.worker-capacity')!.textContent!, /1 \/ 2Technical workers/);
  assert.match(ui.document.body.textContent!, /Index product requirements/);
  assert.match(ui.document.body.textContent!, /Codex \(account default\)/);
  assert.match(ui.document.body.textContent!, /ContextUnavailable/);
  assert.match(ui.document.body.textContent!, /No interactive session is attached/);
  assert.match(ui.document.body.textContent!, /Codex desktopManual \/ app-drivenAvailable for work started from the Codex desktop app/);
  assert.match(ui.document.body.textContent!, /Automatic dispatch is not supported for app-driven sessions/);
  assert.match(ui.document.body.textContent!, /Technical worker capacity is full/);
  assert.equal(ui.timers.filter(timer => !timer.cleared).length, 1);
  click(ui.document, 'Requirements');
  assert.equal(ui.timers.filter(timer => !timer.cleared).length, 0);
});

test('polling preserves expanded runs and refreshes only while Workers is visible', async () => {
  const ui = await setup(); click(ui.document, 'Workers');
  for (let index = 0; index < 8; index++) await turn();
  const run = ui.document.querySelector('[data-run-id="run-active"]') as any;
  run.open = true; run.ontoggle();
  ui.setStatusTitle('Updated active run');
  ui.timers.find(timer => !timer.cleared)!.callback();
  for (let index = 0; index < 8; index++) await turn();
  const refreshed = ui.document.querySelector('[data-run-id="run-active"]') as any;
  assert.equal(refreshed.open, true);
  assert.match(refreshed.textContent, /Updated active run/);
  const callsBeforeLeaving = ui.calls.filter(call => call.action === 'worker.status').length;
  click(ui.document, 'Board');
  const oldWorkerTimer = ui.timers.find(timer => timer.cleared && timer.callback)!;
  oldWorkerTimer.callback();
  for (let index = 0; index < 3; index++) await turn();
  assert.equal(ui.calls.filter(call => call.action === 'worker.status').length, callsBeforeLeaving);
});

test('project filtering rejects stale all-project responses and survives project changes', async () => {
  const ui = await setup(); click(ui.document, 'Workers');
  for (let index = 0; index < 8; index++) await turn();
  ui.setStatusTitle('Stale all-project run'); ui.holdNextStatus();
  ui.timers.find(timer => !timer.cleared)!.callback(); await turn();
  const filter = ui.document.querySelector('[aria-label="Worker project filter"]') as any;
  for (const option of filter.children) option.selected = option.value === 'current'; filter.onchange();
  for (let index = 0; index < 8; index++) await turn();
  assert.deepEqual(ui.calls.filter(call => call.action === 'worker.status').at(-1)!.input, { projectId: 'one' });
  assert.match(ui.document.body.textContent!, /Current project run/);
  ui.releaseStatus(); for (let index = 0; index < 8; index++) await turn();
  assert.doesNotMatch(ui.document.body.textContent!, /Stale all-project run/);
  const project = ui.document.querySelector('[aria-label="Project"]') as any;
  for (const option of project.children) option.selected = option.value === 'two'; project.onchange();
  for (let index = 0; index < 10; index++) await turn();
  assert.equal((ui.document.querySelector('[aria-label="Worker project filter"]') as any).value, 'current');
  assert.deepEqual(ui.calls.filter(call => call.action === 'worker.status').at(-1)!.input, { projectId: 'two' });
});
