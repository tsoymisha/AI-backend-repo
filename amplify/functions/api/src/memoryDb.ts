import { randomUUID } from 'node:crypto';
import { TxConflict, type Db, type Item, type Ref, type Table, type Tx } from './db';

/**
 * In-memory Db for tests. Uses the same optimistic scheme as dynamoDb.ts
 * (a revision number per item, checked at commit), so concurrency bugs in
 * the business logic show up in tests too.
 */
export class MemoryDb implements Db {
  private store = new Map<string, { rev: number; data: Item }>();
  /** Test hook: run before each commit, e.g. to simulate a racing write. */
  beforeCommit: (() => void) | null = null;

  private key(ref: Ref) {
    return `${ref.table}/${ref.id}`;
  }

  ref(table: Table, id: string): Ref {
    return { table, id };
  }

  newId(): string {
    return randomUUID();
  }

  async get<T extends Item = Item>(ref: Ref): Promise<T | null> {
    const e = this.store.get(this.key(ref));
    return e ? (structuredClone({ id: ref.id, ...e.data }) as unknown as T) : null;
  }

  /** Test helper: write directly, bypassing transactions. */
  put(table: Table, id: string, data: Item): void {
    const k = this.key({ table, id });
    const rev = (this.store.get(k)?.rev ?? 0) + 1;
    this.store.set(k, { rev, data: structuredClone(data) });
  }

  async runTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads = new Map<string, number>(); // key -> rev seen (0 = missing)
      const writes: Array<{ ref: Ref; data: Item; mode: 'set' | 'update' }> = [];
      const tx: Tx = {
        get: async <T extends Item>(ref: Ref) => {
          if (writes.length) throw new Error('All reads must happen before writes in a transaction.');
          const k = this.key(ref);
          reads.set(k, this.store.get(k)?.rev ?? 0);
          return this.get<T>(ref);
        },
        set: (ref, data) => void writes.push({ ref, data, mode: 'set' }),
        update: (ref, data) => void writes.push({ ref, data, mode: 'update' }),
      };
      const result = await fn(tx);
      this.beforeCommit?.();
      const changed = [...reads].some(([k, rev]) => (this.store.get(k)?.rev ?? 0) !== rev);
      if (changed) continue; // lost a race: retry the whole transaction
      for (const w of writes) {
        const k = this.key(w.ref);
        const prev = this.store.get(k);
        if (w.mode === 'update' && !prev) throw new Error(`update of missing item ${k}`);
        const data = w.mode === 'set' ? structuredClone(w.data) : { ...prev!.data, ...structuredClone(w.data) };
        this.store.set(k, { rev: (prev?.rev ?? 0) + 1, data });
      }
      return result;
    }
    throw new TxConflict();
  }
}
