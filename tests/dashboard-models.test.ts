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
const models = [
  { id: 'openai:gpt-one', provider: 'openai', harnesses: ['codex'], authRoutes: ['subscription'], description: 'First verified local model.', source: 'runtime-capability:codex', updatedAt: '2026-09-22T10:00:00Z', rev: 2, revision: 2 },
];

async function setup() {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const calls: Array<{ action: string; input: any }> = [];
  const policies: Record<string, any> = {
    one: { projectId: 'one', policy: { providers: [] }, revision: 3, updatedAt: '2026-09-22T11:00:00Z', updatedBy: { id: 'owner-chat', role: 'owner' } },
    two: { projectId: 'two', policy: { models: ['gpt-two'] }, revision: 1 },
  };
  let holdNextPolicy = false;
  let releasePolicy: (() => void) | null = null;
  const result = (action: string, input: any): any => {
    if (action === 'project.list') return [{ id: 'one', name: 'First project' }, { id: 'two', name: 'Second project' }];
    if (action === 'project.get') return { id: input.projectId, name: input.projectId === 'one' ? 'First project' : 'Second project' };
    if (action === 'task.list' || action === 'inbox.list' || action === 'watch.list') return [];
    if (action === 'review.tree') return { files: [], warnings: [] };
    if (action === 'models.list') return models;
    if (action === 'project.workerPolicy.get') return policies[input.projectId];
    if (action === 'model.describe') return { ...models[0], description: input.description, source: input.source, rev: 3, revision: 3 };
    if (action === 'project.workerPolicy.set') {
      const saved = { projectId: input.projectId, policy: input.policy, revision: input.expectedRev + 1 };
      policies[input.projectId] = saved;
      return saved;
    }
    if (action === 'board.list') return { columns: [], watermark: 1 };
    return [];
  };
  const context: any = {
    document, crypto: { randomUUID }, lexer, markdownRenderer, URL, URLSearchParams, Intl,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '#key=fixture', pathname: '/', search: '' }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false }), setInterval: () => 1, clearInterval() {},
    fetch: async (_: string, request: any) => {
      const call = JSON.parse(request.body); calls.push(call);
      const value = result(call.action, call.input);
      if (call.action === 'project.workerPolicy.get' && holdNextPolicy) {
        holdNextPolicy = false;
        await new Promise<void>(resolve => { releasePolicy = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({ result: value }) };
    },
    console,
  };
  vm.runInNewContext(source, context);
  for (let index = 0; index < 8; index++) await turn();
  return {
    document, calls,
    holdPolicy() { holdNextPolicy = true; },
    releasePolicy() { releasePolicy?.(); },
  };
}

function click(document: any, label: string) {
  const target = [...document.querySelectorAll('button')].find((button: any) => button.textContent === label) as any;
  assert.ok(target, `Missing button ${label}`);
  target.click();
}

function selectValue(select: any, value: string) {
  ([...select.children].find((option: any) => option.value === value) as any).selected = true;
  select.onchange();
}

test('Models loads only when opened and shows only discovered catalog records', async () => {
  const ui = await setup();
  assert.equal(ui.calls.some(call => call.action === 'models.list'), false);
  click(ui.document, 'Models');
  for (let index = 0; index < 8; index++) await turn();
  assert.deepEqual(ui.calls.find(call => call.action === 'models.list')!.input, {});
  assert.deepEqual(ui.calls.find(call => call.action === 'project.workerPolicy.get')!.input, { projectId: 'one' });
  assert.match(ui.document.querySelector('.model-list')!.textContent!, /gpt-one/);
  assert.doesNotMatch(ui.document.body.textContent!, /Fable/i);
  assert.equal((ui.document.querySelector('[aria-label="Providers policy mode"]') as any).value, 'deny');
});

test('Models shows discovery facts, labels unknown values and names the policy author', async () => {
  const original = models[0];
  try {
    models[0] = { ...original, discovery: { available: false, thinkingLevels: ['low', 'high'], contextWindow: null, lastSeen: null } } as any;
    const ui = await setup(); click(ui.document, 'Models');
    for (let index = 0; index < 8; index++) await turn();
    const facts = ui.document.querySelector('.model-facts')!.textContent!;
    assert.match(facts, /Unavailable/);
    assert.match(facts, /Thinking: low, high/);
    assert.match(facts, /Context: unknown/);
    assert.match(facts, /Last seen: unknown/);
    assert.match(ui.document.body.textContent!, /Last changed by owner owner-chat/);
    models[0] = original;
    const plain = await setup(); click(plain.document, 'Models');
    for (let index = 0; index < 8; index++) await turn();
    assert.match(plain.document.querySelector('.model-facts')!.textContent!, /Availability unknown · Thinking: unknown/);
  } finally { models[0] = original; }
});

test('an owner description edit sends the unprefixed model and exact revision', async () => {
  const ui = await setup(); click(ui.document, 'Models');
  for (let index = 0; index < 8; index++) await turn();
  const description = ui.document.querySelector('[aria-label="Description for gpt-one"]') as any;
  description.value = 'Use for focused implementation after a reviewed plan.'; description.oninput();
  click(ui.document, 'Save description');
  for (let index = 0; index < 8; index++) await turn();
  const call = ui.calls.find(item => item.action === 'model.describe')!;
  assert.deepEqual(call.input, { provider: 'openai', model: 'gpt-one', description: 'Use for focused implementation after a reviewed plan.', source: 'owner', expectedRev: 2 });
  assert.match(ui.document.body.textContent!, /Description saved/);
});

test('policy editor distinguishes defaults from deny-all and saves selected discovered models', async () => {
  const ui = await setup(); click(ui.document, 'Models');
  for (let index = 0; index < 8; index++) await turn();
  selectValue(ui.document.querySelector('[aria-label="Providers policy mode"]'), 'default');
  selectValue(ui.document.querySelector('[aria-label="Models policy mode"]'), 'restrict');
  const modelMode = ui.document.querySelector('[aria-label="Models policy mode"]') as any;
  assert.equal(modelMode.value, 'restrict', modelMode.outerHTML);
  const model = ui.document.querySelector('[aria-label="Allow gpt-one"]') as any;
  model.checked = true; model.onchange();
  click(ui.document, 'Save project policy');
  for (let index = 0; index < 8; index++) await turn();
  const call = ui.calls.find(item => item.action === 'project.workerPolicy.set')!;
  assert.deepEqual(call.input, { projectId: 'one', policy: { models: ['gpt-one'] }, expectedRev: 3 });
  assert.match(ui.document.body.textContent!, /Project worker policy saved/);
});

test('project policy drafts survive navigation and stale project responses are discarded', async () => {
  const ui = await setup(); click(ui.document, 'Models');
  for (let index = 0; index < 8; index++) await turn();
  selectValue(ui.document.querySelector('[aria-label="Providers policy mode"]'), 'default');
  const description = ui.document.querySelector('[aria-label="Description for gpt-one"]') as any;
  description.value = 'Unsaved owner wording'; description.oninput();
  ui.holdPolicy();
  const project = ui.document.querySelector('[aria-label="Project"]') as any;
  selectValue(project, 'two');
  for (let index = 0; index < 6; index++) await turn();
  const secondProject = ui.document.querySelector('[aria-label="Project"]') as any;
  selectValue(secondProject, 'one');
  for (let index = 0; index < 10; index++) await turn();
  ui.releasePolicy(); for (let index = 0; index < 8; index++) await turn();
  assert.equal((ui.document.querySelector('[aria-label="Project"]') as any).value, 'one');
  assert.equal((ui.document.querySelector('[aria-label="Providers policy mode"]') as any).value, 'default');
  assert.equal((ui.document.querySelector('[aria-label="Description for gpt-one"]') as any).value, 'Unsaved owner wording');
  assert.deepEqual(ui.calls.filter(call => call.action === 'project.workerPolicy.get').at(-1)!.input, { projectId: 'one' });
});
