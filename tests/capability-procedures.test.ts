import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Domain } from '../src/domain.ts';
import { Execution } from '../src/execution.ts';

const owner = { role: 'owner' as const, id: 'fixture-owner' };
const guide = { role: 'guide' as const, id: 'fixture-guide' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wimzo-procedures-'));
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  writeFileSync(join(root, 'spec', 'PRD.md'), '**H-024 Capacity queue.** Approved work waits for capacity.\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const stateDir = join(root, '.state');
  const store = new Store(join(stateDir, 'state.sqlite'));
  const domain = Domain(store);
  const project = domain.call('project.register', { id: 'project_fixture', name: 'Fixture', root, purpose: 'Procedure fixture', canonicalPaths: ['spec/PRD.md'] }, owner);
  const other = mkdtempSync(join(tmpdir(), 'wimzo-procedures-other-'));
  return { root, other, stateDir, store, domain, project, execution: Execution(store, domain, stateDir) };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let value = await read();
  while (!done(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); value = await read(); }
  assert.ok(done(value), `Condition was not met before timeout: ${JSON.stringify(value)}`);
  return value;
}

const proposal = { name: 'fixture.echo', projectId: 'project_fixture', description: 'Print a fixed marker', command: process.execPath, args: ['-e', "console.log('procedure ran')"], access: 'read', sideEffects: [], timeoutMs: 30_000 };

test('a saved procedure runs through capability.run only after owner approval and within its project', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.execution.call('capability.propose', { ...proposal, name: 'node.test' }, guide), /reserved by a built-in/);
    await assert.rejects(f.execution.call('capability.propose', { ...proposal, command: 'node -e "x"' }, guide), /without shell syntax/);
    await assert.rejects(f.execution.call('capability.propose', { ...proposal, timeoutMs: 46 * 60_000 }, guide), /timeoutMs/);
    await assert.rejects(f.execution.call('capability.propose', proposal, { role: 'worker', id: 'worker', taskId: 'task' }), /cannot call capability\.propose/);
    const proposed = await f.execution.call('capability.propose', proposal, guide);
    assert.equal(proposed.status, 'proposed');
    assert.deepEqual(proposed.proposedBy.id, guide.id);
    assert.equal((await f.execution.call('capability.list', {}, owner)).some((item: any) => item.name === proposal.name), false);
    assert.equal((await f.execution.call('capability.list', { includeProposed: true }, owner)).find((item: any) => item.name === proposal.name).status, 'proposed');
    await assert.rejects(f.execution.call('capability.run', { capability: proposal.name, cwd: f.root }, owner), /not approved/);
    await assert.rejects(f.execution.call('capability.approve', { name: proposal.name, expectedRev: proposed.rev }, guide), /cannot call capability\.approve/);
    await assert.rejects(f.execution.call('capability.approve', { name: proposal.name, expectedRev: proposed.rev + 1 }, owner), /current revision/);
    const approved = await f.execution.call('capability.approve', { name: proposal.name, expectedRev: proposed.rev }, owner);
    assert.equal(approved.status, 'approved');
    const listed = (await f.execution.call('capability.list', {}, guide)).find((item: any) => item.name === proposal.name);
    assert.deepEqual({ source: listed.source, projectId: listed.projectId, access: listed.access, timeoutMs: listed.timeoutMs, fixedArgs: listed.fixedArgs }, { source: 'saved', projectId: f.project.id, access: 'read', timeoutMs: 30_000, fixedArgs: proposal.args });
    await assert.rejects(f.execution.call('capability.run', { capability: proposal.name, cwd: f.other }, owner), /outside its project/);
    await assert.rejects(f.execution.call('capability.run', { capability: proposal.name, cwd: f.root, input: { args: ['-e', 'process.exit(3)'] } }, owner), /approved arguments/);
    const run = await f.execution.call('capability.run', { capability: proposal.name, cwd: f.root }, owner);
    assert.equal(run.capability, proposal.name);
    assert.equal(run.capabilityVersion, approved.rev);
    const finished: any = await waitFor(() => f.execution.call('runtime.inspect', { runId: run.id }, owner), value => value.status === 'completed');
    assert.equal(finished.exitCode, 0);
    assert.match(readFileSync(finished.paths.stdout, 'utf8'), /procedure ran/);
    await assert.rejects(f.execution.call('capability.propose', { ...proposal, args: ['-e', 'process.exit(0)'] }, guide), /expectedRev/);
    const revised = await f.execution.call('capability.propose', { ...proposal, args: ['-e', 'process.exit(0)'], expectedRev: approved.rev }, guide);
    assert.equal(revised.status, 'proposed');
    await assert.rejects(f.execution.call('capability.run', { capability: proposal.name, cwd: f.root }, owner), /not approved/);
    assert.deepEqual(f.store.events().filter(event => event.type.startsWith('capability.')).map(event => event.type), ['capability.proposed', 'capability.approved', 'capability.proposed']);
  } finally { await f.execution.close(); f.store.close(); }
});
