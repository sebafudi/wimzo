import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Recommendations, externalRecommendationConfiguration } from '../src/recommendations.ts';

function fixture(models: any[] = [], piModels: any[] = []) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wimzo-recommendations-')), 'state.sqlite'));
  store.put('project', { id: 'fixture', name: 'Fixture', root: '/fixture', purpose: 'Fixture', canonicalPaths: [] });
  let calls = 0;
  let catalog = models;
  const execution = { call: async () => [
    { name: 'codex', provider: 'openai', authRoute: 'subscription', available: true, eligible: true, installedVersion: 'fixture', models: catalog },
    ...(piModels.length ? [{ name: 'pi', provider: 'openai', authRoute: 'subscription', available: true, eligible: true, installedVersion: 'pi-fixture', models: piModels }] : []),
  ] };
  const fetch = async (_url: string, init: RequestInit) => {
    calls++;
    const request: any = JSON.parse(String(init.body));
    assert.equal(request.model, 'jev-latest');
    assert.equal(request.questions.worker_profile.type, 'choice');
    assert.ok(request.questions.worker_profile.criteria.manual);
    return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 12, output_tokens: 3 }, answers: { worker_profile: { type: 'choice', choice: Object.keys(request.questions.worker_profile.criteria).find(key => key.startsWith('codex:')) ?? 'codex-default', confidence: 0.9 } } }), { status: 200 });
  };
  return { store, execution, fetch, calls: () => calls, setCatalog: (value: any[]) => { catalog = value; } };
}

const input = { projectId: 'fixture', subject: 'Implement one bounded requirement', scope: 'Fixture only', criteria: ['Tests pass'], requirements: ['H-044'], permissions: ['workspace-write'] };

test('worker options expose only complete local profiles and a safe Codex default', async () => {
  const f = fixture();
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  const options = await recommendations.options();
  assert.deepEqual(options.profiles.map(profile => profile.id), ['codex-default']);
  const validated = await recommendations.validateProfile('codex-default', ['workspace-write']);
  assert.equal(validated.dispatchRuntime, 'codex-profile');
  assert.equal(validated.model, undefined);
  f.store.close();
});

test('Jev result is cached by exact bounded request and catalog, with one in-flight request', async () => {
  const f = fixture([{ id: 'gpt-fixture', reasoningEfforts: ['low', 'high'] }]);
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  const [one, two] = await Promise.all([recommendations.recommend(input), recommendations.recommend(input)]);
  assert.equal(one.source, 'jev');
  assert.equal(one.profile.id, 'codex:gpt-fixture:low');
  assert.equal(two.fingerprint, one.fingerprint);
  assert.equal(f.calls(), 1);
  await recommendations.recommend(input);
  assert.equal(f.calls(), 1);
  f.setCatalog([{ id: 'gpt-fixture', reasoningEfforts: ['high'] }]);
  const stale = await recommendations.recommend(input);
  assert.equal(stale.profile.id, 'codex:gpt-fixture:high');
  assert.equal(f.calls(), 2);
  f.store.close();
});

test('service failure returns and caches a sanitized manual choice without retrying', async () => {
  const f = fixture([{ id: 'gpt-fixture', reasoningEfforts: ['low'] }]);
  const fetch = async () => { throw new Error('Bearer super-secret connection refused'); };
  const recommendations = Recommendations(f.store, f.execution, { fetch: fetch as any, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  const first = await recommendations.recommend(input);
  const second = await recommendations.recommend(input);
  assert.equal(first.source, 'manual');
  assert.equal(second.fingerprint, first.fingerprint);
  assert.doesNotMatch(first.reason, /super-secret/);
  f.store.close();
});

test('an edited model description changes the recommendation cache and an unknown project makes no inference request', async () => {
  const f = fixture([{ id: 'gpt-fixture', reasoningEfforts: ['low'] }]);
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  await assert.rejects(() => recommendations.recommend({ ...input, projectId: 'missing' }), /Unknown project/);
  assert.equal(f.calls(), 0);
  await recommendations.recommend(input);
  assert.equal(f.calls(), 1);
  const before = recommendations.models.find('openai', 'gpt-fixture')!;
  recommendations.models.describe({ provider: 'openai', model: 'gpt-fixture', description: 'Use this local model for bounded implementation after a plan.', source: 'owner preference', expectedRev: before.rev });
  await recommendations.recommend(input);
  assert.equal(f.calls(), 2);
  f.store.close();
});

test('editing a model outside the project policy keeps the cached recommendation', async () => {
  const f = fixture([{ id: 'gpt-one', reasoningEfforts: ['low'] }, { id: 'gpt-two', reasoningEfforts: ['low'] }]);
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  recommendations.models.setWorkerPolicy('fixture', { models: ['gpt-one'] }, 0);
  const first = await recommendations.recommend(input);
  assert.equal(f.calls(), 1);
  const outside = recommendations.models.find('openai', 'gpt-two')!;
  recommendations.models.describe({ provider: 'openai', model: 'gpt-two', description: 'Edited outside the permitted set.', source: 'owner preference', expectedRev: outside.rev });
  assert.equal((await recommendations.recommend(input)).fingerprint, first.fingerprint);
  assert.equal(f.calls(), 1);
  const inside = recommendations.models.find('openai', 'gpt-one')!;
  recommendations.models.describe({ provider: 'openai', model: 'gpt-one', description: 'Edited inside the permitted set.', source: 'owner preference', expectedRev: inside.rev });
  await recommendations.recommend(input);
  assert.equal(f.calls(), 2);
  f.store.close();
});

test('a guide may edit a model description only with a recorded request and a worker is refused', async () => {
  const f = fixture([{ id: 'gpt-one', reasoningEfforts: ['low'] }]);
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: {} });
  await recommendations.call('models.list', {}, { role: 'guide', id: 'guide' });
  const record = recommendations.models.find('openai', 'gpt-one')!;
  const edit = { provider: 'openai', model: 'gpt-one', description: 'Guide edit requested by the owner.', source: 'guide', expectedRev: record.rev };
  await assert.rejects(() => recommendations.call('model.describe', edit, { role: 'guide', id: 'guide' }), /requestedBy/);
  await assert.rejects(() => recommendations.call('model.describe', { ...edit, requestedBy: 'owner asked' }, { role: 'worker', id: 'worker', taskId: 'task' }), /cannot call model\.describe/);
  const updated: any = await recommendations.call('model.describe', { ...edit, requestedBy: 'Owner chat: describe gpt-one as a planning model' }, { role: 'guide', id: 'guide-session' });
  assert.deepEqual({ id: updated.updatedBy.id, role: updated.updatedBy.role, requestedBy: updated.updatedBy.requestedBy }, { id: 'guide-session', role: 'guide', requestedBy: 'Owner chat: describe gpt-one as a planning model' });
  const event = f.store.events(0).find((item: any) => item.type === 'model.description.updated');
  assert.deepEqual({ actor: event.data.actor, requestedBy: event.data.requestedBy }, { actor: { id: 'guide-session', role: 'guide' }, requestedBy: 'Owner chat: describe gpt-one as a planning model' });
  f.store.close();
});

test('project policy filters options and rejects a selected profile outside its allowlist', async () => {
  const f = fixture([{ id: 'gpt-one', reasoningEfforts: ['low'] }, { id: 'gpt-two', reasoningEfforts: ['low'] }]);
  f.store.put('project', { id: 'other', name: 'Other', root: '/other', purpose: 'Other', canonicalPaths: [] });
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  recommendations.models.setWorkerPolicy('fixture', { models: ['gpt-one'] }, 0);
  recommendations.models.setWorkerPolicy('other', { models: ['gpt-two'] }, 0);
  assert.deepEqual((await recommendations.options('fixture')).profiles.map(profile => profile.model), ['gpt-one']);
  assert.deepEqual((await recommendations.options('other')).profiles.map(profile => profile.model), ['gpt-two']);
  await assert.rejects(() => recommendations.validateProfile('codex:gpt-two:low', [], 'fixture'), /not supported|denies model/);
  f.store.close();
});

test('Pi profiles come only from the execution capability catalog and retain model context and thinking', async () => {
  const f = fixture([], [{ id: 'gpt-pi-fixture', provider: 'openai-codex', contextWindow: 128_000, reasoningEfforts: [{ effort: 'low', description: 'Focused bounded work.' }, { effort: 'high', description: 'Complex verification.' }] }]);
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  recommendations.models.setWorkerPolicy('fixture', { providers: ['openai'], authRoutes: ['subscription'], harnesses: ['codex', 'pi'] }, 0);
  const options = await recommendations.options('fixture');
  assert.deepEqual(options.profiles.filter(profile => profile.runtime === 'pi').map(profile => profile.id), ['pi:openai:gpt-pi-fixture:low', 'pi:openai:gpt-pi-fixture:high']);
  const profile = await recommendations.validateProfile('pi:openai:gpt-pi-fixture:high', [], 'fixture');
  assert.equal(profile.dispatchRuntime, 'pi-profile');
  assert.equal(profile.contextWindow, 128_000);
  assert.equal(options.catalog.runtimes.pi.models[0].id, 'gpt-pi-fixture');
  f.store.close();
});

test('an oversized current catalog requires manual selection without sending a partial inference request', async () => {
  const f = fixture(Array.from({ length: 24 }, (_, index) => ({ id: `gpt-fixture-${index}`, reasoningEfforts: ['low', 'medium', 'high'] })));
  const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  const result = await recommendations.recommend(input);
  assert.equal(result.source, 'manual');
  assert.match(result.reason, /catalog is too large/);
  assert.equal(f.calls(), 0);
  f.store.close();
});

test('Jev recommendations offer only policy-permitted profiles and a returned disallowed profile falls back to manual selection', async () => {
  const f = fixture([{ id: 'gpt-one', reasoningEfforts: ['low'] }, { id: 'gpt-two', reasoningEfforts: ['low'] }]);
  const offered: string[][] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const criteria = Object.keys(JSON.parse(String(init.body)).questions.worker_profile.criteria);
    offered.push(criteria);
    return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 12, output_tokens: 3 }, answers: { worker_profile: { type: 'choice', choice: 'codex:gpt-two:low', confidence: 0.9 } } }), { status: 200 });
  };
  const recommendations = Recommendations(f.store, f.execution, { fetch: fetch as any, env: { TYPESAFE_API_KEY: 'test-key', WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' } });
  recommendations.models.setWorkerPolicy('fixture', { models: ['gpt-one'] }, 0);
  const result = await recommendations.recommend(input);
  assert.equal(offered.length, 1);
  assert.ok(offered[0].includes('codex:gpt-one:low'));
  assert.ok(!offered[0].some(key => key.includes('gpt-two')));
  assert.equal(result.source, 'manual');
  assert.notEqual(result.profile?.model, 'gpt-two');
  f.store.close();
});

test('external recommendations require exact opt-in even with a key and cached external results', async () => {
  const f = fixture();
  try {
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: 'test-key' };
    const recommendations = Recommendations(f.store, f.execution, { fetch: f.fetch, env });
    for (const value of [undefined, '', '0', 'true']) {
      if (value === undefined) delete env.WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS;
      else env.WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS = value;
      assert.equal((await recommendations.recommend(input)).source, 'manual');
      assert.equal(f.calls(), 0);
      assert.deepEqual(externalRecommendationConfiguration(env), { provider: 'typesafe', optedIn: false, keyConfigured: true, enabled: false });
    }
    env.WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS = '1';
    assert.equal((await recommendations.recommend(input)).source, 'jev');
    assert.equal(f.calls(), 1);
    assert.equal(externalRecommendationConfiguration(env).enabled, true);
    delete env.WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS;
    assert.equal((await recommendations.recommend(input)).source, 'manual');
    assert.equal(f.calls(), 1);
    assert.deepEqual(externalRecommendationConfiguration({ WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS: '1' }), { provider: 'typesafe', optedIn: true, keyConfigured: false, enabled: false });
  } finally { f.store.close(); }
});
