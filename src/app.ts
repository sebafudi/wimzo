import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, assert, hash } from './store.ts';
import { Domain } from './domain.ts';
import { Execution } from './execution.ts';
import { Review } from './review.ts';
import { Documents } from './documents.ts';
import { Feedback } from './feedback.ts';
import { Recommendations } from './recommendations.ts';
import { Board } from './board.ts';
import { Workers } from './workers.ts';
import { Workflow } from './workflow.ts';

export type Actor = { role: 'owner'|'guide'|'worker'|'system'; id: string; taskId?: string };
export type Action = { name: string; description: string; roles: string[]; inputSchema: any };
export const root = resolve(import.meta.dirname, '..');
export const defaultState = () => resolve(process.env.WIMZO_STATE_DIR ?? join(root, '.wimzo'));

export function validate(schema: any, value: any, path = 'input') {
  if (!schema) return;
  if (schema.oneOf) {
    let matches = 0;
    for (const option of schema.oneOf) {
      try { validate(option, value, path); matches++; } catch {}
    }
    assert(matches === 1, `${path} must match exactly one allowed schema`);
    return;
  }
  if (schema.type === 'object') {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
    for (const key of schema.required ?? []) assert(value[key] !== undefined, `${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert(schema.properties?.[key], `Unknown ${path}.${key}`);
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    assert(Array.isArray(value), `${path} must be an array`);
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${path} has too few items`);
    for (const item of value) validate(schema.items, item, `${path}[]`);
  } else if (schema.type === 'null') assert(value === null, `${path} must be null`);
  else if (schema.type === 'integer') assert(Number.isInteger(value), `${path} must be an integer`);
  else if (schema.type && typeof schema.type === 'string') assert(typeof value === schema.type, `${path} must be ${schema.type}`);
  if (schema.enum) assert(schema.enum.includes(value), `${path} has an invalid value`);
}

export class App {
  store: Store;
  domain: ReturnType<typeof Domain>;
  execution: ReturnType<typeof Execution>;
  review: ReturnType<typeof Review>;
  documents: ReturnType<typeof Documents>;
  feedback: ReturnType<typeof Feedback>;
  recommendations: ReturnType<typeof Recommendations>;
  board: ReturnType<typeof Board>;
  workers: ReturnType<typeof Workers>;
  workflow: ReturnType<typeof Workflow>;
  stateDir: string;
  constructor(stateDir = defaultState()) {
    this.stateDir = resolve(stateDir);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    try { if ((statSync(this.stateDir).mode & 0o777) !== 0o700) chmodSync(this.stateDir, 0o700); } catch {}
    this.store = new Store(join(this.stateDir, 'state.sqlite'));
    this.domain = Domain(this.store);
    this.execution = Execution(this.store, this.domain, this.stateDir);
    this.review = Review(this.store);
    this.documents = Documents(this.store);
    this.feedback = Feedback(this.store, this.domain, this.documents);
    this.recommendations = Recommendations(this.store, this.execution, {stateDir:this.stateDir});
    this.workflow = Workflow(this.store, this.domain, this.recommendations);
    this.execution.setWorkflowTick(() => this.workflow.call('workflow.tick', {}, { role: 'system', id: 'execution-workflow' }));
    this.board = Board(this.store, this.domain, this.execution, this.feedback, this.recommendations, this.workflow);
    this.workers = Workers(this.store, this.execution);
  }
  actions(actor: Actor): Action[] {
    return [...this.domain.actions(), ...this.execution.actions(), ...this.review.actions(), ...this.documents.actions(), ...this.feedback.actions(), ...this.recommendations.actions(), ...this.board.actions(), ...this.workers.actions(), ...this.workflow.actions()].filter((action: any) => action.roles.includes(actor.role));
  }
  async call(name: string, input: any, actor: Actor, requestId?: string): Promise<any> {
    const action = this.actions(actor).find(action => action.name === name);
    assert(action, `Action unavailable for ${actor.role}: ${name}`);
    validate(action.inputSchema, input);
    if (this.domain.actions().some((action: any) => action.name === name)) {
      return this.store.tx(() => {
        const requestKey = requestId && hash(JSON.stringify([actor,requestId]));
        const signature = hash(JSON.stringify([name,input]));
        const cached = requestKey && this.store.get('request', requestKey);
        if (cached) { assert(cached.signature === signature, 'Idempotency key reused with different input'); return cached.result; }
        const result = this.domain.call(name, input, actor);
        if (requestKey) this.store.put('request', { id: requestKey, signature, result });
        return result;
      });
    }
    if (this.review.actions().some(action => action.name === name)) return this.review.call(name, input, actor);
    if (this.documents.actions().some(action => action.name === name)) return this.documents.call(name, input, actor);
    if (this.feedback.actions().some(action => action.name === name)) return this.feedback.call(name, input, actor);
    if (this.recommendations.actions().some(action => action.name === name)) return this.recommendations.call(name, input, actor);
    if (this.board.actions().some(action => action.name === name)) return this.board.call(name, input, actor);
    if (this.workers.actions().some(action => action.name === name)) return this.workers.call(name, input, actor);
    if (this.workflow.actions().some(action => action.name === name)) return this.workflow.call(name, input, actor);
    return this.execution.call(name, input, actor);
  }
  tokens(): Record<string, Actor> {
    const file = join(this.stateDir, 'clients.json');
    if (!existsSync(file)) {
      const value: Record<string, Actor> = {};
      for (const role of ['owner','guide'] as const) value[randomBytes(32).toString('hex')] = {role,id:`local-${role}`};
      writeFileSync(file, JSON.stringify(value,null,2), { mode: 0o600 });
    }
    return JSON.parse(readFileSync(file,'utf8'));
  }
  async close() { await this.execution.close(); this.store.close(); }
}
