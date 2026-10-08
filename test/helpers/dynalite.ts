/*
 * Test-only: a local DynamoDB (dynalite) plus a shim for TransactWriteItems,
 * which dynalite does not implement. The shim snapshots every item in the
 * transaction, applies each operation with its own ConditionExpression,
 * and restores the snapshots if any condition fails, then throws
 * TransactionCanceledException like real DynamoDB. Tests run one request
 * at a time, so this behaves like an atomic transaction.
 */

import type { AddressInfo } from 'node:net';
import {
  CreateTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactionCanceledException,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
// @ts-expect-error dynalite has no type definitions
import dynalite from 'dynalite';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Table } from '../../amplify/functions/api/src/db';

export const TABLES: Table[] = ['Store', 'Kiosk', 'KioskSecret', 'KioskAccount', 'Session', 'Order', 'Counter'];

export interface LocalDynamo {
  client: DynamoDBClient;
  tableNames: Record<Table, string>;
  /** Number of TransactWriteItems calls seen (and how many were cancelled). */
  stats: { transactions: number; cancelled: number };
  /** Hook run right before each transaction is applied (to simulate races). */
  beforeTransact: (() => Promise<void>) | null;
  close(): Promise<void>;
}

export async function startLocalDynamo(): Promise<LocalDynamo> {
  const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const config = {
    endpoint: `http://127.0.0.1:${port}`,
    region: 'local',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  const raw = new DynamoDBClient(config); // talks to dynalite directly
  const client = new DynamoDBClient(config); // given to the code under test

  const tableNames = {} as Record<Table, string>;
  for (const t of TABLES) {
    tableNames[t] = `${t}-test`;
    await raw.send(
      new CreateTableCommand({
        TableName: tableNames[t],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      })
    );
  }

  const local: LocalDynamo = {
    client,
    tableNames,
    stats: { transactions: 0, cancelled: 0 },
    beforeTransact: null,
    close: async () => {
      raw.destroy();
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  client.middlewareStack.add(
    (next, context) => async (args: any) => {
      if (context.commandName !== 'TransactWriteItemsCommand') return next(args);
      local.stats.transactions++;
      if (local.beforeTransact) await local.beforeTransact();
      await applyTransaction(raw, args.input.TransactItems, local);
      return { output: { $metadata: {} }, response: {} as any };
    },
    // 'serialize' (before the serializer): by now lib-dynamodb has converted
    // plain JS values into DynamoDB AttributeValues.
    { step: 'serialize', priority: 'high', name: 'transactShim' }
  );

  return local;
}

type Key = Record<string, AttributeValue>;

/** Convert plain JS values to AttributeValues if the SDK hasn't yet. */
function toWire(items: any[]): any[] {
  const isWire = (m: any) => m && Object.values(m).every((v: any) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1);
  const conv = (m: any) => (m == null || isWire(m) ? m : marshall(m, { removeUndefinedValues: true }));
  return items.map((op) => {
    const [kind] = Object.keys(op);
    const body = { ...op[kind] };
    if (body.Item) body.Item = conv(body.Item);
    if (body.Key) body.Key = conv(body.Key);
    if (body.ExpressionAttributeValues) body.ExpressionAttributeValues = conv(body.ExpressionAttributeValues);
    return { [kind]: body };
  });
}

async function applyTransaction(raw: DynamoDBClient, nativeItems: any[], local: LocalDynamo) {
  const items = toWire(nativeItems);
  const keyOf = (op: any): { TableName: string; Key: Key } =>
    op.Put
      ? { TableName: op.Put.TableName, Key: { id: op.Put.Item.id } }
      : { TableName: (op.Update ?? op.ConditionCheck).TableName, Key: (op.Update ?? op.ConditionCheck).Key };

  // Snapshot every touched item so we can roll back.
  const snapshots: Array<{ TableName: string; Key: Key; Item?: Record<string, AttributeValue> }> = [];
  for (const op of items) {
    const k = keyOf(op);
    const got = await raw.send(new GetItemCommand({ ...k, ConsistentRead: true }));
    snapshots.push({ ...k, Item: got.Item });
  }

  const rollback = async () => {
    for (const s of snapshots) {
      if (s.Item) await raw.send(new PutItemCommand({ TableName: s.TableName, Item: s.Item }));
      else await raw.send(new DeleteItemCommand({ TableName: s.TableName, Key: s.Key }));
    }
  };

  try {
    for (let i = 0; i < items.length; i++) {
      const op = items[i];
      if (op.Put) {
        await raw.send(new PutItemCommand(op.Put));
      } else if (op.Update) {
        await raw.send(new UpdateItemCommand(op.Update));
      } else if (op.ConditionCheck) {
        // Evaluate the condition without changing data: rewrite the item
        // as it was, guarded by the same condition.
        const snap = snapshots[i];
        const c = op.ConditionCheck;
        if (snap.Item) {
          await raw.send(
            new PutItemCommand({
              TableName: c.TableName,
              Item: snap.Item,
              ConditionExpression: c.ConditionExpression,
              ExpressionAttributeNames: c.ExpressionAttributeNames,
              ExpressionAttributeValues: c.ExpressionAttributeValues,
            })
          );
        } else if (!/attribute_not_exists\(id\)/.test(c.ConditionExpression)) {
          throw Object.assign(new Error('ConditionalCheckFailed'), { name: 'ConditionalCheckFailedException' });
        }
      } else {
        throw new Error(`Unsupported transaction item: ${Object.keys(op)}`);
      }
    }
  } catch (err: any) {
    await rollback();
    if (err.name === 'ConditionalCheckFailedException') {
      local.stats.cancelled++;
      throw new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      });
    }
    throw err; // e.g. a malformed expression: surface it so the test fails loudly
  }
}
