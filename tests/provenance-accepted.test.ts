import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Domain } from '../src/domain.ts';
import { Store } from '../src/store.ts';
import { documentProvenance } from '../src/product-map.ts';

const owner = { role: 'owner' as const, id: 'provenance-owner' };
const guide = { role: 'guide' as const, id: 'provenance-guide' };

function fixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-provenance-'));
  mkdirSync(join(root, 'spec/workers'), { recursive: true });
  writeFileSync(join(root, 'spec/workers.md'), content);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const store = new Store(':memory:');
  const domain = Domain(store);
  const project = domain.call('project.register', { id: 'provenance-project', name: 'Provenance fixture', root, purpose: 'provenance tests', canonicalPaths: ['spec/workers.md', 'spec/workers/PRD.md'] }, owner);
  const write = (path: string, text: string) => writeFileSync(join(root, path), text);
  const capture = (path: string, extra: Record<string, unknown> = {}) => { const start = Date.now(); while (Date.now() - start < 3); return domain.call('spec.capture', { projectId: project.id, path, ...extra }, owner); };
  const accept = (spec: any) => domain.call('spec.accept', { specId: spec.id, hash: spec.hash, expectedRev: spec.rev, decision: 'Accept fixture bytes', source: 'provenance test' }, owner).spec;
  return { root, store, domain, project, write, capture, accept, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('line origins credit accepted snapshots and mark never-accepted draft lines as proposed', () => {
  const context = fixture('# Workers\n\nKeep this rule.\n');
  try {
    const first = context.accept(context.capture('spec/workers.md'));
    context.write('spec/workers.md', '# Workers\n\nKeep this rule.\nAbandoned idea.\n');
    const abandoned = context.capture('spec/workers.md');
    context.write('spec/workers.md', '# Workers\n\nKeep this rule.\nAccepted behavior.\n');
    const second = context.accept(context.capture('spec/workers.md'));
    assert.equal(context.store.require<any>('spec', second.id).previousId, abandoned.id);
    const accepted = documentProvenance(context.store, context.project.id, 'spec/workers.md');
    assert.equal(accepted.lines[3].versionId, `spec:${second.id}`);
    assert.equal(accepted.origins.some((origin: any) => origin.versionId === `spec:${abandoned.id}`), false);
    const origin = accepted.origins.find((item: any) => item.versionId === `spec:${second.id}`);
    assert.equal(origin.accepted, true); assert.equal(origin.proposed, false); assert.ok(origin.acceptedAt); assert.ok(origin.approvalId);
    assert.ok(accepted.warnings.some((warning: string) => /1 never-accepted draft snapshot was skipped/.test(warning)));
    assert.equal(accepted.lines[2].versionId, `spec:${first.id}`);
    context.write('spec/workers.md', '# Workers\n\nKeep this rule.\nAccepted behavior.\nProposed follow-up.\n');
    const proposal = context.capture('spec/workers.md');
    const pending = documentProvenance(context.store, context.project.id, 'spec/workers.md', `spec:${proposal.id}`);
    assert.equal(pending.lines[3].versionId, `spec:${second.id}`);
    assert.equal(pending.lines[4].versionId, `spec:${proposal.id}`);
    const proposed = pending.origins.find((item: any) => item.versionId === `spec:${proposal.id}`);
    assert.equal(proposed.proposed, true); assert.equal(proposed.acceptedAt, null); assert.equal(proposed.label, 'Proposed specification change');
    assert.ok(pending.warnings.some((warning: string) => /not accepted/.test(warning)));
  } finally { context.close(); }
});

test('spec.capture movedFrom continues snapshot provenance across a document move', () => {
  const context = fixture('# Workers\n\nKeep this rule.\n');
  try {
    const before = context.accept(context.capture('spec/workers.md'));
    renameSync(join(context.root, 'spec/workers.md'), join(context.root, 'spec/workers/PRD.md'));
    context.write('spec/workers/PRD.md', '# Workers\n\nKeep this rule.\nMoved addition.\n');
    assert.throws(() => context.capture('spec/workers/PRD.md', { movedFrom: 'spec/missing.md' }), /no saved snapshot/);
    assert.throws(() => context.capture('spec/workers/PRD.md', { movedFrom: '../outside.md' }), /different project-relative path/);
    assert.throws(() => context.capture('spec/workers/PRD.md', { movedFrom: 'spec/workers/PRD.md' }), /different project-relative path/);
    const moved = context.capture('spec/workers/PRD.md', { movedFrom: 'spec/workers.md' });
    assert.equal(moved.previousId, before.id); assert.equal(moved.movedFrom, 'spec/workers.md');
    assert.throws(() => context.capture('spec/workers/PRD.md', { movedFrom: 'spec/workers.md' }), /first snapshot at a new path/);
    const accepted = context.accept(moved);
    const result = documentProvenance(context.store, context.project.id, 'spec/workers/PRD.md');
    assert.equal(result.complete, true);
    assert.equal(result.lines[2].versionId, `spec:${before.id}`);
    assert.equal(result.lines[3].versionId, `spec:${accepted.id}`);
    assert.equal(result.origins.find((origin: any) => origin.versionId === `spec:${before.id}`).path, 'spec/workers.md');
    assert.equal(result.origins.find((origin: any) => origin.versionId === `spec:${accepted.id}`).movedFrom, 'spec/workers.md');
  } finally { context.close(); }
});

test('decision.list returns only the project decisions for read-only display', () => {
  const context = fixture('# Workers\n');
  try {
    const recorded = context.domain.call('decision.record', { projectId: context.project.id, summary: 'Keep exports local', requirements: ['R-1'], source: 'owner chat' }, owner);
    context.store.put('project', { id: 'other', name: 'Other' });
    context.store.put('decision', { id: 'decision:other', projectId: 'other', summary: 'Foreign decision' });
    const listed = context.domain.call('decision.list', { projectId: context.project.id }, guide);
    assert.deepEqual(listed.map((item: any) => item.id), [recorded.id]);
    assert.ok(context.domain.actions().some((action: any) => (action.name ?? action) === 'decision.list'));
  } finally { context.close(); }
});
