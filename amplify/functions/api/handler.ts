import type { AppSyncResolverEvent } from 'aws-lambda';
import { AppError } from './src/errors';
import type { Db, Table } from './src/db';
import { DynamoDb } from './src/dynamoDb';
import * as service from './src/service';
import type { Caller } from './src/service';

/*
 * One Lambda for every custom query/mutation in amplify/data/resource.ts.
 * It works out who is calling, then hands off to src/service.ts.
 */

const TABLES: Table[] = ['Store', 'Kiosk', 'KioskSecret', 'KioskAccount', 'Session', 'Order', 'Counter'];

let db: Db | null = null;
function getDb(): Db {
  if (!db) {
    const names = {} as Record<Table, string>;
    for (const t of TABLES) {
      const name = process.env[`TABLE_${t.toUpperCase()}`];
      if (!name) throw new Error(`Missing env TABLE_${t.toUpperCase()}`);
      names[t] = name;
    }
    db = new DynamoDb(names);
  }
  return db;
}

type Operation = (db: Db, who: Caller, args: any, now: number) => Promise<unknown>;

const OPERATIONS: Record<string, Operation> = {
  kioskHeartbeat: service.kioskHeartbeat,
  resolveHelp: service.resolveHelp,
  updateOrderStatus: service.updateOrderStatus,
  connectToKiosk: service.connectToKiosk,
  syncCart: service.syncCart,
  submitOrder: service.submitOrder,
  requestHelp: service.requestHelp,
  cancelMyOrder: service.cancelMyOrder,
  getMyOrder: service.getMyOrder,
  endSession: service.endSession,
  // Subscriptions: run once when an app subscribes; returning null allows it.
  onKioskEvent: service.subscribeKiosk,
  onSessionEvent: service.subscribeSession,
};

// Kiosk login -> kiosk ID lookups, cached per Lambda container for 5 min.
const kioskCache = new Map<string, { at: number; kioskId: string; storeId: string }>();

/** Turn AppSync's identity into a Caller. Exported for tests. */
export async function resolveCaller(identity: any, database: Db, now = Date.now()): Promise<Caller> {
  if (!identity) return null;

  // Phone: Cognito guest identity via IAM (identity pool).
  if (typeof identity.cognitoIdentityId === 'string') {
    return { kind: 'user', uid: identity.cognitoIdentityId };
  }

  // Signed-in Cognito user (kiosk tablets, team admins).
  if (typeof identity.sub === 'string') {
    const groups: string[] = identity.groups ?? identity.claims?.['cognito:groups'] ?? [];
    if (!groups.includes('kiosks')) return { kind: 'user', uid: identity.sub };

    const cached = kioskCache.get(identity.sub);
    if (cached && now - cached.at < 5 * 60_000) {
      return { kind: 'kiosk', uid: identity.sub, kioskId: cached.kioskId, storeId: cached.storeId };
    }
    const account = await database.get<{ kioskId: string; storeId: string }>(database.ref('KioskAccount', identity.sub));
    if (!account) throw new AppError('kiosk-not-linked', 'This kiosk login is not linked to a kiosk. Run scripts/createKiosk.ts.');
    kioskCache.set(identity.sub, { at: now, kioskId: account.kioskId, storeId: account.storeId });
    return { kind: 'kiosk', uid: identity.sub, kioskId: account.kioskId, storeId: account.storeId };
  }
  return null;
}

export const handler = async (event: AppSyncResolverEvent<Record<string, unknown>>) => {
  const field = event.info.fieldName;
  const operation = OPERATIONS[field];
  if (!operation) throw new Error(`No handler for ${field}`);

  try {
    const database = getDb();
    const who = await resolveCaller(event.identity, database);
    return await operation(database, who, event.arguments, Date.now());
  } catch (err) {
    if (err instanceof AppError) throw err; // reaches the app as errorType = reason
    console.error(`${field} failed`, err);
    const internal = new Error('Something went wrong. Please try again.');
    internal.name = 'internal';
    throw internal;
  }
};
