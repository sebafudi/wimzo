import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Models, validateExecutionPolicy } from '../src/models.ts';
import { claudeModels } from '../src/claude-profile.ts';

function fixture() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wimzo-models-')), 'state.sqlite'));
  store.put('project', { id: 'one', name: 'One', root: '/one', purpose: 'One', canonicalPaths: [] });
  store.put('project', { id: 'two', name: 'Two', root: '/two', purpose: 'Two', canonicalPaths: [] });
  const models = Models(store);
  models.sync([{ name: 'codex', models: [{ id: 'gpt-one', description: 'First verified local model.' }, { id: 'gpt-two', description: 'Second verified local model.' }] }]);
  return { store, models };
}

test('an explicit empty worker allowlist denies every route', () => {
  const { store, models } = fixture();
  models.setWorkerPolicy('one', { providers: [] }, 0);
  assert.throws(() => validateExecutionPolicy(store, 'one', { harness: 'codex', provider: 'openai', model: 'gpt-one', authRoute: 'subscription' }), /denies provider/);
  store.close();
});

test('project allowlists cannot enable a paid coding API route', () => {
  const { store, models } = fixture();
  models.setWorkerPolicy('one', { harnesses: ['codex'], providers: ['openai'], authRoutes: ['api-key'] }, 0);
  assert.throws(
    () => validateExecutionPolicy(store, 'one', { harness: 'codex', provider: 'openai', model: 'gpt-one', authRoute: 'api-key' }),
    /Paid coding API authentication routes are not permitted/,
  );
  store.close();
});

test('worker policies isolate model choices between projects', () => {
  const { store, models } = fixture();
  models.setWorkerPolicy('one', { models: ['gpt-one'] }, 0);
  models.setWorkerPolicy('two', { models: ['gpt-two'] }, 0);
  assert.doesNotThrow(() => validateExecutionPolicy(store, 'one', { harness: 'codex', provider: 'openai', model: 'gpt-one', authRoute: 'subscription' }));
  assert.throws(() => validateExecutionPolicy(store, 'one', { harness: 'codex', provider: 'openai', model: 'gpt-two', authRoute: 'subscription' }), /denies model/);
  assert.doesNotThrow(() => validateExecutionPolicy(store, 'two', { harness: 'codex', provider: 'openai', model: 'gpt-two', authRoute: 'subscription' }));
  store.close();
});

test('model descriptions require source and an exact revision', () => {
  const { store, models } = fixture();
  const before = models.find('openai', 'gpt-one')!;
  const edited = models.describe({ provider: 'openai', model: 'gpt-one', description: 'Use for focused implementation after planning.', source: 'owner preference', expectedRev: before.rev });
  assert.equal(edited.description, 'Use for focused implementation after planning.');
  assert.equal(edited.source, 'owner preference');
  assert.throws(() => models.describe({ provider: 'openai', model: 'gpt-one', description: 'Stale write.', source: 'owner preference', expectedRev: before.rev }), /Stale worker_model revision/);
  store.close();
});

test('newly discovered models receive concise editable role descriptions without replacing an owner edit', () => {
  const { store, models } = fixture();
  models.sync([{ name: 'pi', provider: 'openai', authRoute: 'subscription', models: [{ id: 'gpt-5.6-luna' }] }]);
  const discovered = models.find('openai', 'gpt-5.6-luna')!;
  assert.match(discovered.description, /^Older GPT-5\.6 generation\. Fast, affordable model for small edits.*Prefer the GPT-6 model with the same role/);
  assert.equal(discovered.source, 'runtime-capability:pi');
  const edited = models.describe({ provider: 'openai', model: 'gpt-5.6-luna', description: 'Use for the owner-approved fast verification role.', source: 'owner preference', expectedRev: discovered.rev });
  models.sync([{ name: 'pi', provider: 'openai', authRoute: 'subscription', models: [{ id: 'gpt-5.6-luna', description: 'Different runtime metadata.' }] }]);
  assert.equal(models.find('openai', 'gpt-5.6-luna')!.description, edited.description);
  assert.equal(models.find('openai', 'gpt-5.6-luna')!.source, 'owner preference');
  store.close();
});

test('discovered defaults distinguish GPT-6 from GPT-5.6 roles and describe Claude families', () => {
  const { store, models } = fixture();
  models.sync([{ name: 'codex', provider: 'openai', authRoute: 'subscription', models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-console'] }, { name: 'claude', provider: 'anthropic', authRoute: 'subscription', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] }]);
  const description = (provider: string, id: string) => models.find(provider, id)!.description;
  assert.match(description('openai', 'gpt-6-sol'), /^GPT-6 generation, stronger than the GPT-5\.6 model with the same role\. Workhorse for routine implementation/);
  assert.match(description('openai', 'gpt-6-luna'), /^GPT-6 generation.*Fast, affordable model/);
  assert.match(description('openai', 'gpt-6-astra'), /^GPT-6 generation.*Frontier model/);
  assert.match(description('openai', 'gpt-5.6-sol'), /^Older GPT-5\.6 generation\. Workhorse.*Prefer the GPT-6 model/);
  assert.match(description('openai', 'gpt-5.6-terra'), /^Older GPT-5\.6 generation\. Balanced model/);
  assert.match(description('openai', 'gpt-console'), /not yet described/);
  assert.match(description('anthropic', 'claude-opus-5-5'), /^Claude model for difficult planning, architecture and judgment-heavy review/);
  assert.match(description('anthropic', 'claude-sonnet-5'), /^Claude model for routine implementation/);
  assert.match(description('anthropic', 'claude-haiku-4-5-20251001'), /^Claude model for fast, low-cost/);
  store.close();
});

test('syncing the claude runtime capability publishes its Claude models with provider and authRoute for editing', () => {
  const { store, models } = fixture();
  models.sync([{ name: 'claude', provider: 'anthropic', authRoute: 'subscription', models: claudeModels() }]);
  const ids = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  for (const id of ids) {
    const record = models.find('anthropic', id)!;
    assert.ok(record, `expected ${id} to sync into worker_model`);
    assert.equal(record.provider, 'anthropic');
    assert.deepEqual(record.authRoutes, ['subscription']);
    assert.ok(record.description.length > 0);
  }
  const opus = models.find('anthropic', 'claude-opus-5-5')!;
  const edited = models.describe({ provider: 'anthropic', model: 'claude-opus-5-5', description: 'Use for owner-approved architecture review.', source: 'owner preference', expectedRev: opus.rev });
  assert.equal(edited.description, 'Use for owner-approved architecture review.');
  store.close();
});

test('re-syncing the claude runtime capability does not overwrite an owner-edited Claude model description', () => {
  const { store, models } = fixture();
  models.sync([{ name: 'claude', provider: 'anthropic', authRoute: 'subscription', models: claudeModels() }]);
  const before = models.find('anthropic', 'claude-sonnet-5')!;
  const edited = models.describe({ provider: 'anthropic', model: 'claude-sonnet-5', description: 'Owner-approved routine implementation role.', source: 'owner preference', expectedRev: before.rev });
  models.sync([{ name: 'claude', provider: 'anthropic', authRoute: 'subscription', models: claudeModels() }]);
  assert.equal(models.find('anthropic', 'claude-sonnet-5')!.description, edited.description);
  assert.equal(models.find('anthropic', 'claude-sonnet-5')!.source, 'owner preference');
  store.close();
});

test('worker policy changes record the author and policy reads surface it', () => {
  const { store, models } = fixture();
  assert.equal(models.getWorkerPolicy('one').updatedBy, null);
  models.setWorkerPolicy('one', { models: ['gpt-one'] }, 0, { id: 'owner-chat', role: 'owner' });
  const read = models.getWorkerPolicy('one');
  assert.deepEqual(read.updatedBy, { id: 'owner-chat', role: 'owner' });
  assert.equal(read.revision, 1);
  assert.ok(read.updatedAt);
  store.close();
});

test('discovery facts stay separate from editable fields and missing models become unavailable', () => {
  const { store, models } = fixture();
  models.sync([{ name: 'codex', models: [{ id: 'gpt-one', reasoningEfforts: [{ effort: 'low' }, 'high'], contextWindow: 200000 }, 'gpt-two'] }]);
  const edited = models.describe({ provider: 'openai', model: 'gpt-two', description: 'Owner description kept after discovery loss.', source: 'owner', expectedRev: models.find('openai', 'gpt-two')!.rev });
  const listed = Object.fromEntries(models.list().map(record => [record.id, record]));
  assert.deepEqual({ ...listed['openai:gpt-one'].discovery, lastSeen: undefined }, { available: true, thinkingLevels: ['low', 'high'], contextWindow: 200000, lastSeen: undefined });
  assert.equal(listed['openai:gpt-two'].discovery!.thinkingLevels, null);
  const seen = listed['openai:gpt-one'].discovery!.lastSeen;
  models.sync([{ name: 'codex', models: ['gpt-one'] }]);
  const after = Object.fromEntries(models.list().map(record => [record.id, record]));
  assert.equal(after['openai:gpt-two'].discovery!.available, false);
  assert.ok(after['openai:gpt-two'].discovery!.lastSeen);
  assert.equal(after['openai:gpt-two'].description, 'Owner description kept after discovery loss.');
  assert.equal(after['openai:gpt-two'].rev, edited.rev);
  assert.equal(after['openai:gpt-one'].rev, listed['openai:gpt-one'].rev);
  assert.ok(seen);
  store.close();
});
