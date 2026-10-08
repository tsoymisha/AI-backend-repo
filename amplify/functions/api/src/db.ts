/*
 * A tiny transactional database interface. The business logic uses only
 * this, so it runs unchanged on DynamoDB (dynamoDb.ts) and on the
 * in-memory version used by the tests (memoryDb.ts).
 *
 * Transactions are optimistic: every item read inside a transaction is
 * checked again at commit time, and the whole transaction retries if
 * anything changed in between. This gives the same guarantees the logic
 * needs (unique order numbers, one phone per kiosk) on both backends.
 */

export type Table = 'Store' | 'Kiosk' | 'KioskSecret' | 'KioskAccount' | 'Session' | 'Order' | 'Counter';

export type Item = Record<string, unknown>;

export interface Ref {
  table: Table;
  id: string;
}

export interface Tx {
  /** Read an item (null if missing). All reads must happen before writes. */
  get<T extends Item = Item>(ref: Ref): Promise<T | null>;
  /** Create or replace an item. */
  set(ref: Ref, data: Item): void;
  /** Change some fields of an existing item. */
  update(ref: Ref, data: Item): void;
}

export interface Db {
  ref(table: Table, id: string): Ref;
  newId(): string;
  get<T extends Item = Item>(ref: Ref): Promise<T | null>;
  runTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}

/** Thrown by a backend when a transaction lost a race; runTransaction retries. */
export class TxConflict extends Error {
  constructor() {
    super('Transaction conflict');
  }
}
