import { randomUUID } from 'node:crypto';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { TxConflict, type Db, type Item, type Ref, type Table, type Tx } from './db';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * DynamoDB implementation of Db, for the Amplify-generated model tables.
 *
 * Optimistic transactions: each item carries a numeric `rev`. Every item
 * read in a transaction is re-checked at commit (ConditionCheck or a
 * condition on the write), so if another request changed it in between,
 * DynamoDB cancels the commit and we retry.
 *
 * Items are written in the shape Amplify's own resolvers use (id,
 * __typename, createdAt, updatedAt), so the kiosk app can read them
 * through the normal Amplify Data client.
 */
export class DynamoDb implements Db {
  private doc: DynamoDBDocumentClient;

  constructor(
    private tableNames: Record<Table, string>,
    client = new DynamoDBClient({})
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  ref(table: Table, id: string): Ref {
    return { table, id };
  }

  newId(): string {
    return randomUUID();
  }

  private async read(ref: Ref): Promise<Item | null> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableNames[ref.table], Key: { id: ref.id }, ConsistentRead: true })
    );
    return out.Item ?? null;
  }

  async get<T extends Item = Item>(ref: Ref): Promise<T | null> {
    return (await this.read(ref)) as T | null;
  }

  async runTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads = new Map<string, { ref: Ref; rev: number | null }>(); // rev null = item missing
      const writes: Array<{ ref: Ref; data: Item; mode: 'set' | 'update' }> = [];
      const key = (r: Ref) => `${r.table}/${r.id}`;

      const tx: Tx = {
        get: async <T extends Item>(ref: Ref) => {
          if (writes.length) throw new Error('All reads must happen before writes in a transaction.');
          const item = await this.read(ref);
          reads.set(key(ref), { ref, rev: item ? Number(item.rev ?? 0) : null });
          return item as T | null;
        },
        set: (ref, data) => void writes.push({ ref, data, mode: 'set' }),
        update: (ref, data) => void writes.push({ ref, data, mode: 'update' }),
      };

      const result = await fn(tx);
      if (writes.length === 0) return result;

      const nowIso = new Date().toISOString();
      const items: TransactItem[] = [];
      const written = new Set<string>();

      for (const w of writes) {
        const k = key(w.ref);
        if (written.has(k)) throw new Error(`Item ${k} written twice in one transaction.`);
        written.add(k);
        const seen = reads.get(k);
        // Written without reading first: a 'set' must create a new item,
        // an 'update' must target an existing one.
        const cond = seen
          ? conditionFor(seen.rev)
          : condition(w.mode === 'set' ? 'attribute_not_exists(id)' : 'attribute_exists(id)');

        if (w.mode === 'set') {
          items.push({
            Put: {
              TableName: this.tableNames[w.ref.table],
              Item: {
                ...w.data,
                id: w.ref.id,
                __typename: w.ref.table,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: (seen?.rev ?? 0) + 1,
              },
              ...cond,
            },
          });
        } else {
          const names: Record<string, string> = { '#rev': 'rev', '#updatedAt': 'updatedAt' };
          const values: Record<string, unknown> = { ':one': 1, ':zero': 0, ':updatedAt': nowIso };
          const sets = ['#updatedAt = :updatedAt', '#rev = if_not_exists(#rev, :zero) + :one'];
          Object.entries(w.data).forEach(([field, value], i) => {
            names[`#f${i}`] = field;
            values[`:v${i}`] = value === undefined ? null : value;
            sets.push(`#f${i} = :v${i}`);
          });
          items.push({
            Update: {
              TableName: this.tableNames[w.ref.table],
              Key: { id: w.ref.id },
              UpdateExpression: `SET ${sets.join(', ')}`,
              ExpressionAttributeNames: { ...names, ...cond.ExpressionAttributeNames },
              ExpressionAttributeValues: { ...values, ...cond.ExpressionAttributeValues },
              ConditionExpression: cond.ConditionExpression,
            },
          });
        }
      }

      // Items read but not written must still be unchanged at commit.
      for (const [k, seen] of reads) {
        if (written.has(k)) continue;
        items.push({
          ConditionCheck: {
            TableName: this.tableNames[seen.ref.table],
            Key: { id: seen.ref.id },
            ...conditionFor(seen.rev),
          },
        });
      }

      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        return result;
      } catch (err) {
        if (err instanceof TransactionCanceledException) continue; // lost a race: retry
        throw err;
      }
    }
    throw new TxConflict();
  }
}

interface Condition {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function condition(expr: string, names?: Record<string, string>, values?: Record<string, unknown>): Condition {
  const c: Condition = { ConditionExpression: expr };
  if (names) c.ExpressionAttributeNames = names;
  if (values) c.ExpressionAttributeValues = values;
  return c;
}

/** Condition that an item still has the revision we read (null = it was missing). */
function conditionFor(rev: number | null): Condition {
  if (rev === null) return condition('attribute_not_exists(id)');
  if (rev === 0) {
    // Exists but was never written by this Lambda (e.g. created by the seed script).
    return condition('attribute_exists(id) AND (attribute_not_exists(#crev) OR #crev = :crev)', { '#crev': 'rev' }, { ':crev': 0 });
  }
  return condition('#crev = :crev', { '#crev': 'rev' }, { ':crev': rev });
}
