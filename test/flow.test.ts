/*
 * End-to-end flow tests for the business logic, run twice:
 *   1. on the in-memory Db
 *   2. on the real DynamoDb class against dynalite (local DynamoDB)
 * so both the logic and the DynamoDB expressions/conditions are exercised.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Db, Item, Table } from '../amplify/functions/api/src/db';
import { MemoryDb } from '../amplify/functions/api/src/memoryDb';
import { DynamoDb } from '../amplify/functions/api/src/dynamoDb';
import * as svc from '../amplify/functions/api/src/service';
import type { Caller } from '../amplify/functions/api/src/service';
import { CONFIG, kstDayKey } from '../amplify/functions/api/src/pure';
import { resolveCaller } from '../amplify/functions/api/handler';
import { startLocalDynamo, type LocalDynamo } from './helpers/dynalite';

const seed = JSON.parse(readFileSync(new URL('../seed/gist-cafe.json', import.meta.url), 'utf8'));
const T0 = Date.parse('2026-10-06T02:00:00Z'); // 11:00 KST

const alice: Caller = { kind: 'user', uid: 'ap-northeast-2:alice' };
const bob: Caller = { kind: 'user', uid: 'ap-northeast-2:bob' };
const otherKiosk: Caller = { kind: 'kiosk', uid: 'kiosk-sub-2', kioskId: 'XK01', storeId: 'other-store' };

const reason = (r: string) => (err: any) => {
  assert.equal(err.reason, r, `expected reason ${r}, got ${err.reason}: ${err.message}`);
  return true;
};

const AMERICANO = [{ itemId: 'americano', qty: 1, options: { temp: 'ice', size: 'large' } }];

interface Harness {
  name: string;
  setup(): Promise<{ db: Db; put(table: Table, id: string, data: Item): Promise<void>; race?: (fn: () => Promise<void>) => void }>;
  teardown?(): Promise<void>;
}

let local: LocalDynamo | null = null;

const harnesses: Harness[] = [
  {
    name: 'MemoryDb',
    async setup() {
      const db = new MemoryDb();
      return {
        db,
        put: async (t, id, data) => db.put(t, id, data),
        race: (fn) => {
          let done = false;
          db.beforeCommit = () => {
            if (!done) {
              done = true;
              // MemoryDb commit hook is sync; run the racing write synchronously.
              void fn();
            }
          };
        },
      };
    },
  },
  {
    name: 'DynamoDb (dynalite)',
    async setup() {
      local ??= await startLocalDynamo();
      // Fresh table names per test by prefixing ids is simpler than recreating tables.
      const db = new DynamoDb(local.tableNames, local.client);
      const doc = DynamoDBDocumentClient.from(local.client);
      const l = local;
      return {
        db,
        put: async (t, id, data) => {
          await doc.send(new PutCommand({ TableName: l.tableNames[t], Item: { ...data, id } }));
        },
        race: (fn) => {
          let done = false;
          l.beforeTransact = async () => {
            if (!done) {
              done = true;
              l.beforeTransact = null;
              await fn();
            }
          };
        },
      };
    },
  },
];

after(async () => {
  await local?.close();
});

for (const h of harnesses) {
  describe(h.name, () => {
    // Each test gets its own store/kiosk IDs so DynamoDB tests don't collide.
    let n = 0;
    async function world() {
      n++;
      const { db, put, race } = await h.setup();
      const kioskId = `K${String(n).padStart(3, '0')}`.slice(0, 4);
      const storeId = `${h.name.slice(0, 3)}-store-${n}`;
      await put('Store', storeId, { ...seed.store, menu: seed.menu });
      await put('Kiosk', kioskId, { storeId, name: '키오스크 1' });
      const sub = `${h.name.slice(0, 3)}-sub-${n}`;
      await put('KioskAccount', sub, { kioskId, storeId });
      const k: Caller = { kind: 'kiosk', uid: sub, kioskId, storeId };
      return { db, put, race, kioskId, storeId, k, sub };
    }

    async function connected() {
      const w = await world();
      const hb = await svc.kioskHeartbeat(w.db, w.k, {}, T0);
      const conn = await svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: hb.token }, T0 + 1000);
      return { ...w, hb, sessionId: conn.sessionId as string, conn };
    }

    test('full flow: pair over BLE token, mirror cart, order, staff updates status', async () => {
      const w = await connected();
      assert.equal(w.conn.type, 'connected');
      assert.equal(w.conn.kioskId, w.kioskId);
      assert.equal(w.conn.storeName, 'GIST 카페 (데모)');

      const cart = await svc.syncCart(w.db, alice, { sessionId: w.sessionId, items: JSON.stringify(AMERICANO) }, T0 + 2000);
      assert.equal(cart.total, 3000);
      assert.equal(cart.kioskId, w.kioskId, 'cart event reaches the kiosk subscription');

      const order = await svc.submitOrder(w.db, alice, { sessionId: w.sessionId, items: AMERICANO }, T0 + 3000);
      assert.equal(order.type, 'ordered');
      assert.equal(order.orderNumber, 1);
      assert.equal(order.total, 3000);
      assert.equal(order.summary, '아메리카노 (아이스, 라지) 1개');

      const kioskRec = await w.db.get(w.db.ref('Kiosk', w.kioskId));
      assert.equal(kioskRec!.activeSessionId, null, 'kiosk is free again after the order');

      const ev = await svc.updateOrderStatus(w.db, w.k, { orderId: order.orderId, status: 'accepted' }, T0 + 4000);
      assert.equal(ev.sessionId, w.sessionId, 'status event reaches the phone subscription');
      await svc.updateOrderStatus(w.db, w.k, { orderId: order.orderId, status: 'preparing' }, T0 + 5000);
      await svc.updateOrderStatus(w.db, w.k, { orderId: order.orderId, status: 'ready' }, T0 + 6000);

      const mine = await svc.getMyOrder(w.db, alice, { orderId: order.orderId });
      assert.equal(mine.status, 'ready');
      assert.equal(JSON.parse(mine.lines)[0].name, '아메리카노');
      await assert.rejects(svc.getMyOrder(w.db, bob, { orderId: order.orderId }), reason('order-not-found'));
    });

    test('order numbers count up per store per Korean day', async () => {
      const w = await world();
      const numbers: number[] = [];
      for (const [i, t] of [T0, T0 + 60_000, Date.parse('2026-10-06T15:00:01Z')].entries()) {
        const hb = await svc.kioskHeartbeat(w.db, w.k, {}, t + i);
        const c = await svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: hb.token }, t + i + 1);
        const o = await svc.submitOrder(w.db, alice, { sessionId: c.sessionId, items: AMERICANO }, t + i + 2);
        numbers.push(o.orderNumber as number);
      }
      assert.deepEqual(numbers, [1, 2, 1], 'resets at midnight KST');
    });

    test('a wrong or expired BLE token cannot connect (proves the phone is at the kiosk)', async () => {
      const w = await world();
      const hb = await svc.kioskHeartbeat(w.db, w.k, {}, T0);
      await assert.rejects(svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: 'ZZZZZZZZ' }, T0), reason('token-invalid'));
      await assert.rejects(
        svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: hb.token }, T0 + CONFIG.TOKEN_TTL_MS + 1),
        reason('token-invalid')
      );
      await assert.rejects(svc.connectToKiosk(w.db, alice, { kioskId: 'gk01', token: hb.token }, T0), reason('bad-kiosk-id'));
      await assert.rejects(svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: 'short' }, T0), reason('bad-token'));
    });

    test('token rotates every 30 s and the previous one still works briefly', async () => {
      const w = await world();
      const a = await svc.kioskHeartbeat(w.db, w.k, {}, T0);
      const same = await svc.kioskHeartbeat(w.db, w.k, {}, T0 + 10_000);
      assert.equal(same.token, a.token, 'no rotation within 30 s');
      const b = await svc.kioskHeartbeat(w.db, w.k, {}, T0 + CONFIG.TOKEN_REFRESH_MS);
      assert.notEqual(b.token, a.token);
      const c = await svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: a.token }, T0 + CONFIG.TOKEN_REFRESH_MS + 1);
      assert.equal(c.type, 'connected');
    });

    test('one phone at a time per kiosk; same phone reconnects; idle sessions are replaced', async () => {
      const w = await connected();
      await assert.rejects(
        svc.connectToKiosk(w.db, bob, { kioskId: w.kioskId, token: w.hb.token }, T0 + 2000),
        reason('kiosk-busy')
      );
      const again = await svc.connectToKiosk(w.db, alice, { kioskId: w.kioskId, token: w.hb.token }, T0 + 3000);
      assert.equal(again.sessionId, w.sessionId);

      const later = T0 + 3000 + CONFIG.SESSION_IDLE_MS + 1;
      const hb = await svc.kioskHeartbeat(w.db, w.k, {}, later);
      const bobConn = await svc.connectToKiosk(w.db, bob, { kioskId: w.kioskId, token: hb.token }, later + 1);
      assert.notEqual(bobConn.sessionId, w.sessionId);
      const old = await w.db.get(w.db.ref('Session', w.sessionId));
      assert.equal(old!.status, 'expired');
      await assert.rejects(
        svc.submitOrder(w.db, alice, { sessionId: w.sessionId, items: AMERICANO }, later + 2),
        reason('session-expired')
      );
    });

    test('help request reaches the kiosk and staff can resolve it', async () => {
      const w = await connected();
      const help = await svc.requestHelp(w.db, alice, { sessionId: w.sessionId }, T0 + 2000);
      assert.equal(help.kioskId, w.kioskId);
      assert.equal((await w.db.get(w.db.ref('Session', w.sessionId)))!.helpRequested, true);
      const res = await svc.resolveHelp(w.db, w.k, { sessionId: w.sessionId }, T0 + 3000);
      assert.equal(res.sessionId, w.sessionId);
      assert.equal((await w.db.get(w.db.ref('Session', w.sessionId)))!.helpRequested, false);
      await assert.rejects(svc.resolveHelp(w.db, otherKiosk, { sessionId: w.sessionId }, T0), reason('session-not-found'));
    });

    test('either side can end the session, freeing the kiosk', async () => {
      const w = await connected();
      await assert.rejects(svc.endSession(w.db, bob, { sessionId: w.sessionId }, T0 + 2000), reason('not-your-session'));
      const ev = await svc.endSession(w.db, w.k, { sessionId: w.sessionId }, T0 + 2000);
      assert.equal(ev.status, 'ended');
      assert.equal((await w.db.get(w.db.ref('Kiosk', w.kioskId)))!.activeSessionId, null);
      await assert.rejects(svc.syncCart(w.db, alice, { sessionId: w.sessionId, items: [] }, T0 + 3000), reason('session-expired'));
    });

    test('customers can cancel only before staff accepts; staff of another store cannot touch orders', async () => {
      const w = await connected();
      const o1 = await svc.submitOrder(w.db, alice, { sessionId: w.sessionId, items: AMERICANO }, T0 + 2000);
      await assert.rejects(svc.cancelMyOrder(w.db, bob, { orderId: o1.orderId }, T0), reason('order-not-found'));
      await assert.rejects(
        svc.updateOrderStatus(w.db, otherKiosk, { orderId: o1.orderId, status: 'accepted' }, T0),
        reason('order-not-found')
      );
      const c = await svc.cancelMyOrder(w.db, alice, { orderId: o1.orderId }, T0 + 3000);
      assert.equal(c.status, 'cancelled');
      await assert.rejects(
        svc.updateOrderStatus(w.db, w.k, { orderId: o1.orderId, status: 'accepted' }, T0 + 4000),
        reason('bad-transition')
      );
    });

    test('roles are enforced', async () => {
      const w = await connected();
      await assert.rejects(svc.kioskHeartbeat(w.db, alice, {}, T0), reason('not-kiosk'));
      await assert.rejects(svc.connectToKiosk(w.db, w.k, { kioskId: w.kioskId, token: w.hb.token }, T0), reason('kiosk-not-allowed'));
      await assert.rejects(svc.connectToKiosk(w.db, null, { kioskId: w.kioskId, token: w.hb.token }, T0), reason('not-signed-in'));
      await assert.rejects(svc.submitOrder(w.db, bob, { sessionId: w.sessionId, items: AMERICANO }, T0 + 2000), reason('not-your-session'));
      await assert.rejects(
        svc.submitOrder(w.db, alice, { sessionId: w.sessionId, items: AMERICANO, paymentMethod: 'bitcoin' }, T0),
        reason('bad-payment-method')
      );
    });

    test('subscriptions: phones only to their own session, kiosks only to themselves', async () => {
      const w = await connected();
      assert.equal(await svc.subscribeSession(w.db, alice, { sessionId: w.sessionId }), null);
      await assert.rejects(svc.subscribeSession(w.db, bob, { sessionId: w.sessionId }), reason('session-not-found'));
      assert.equal(await svc.subscribeKiosk(w.db, w.k, { kioskId: w.kioskId }), null);
      await assert.rejects(svc.subscribeKiosk(w.db, w.k, { kioskId: 'ZZ99' }), reason('not-your-kiosk'));
      await assert.rejects(svc.subscribeKiosk(w.db, alice, { kioskId: w.kioskId }), reason('not-kiosk'));
    });

    test('a racing order at commit time is retried and still gets a unique number', async () => {
      const w = await connected();
      // Another order lands between our read of the counter and our commit.
      w.race?.(async () => {
        await w.put('Counter', `${w.storeId}#${kstDayKey(T0)}`, { count: 7, rev: 99 });
      });
      const o = await svc.submitOrder(w.db, alice, { sessionId: w.sessionId, items: AMERICANO }, T0 + 2000);
      assert.equal(o.orderNumber, 8, 'saw the racing write and retried');
    });

    test('resolveCaller maps AppSync identities to callers', async () => {
      const w = await world();
      assert.deepEqual(await resolveCaller({ cognitoIdentityId: 'ap-northeast-2:x' }, w.db), { kind: 'user', uid: 'ap-northeast-2:x' });
      assert.deepEqual(await resolveCaller({ sub: 'admin-1', groups: ['admins'] }, w.db), { kind: 'user', uid: 'admin-1' });
      const k = await resolveCaller({ sub: w.sub, groups: ['kiosks'] }, w.db);
      assert.deepEqual(k, { kind: 'kiosk', uid: w.sub, kioskId: w.kioskId, storeId: w.storeId });
      await assert.rejects(resolveCaller({ sub: 'unlinked', groups: ['kiosks'] }, w.db), reason('kiosk-not-linked'));
      assert.equal(await resolveCaller(null, w.db), null);
    });
  });
}

