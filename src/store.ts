import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export type RecordValue = { id: string; rev: number; [key: string]: any };
export function id(prefix = 'r'): string { return `${prefix}_${randomUUID()}`; }
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function now(): string { return new Date().toISOString(); }
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Synchronous transactions must never contain an await or external side effect. */
export class Store {
  db: DatabaseSync;
  path: string;
  depth = 0;
  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE,project TEXT,type TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const value = fn(); assert(!(value instanceof Promise), 'Transactions must be synchronous'); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.depth--; }
  }
  get<T extends RecordValue = RecordValue>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,key) as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  require<T extends RecordValue = RecordValue>(kind: string, key: string): T { const value = this.get<T>(kind,key); assert(value, `Unknown ${kind}: ${key}`); return value; }
  list<T extends RecordValue = RecordValue>(kind: string): T[] {
    return (this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as any[]).map(row => JSON.parse(row.data));
  }
  put<T extends RecordValue = RecordValue>(kind: string, value: Omit<T,'rev'> & { rev?: number }, expected?: number): T {
    return this.tx(() => {
      const previous = this.get(kind,value.id as string);
      if (expected !== undefined) assert((previous?.rev ?? 0) === expected, `Stale ${kind} revision`);
      const next = { ...value, rev: (previous?.rev ?? 0) + 1 } as T;
      this.db.prepare('INSERT INTO records(kind,id,rev,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET rev=excluded.rev,data=excluded.data').run(kind,next.id,next.rev,JSON.stringify(next));
      return next;
    });
  }
  remove(kind: string, key: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,key); }
  event(type: string, project: string | null, data: any, key?: string): any {
    const at = now();
    const result = this.db.prepare('INSERT OR IGNORE INTO events(key,project,type,data,at) VALUES(?,?,?,?,?)').run(key ?? null,project,type,JSON.stringify(data),at);
    return { created: result.changes === 1, seq: Number(result.lastInsertRowid), type, project, data, at };
  }
  events(after = 0, project?: string): any[] {
    const rows = project ? this.db.prepare('SELECT * FROM events WHERE seq>? AND project=? ORDER BY seq LIMIT 500').all(after,project) : this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500').all(after);
    return rows.map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
  }
  watermark(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM events').get() as any).n); }
  close() { this.db.close(); }
}
