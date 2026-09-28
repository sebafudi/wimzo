import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';

const owner = { role: 'owner' as const, id: 'triage-owner' };
const guide = { role: 'guide' as const, id: 'triage-guide' };
const system = { role: 'system' as const, id: 'triage-system' };
const worker = { role: 'worker' as const, id: 'triage-worker', taskId: 'none' };

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'wimzo-triage-'));
  const root = join(temp, 'project'); mkdirSync(join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/PRD.md'), '**H-001 Fixture.**\nTriage fixture behavior.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false'); git('add', '.'); git('commit', '-q', '-m', 'Fixture');
  const store = new Store(':memory:'); const domain = Domain(store);
  const board = Board(store, domain, {} as any, {} as any, {} as any);
  const project = domain.call('project.register', { id: 'triage-project', name: 'Triage fixture', root, purpose: 'triage tests', canonicalPaths: ['spec/PRD.md'] }, owner);
  return { store, domain, board, project, close: () => { store.close(); rmSync(temp, { recursive: true, force: true }); } };
}
const triageCards = (board: any) => board.columns.flatMap((column: any) => column.cards).filter((card: any) => card.id.startsWith('inbox:triage:') || card.title === 'gap' || card.title === 'bug');

test('triage.resolve records resolution, actor and time and refuses unknown or already resolved items', () => {
  const f = fixture();
  try {
    const descriptor: any = f.domain.actions().find((action: any) => action.name === 'triage.resolve');
    assert.deepEqual(descriptor.roles, ['owner', 'guide']);
    assert.deepEqual(descriptor.inputSchema.required, ['triageId', 'resolution']);
    assert.deepEqual(Object.keys(descriptor.inputSchema.properties).sort(), ['evidence', 'expectedRev', 'resolution', 'triageId']);
    assert.equal(descriptor.inputSchema.properties.evidence.type, 'array');
    const triage = f.domain.call('triage.classify', { projectId: f.project.id, classification: 'bug', summary: 'Fixture bug' }, owner);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: triage.id, resolution: 'Fixed' }, system), /not permitted|role|Forbidden/i);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: triage.id, resolution: 'Fixed' }, worker), /not permitted|role|Forbidden/i);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: 'triage_missing', resolution: 'Fixed' }, owner), /Unknown triage/);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: triage.id, expectedRev: triage.rev + 1, resolution: 'Fixed' }, owner), /stale/);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: triage.id, resolution: '  ' }, owner), /resolution is required/);
    const resolved = f.domain.call('triage.resolve', { triageId: triage.id, expectedRev: triage.rev, resolution: 'Fixed in abc123', evidence: [{ commit: 'abc123' }] }, guide);
    assert.equal(resolved.status, 'resolved'); assert.equal(resolved.resolution, 'Fixed in abc123');
    assert.deepEqual(resolved.resolvedBy, { id: guide.id, role: 'guide' }); assert.ok(Date.parse(resolved.resolvedAt));
    assert.deepEqual(resolved.resolutionEvidence, [{ commit: 'abc123' }]);
    const event = f.store.events().find(value => value.type === 'triage.resolved');
    assert.equal(event?.data.triageId, triage.id); assert.equal(event?.data.actor.id, guide.id); assert.equal(event?.data.at, resolved.resolvedAt);
    assert.throws(() => f.domain.call('triage.resolve', { triageId: triage.id, resolution: 'Again' }, owner), /already resolved/);
  } finally { f.close(); }
});

test('Board no longer lists resolved triage items or their inbox cards', async () => {
  const f = fixture();
  try {
    const bug = f.domain.call('triage.classify', { projectId: f.project.id, classification: 'bug', summary: 'Fixture bug' }, owner);
    const gap = f.domain.call('triage.classify', { projectId: f.project.id, classification: 'gap', summary: 'Fixture gap' }, owner);
    let listed = triageCards(await f.board.call('board.list', { projectId: f.project.id }, owner));
    assert.equal(listed.length, 2);
    f.domain.call('triage.resolve', { triageId: bug.id, resolution: 'Fixed' }, owner);
    f.domain.call('triage.resolve', { triageId: gap.id, resolution: 'Covered by accepted PRD' }, owner);
    listed = triageCards(await f.board.call('board.list', { projectId: f.project.id }, owner));
    assert.deepEqual(listed, []);
    assert.ok(f.store.list<any>('inbox').filter(item => item.data?.triageId === gap.id).every(item => item.status === 'resolved'));
  } finally { f.close(); }
});
