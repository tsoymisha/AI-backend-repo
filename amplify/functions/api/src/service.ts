/*
 * Business logic for Linkage Lab. Each operation takes:
 *   db    - the transactional database (DynamoDB in production)
 *   who   - the resolved caller: a phone user, a kiosk, or nobody
 *   args  - the request arguments from the app
 *   now   - current time in ms (injected so tests control time)
 * and returns the GraphQL result. Most return a LinkEvent, which AppSync
 * also pushes to the kiosk/phone subscriptions in real time.
 */

import { AppError } from './errors';
import type { Db, Ref, Tx } from './db';
import {
  CONFIG,
  STATUS_TIME_FIELD,
  assertKioskId,
  assertToken,
  assertTransition,
  buildOrderLines,
  generateToken,
  kstDayKey,
  parseJson,
  summarizeOrder,
  tokenMatches,
  type KioskSecret,
} from './pure';

// ---------- callers ----------

export type Caller =
  | { kind: 'user'; uid: string }
  | { kind: 'kiosk'; uid: string; kioskId: string; storeId: string }
  | null;

function requireUser(who: Caller): string {
  if (!who) throw new AppError('not-signed-in', 'Please sign in first.');
  if (who.kind !== 'user') throw new AppError('kiosk-not-allowed', 'Kiosk accounts cannot do this.');
  return who.uid;
}

function requireKiosk(who: Caller): { kioskId: string; storeId: string } {
  if (!who || who.kind !== 'kiosk') throw new AppError('not-kiosk', 'Only a kiosk account can do this.');
  return { kioskId: who.kioskId, storeId: who.storeId };
}

function asId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new AppError('bad-request', `${name} is missing or invalid.`);
  }
  return value;
}

// ---------- record shapes ----------

interface Store { name?: string; menu?: unknown }
interface Kiosk { storeId: string; name?: string; activeSessionId?: string | null }
interface Session {
  id: string;
  kioskId: string;
  storeId: string;
  userId: string;
  status: string;
  lastActiveAtMs: number;
  helpRequested?: boolean;
  orderId?: string | null;
}
interface Order {
  id: string;
  storeId: string;
  kioskId: string;
  sessionId: string;
  userId: string;
  orderNumber: number;
  status: string;
  total: number;
  summary?: string;
  lines?: unknown;
  paymentMethod?: string;
  createdAtMs?: number;
}

export interface LinkEvent {
  type: string;
  kioskId: string;
  sessionId?: string | null;
  storeId?: string | null;
  kioskName?: string | null;
  storeName?: string | null;
  orderId?: string | null;
  orderNumber?: number | null;
  total?: number | null;
  summary?: string | null;
  status?: string | null;
  atMs: number;
}

const isIdle = (s: Session, now: number) => s.lastActiveAtMs + CONFIG.SESSION_IDLE_MS <= now;

/** Read a session in a transaction; check the caller owns it and it is live. */
async function getOwnActiveSession(tx: Tx, db: Db, uid: string, sessionId: string, now: number) {
  const ref = db.ref('Session', sessionId);
  const session = await tx.get<Session & Record<string, unknown>>(ref);
  if (!session) throw new AppError('session-not-found', 'Connection not found. Please reconnect to the kiosk.');
  if (session.userId !== uid) throw new AppError('not-your-session', 'This connection belongs to someone else.');
  if (session.status !== 'active' || isIdle(session, now)) {
    throw new AppError('session-expired', 'The connection ended. Please reconnect to the kiosk.');
  }
  return { ref, session };
}

async function loadMenu(db: Db, storeId: string): Promise<unknown> {
  const store = await db.get<Store & Record<string, unknown>>(db.ref('Store', storeId));
  if (!store) throw new AppError('store-not-found', 'Store not found.');
  return parseJson(store.menu, 'Store menu');
}

// ---------- kiosk: rotating BLE pairing token ----------

/**
 * Called by the kiosk app about every 30 s. Returns the token the kiosk
 * advertises over BLE. A phone must present a current token to connect,
 * which shows it is physically next to the kiosk.
 */
export async function kioskHeartbeat(db: Db, who: Caller, _args: unknown, now: number) {
  const { kioskId, storeId } = requireKiosk(who);
  const kioskRef = db.ref('Kiosk', kioskId);
  const secretRef = db.ref('KioskSecret', kioskId);

  return db.runTransaction(async (tx) => {
    const kiosk = await tx.get<Kiosk & Record<string, unknown>>(kioskRef);
    if (!kiosk || kiosk.storeId !== storeId) throw new AppError('kiosk-not-found', 'This kiosk is not registered.');
    const secret = await tx.get<KioskSecret & Record<string, unknown>>(secretRef);

    const issuedAt = secret?.currentExpiresAt != null ? secret.currentExpiresAt - CONFIG.TOKEN_TTL_MS : -Infinity;
    let token: string;
    let expiresAtMs: number;
    if (secret?.currentToken && now - issuedAt < CONFIG.TOKEN_REFRESH_MS && (secret.currentExpiresAt ?? 0) > now) {
      token = secret.currentToken;
      expiresAtMs = secret.currentExpiresAt as number;
    } else {
      token = generateToken();
      expiresAtMs = now + CONFIG.TOKEN_TTL_MS;
      tx.set(secretRef, {
        currentToken: token,
        currentExpiresAt: expiresAtMs,
        previousToken: secret?.currentToken ?? null,
        previousExpiresAt: secret?.currentExpiresAt ?? null,
      });
    }
    tx.update(kioskRef, { lastSeenAtMs: now });

    return {
      kioskId,
      token,
      expiresAtMs,
      refreshInMs: Math.max(1000, Math.min(CONFIG.TOKEN_REFRESH_MS, expiresAtMs - now - 5000)),
    };
  });
}

// ---------- phone: connect to a kiosk ----------

/**
 * The phone heard a kiosk's BLE advertisement and sends back the kiosk ID
 * and token. Creates a session linking this phone to the kiosk. One phone
 * at a time per kiosk; an idle session is replaced.
 */
export async function connectToKiosk(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const uid = requireUser(who);
  const { kioskId, token } = args ?? {};
  assertKioskId(kioskId);
  assertToken(token);
  const kioskRef = db.ref('Kiosk', kioskId);

  return db.runTransaction(async (tx) => {
    const kiosk = await tx.get<Kiosk & Record<string, unknown>>(kioskRef);
    if (!kiosk) throw new AppError('kiosk-not-found', 'Kiosk not found.');
    const secret = await tx.get<KioskSecret & Record<string, unknown>>(db.ref('KioskSecret', kioskId));
    if (!tokenMatches(secret, token, now)) {
      throw new AppError('token-invalid', 'Could not verify the kiosk. Move closer and try again.');
    }
    const store = await tx.get<Store & Record<string, unknown>>(db.ref('Store', kiosk.storeId));

    let prevRef: Ref | null = null;
    let prev: Session | null = null;
    if (kiosk.activeSessionId) {
      prevRef = db.ref('Session', kiosk.activeSessionId);
      prev = await tx.get<Session & Record<string, unknown>>(prevRef);
    }

    const event = (sessionId: string): LinkEvent => ({
      type: 'connected',
      kioskId,
      sessionId,
      storeId: kiosk.storeId,
      kioskName: kiosk.name ?? kioskId,
      storeName: store?.name ?? null,
      atMs: now,
    });

    if (prev && prevRef && prev.status === 'active' && !isIdle(prev, now)) {
      if (prev.userId === uid) {
        tx.update(prevRef, { lastActiveAtMs: now }); // same phone reconnecting
        return event(prevRef.id);
      }
      throw new AppError('kiosk-busy', 'Someone else is using this kiosk from their phone. Please wait a moment.');
    }
    if (prev && prevRef && prev.status === 'active') {
      tx.update(prevRef, { status: 'expired', endedAtMs: now });
    }

    const sessionId = db.newId();
    tx.set(db.ref('Session', sessionId), {
      kioskId,
      storeId: kiosk.storeId,
      userId: uid,
      status: 'active',
      createdAtMs: now,
      lastActiveAtMs: now,
      helpRequested: false,
      cart: { lines: [], total: 0, summary: '' },
      orderId: null,
    });
    tx.update(kioskRef, { activeSessionId: sessionId });
    return event(sessionId);
  });
}

// ---------- phone: live cart mirrored on the kiosk screen ----------

export async function syncCart(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const uid = requireUser(who);
  const sessionId = asId(args?.sessionId, 'sessionId');
  const items = parseJson(args?.items, 'items');

  const pre = await db.get<Session & Record<string, unknown>>(db.ref('Session', sessionId));
  if (!pre) throw new AppError('session-not-found', 'Connection not found. Please reconnect to the kiosk.');
  let cart: { lines: unknown[]; total: number; summary: string };
  if (Array.isArray(items) && items.length === 0) {
    cart = { lines: [], total: 0, summary: '' };
  } else {
    const { lines, total } = buildOrderLines(await loadMenu(db, pre.storeId), items);
    cart = { lines, total, summary: summarizeOrder(lines) };
  }

  return db.runTransaction(async (tx) => {
    const { ref, session } = await getOwnActiveSession(tx, db, uid, sessionId, now);
    tx.update(ref, { cart, lastActiveAtMs: now });
    return {
      type: 'cart',
      kioskId: session.kioskId,
      sessionId,
      storeId: session.storeId,
      total: cart.total,
      summary: cart.summary,
      atMs: now,
    };
  });
}

// ---------- phone: place the order ----------

export async function submitOrder(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const uid = requireUser(who);
  const sessionId = asId(args?.sessionId, 'sessionId');
  const paymentMethod = args?.paymentMethod ?? 'counter';
  const note = args?.note ?? '';
  if (!(CONFIG.PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    throw new AppError('bad-payment-method', `paymentMethod must be one of: ${CONFIG.PAYMENT_METHODS.join(', ')}.`);
  }
  if (typeof note !== 'string' || note.length > CONFIG.MAX_NOTE_LENGTH) {
    throw new AppError('bad-note', `Note must be text up to ${CONFIG.MAX_NOTE_LENGTH} characters.`);
  }

  const pre = await db.get<Session & Record<string, unknown>>(db.ref('Session', sessionId));
  if (!pre) throw new AppError('session-not-found', 'Connection not found. Please reconnect to the kiosk.');
  const storeId = pre.storeId;
  const { lines, total } = buildOrderLines(await loadMenu(db, storeId), parseJson(args?.items, 'items'));
  const summary = summarizeOrder(lines);

  return db.runTransaction(async (tx) => {
    const { ref: sessionRef, session } = await getOwnActiveSession(tx, db, uid, sessionId, now);
    const kioskRef = db.ref('Kiosk', session.kioskId);
    const kiosk = await tx.get<Kiosk & Record<string, unknown>>(kioskRef);
    const counterRef = db.ref('Counter', `${storeId}#${kstDayKey(now)}`);
    const counter = await tx.get<{ count: number } & Record<string, unknown>>(counterRef);
    const orderNumber = (counter?.count ?? 0) + 1;

    const orderId = db.newId();
    tx.set(db.ref('Order', orderId), {
      storeId,
      kioskId: session.kioskId,
      sessionId,
      userId: uid,
      orderNumber,
      lines,
      total,
      summary,
      note: note.trim(),
      paymentMethod,
      status: 'submitted',
      createdAtMs: now,
      updatedAtMs: now,
    });
    tx.set(counterRef, { count: orderNumber });
    tx.update(sessionRef, { status: 'ordered', orderId, lastActiveAtMs: now, endedAtMs: now });
    if (kiosk && kiosk.activeSessionId === sessionId) tx.update(kioskRef, { activeSessionId: null });

    return {
      type: 'ordered',
      kioskId: session.kioskId,
      sessionId,
      storeId,
      orderId,
      orderNumber,
      total,
      summary,
      status: 'submitted',
      atMs: now,
    };
  });
}

// ---------- help ----------

export async function requestHelp(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const uid = requireUser(who);
  const sessionId = asId(args?.sessionId, 'sessionId');
  return db.runTransaction(async (tx) => {
    const { ref, session } = await getOwnActiveSession(tx, db, uid, sessionId, now);
    tx.update(ref, { helpRequested: true, helpRequestedAtMs: now, lastActiveAtMs: now });
    return { type: 'help', kioskId: session.kioskId, sessionId, storeId: session.storeId, atMs: now };
  });
}

export async function resolveHelp(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const { kioskId } = requireKiosk(who);
  const sessionId = asId(args?.sessionId, 'sessionId');
  return db.runTransaction(async (tx) => {
    const ref = db.ref('Session', sessionId);
    const session = await tx.get<Session & Record<string, unknown>>(ref);
    if (!session || session.kioskId !== kioskId) {
      throw new AppError('session-not-found', 'Session not found for this kiosk.');
    }
    tx.update(ref, { helpRequested: false, helpResolvedAtMs: now });
    return { type: 'help_resolved', kioskId, sessionId, storeId: session.storeId, atMs: now };
  });
}

// ---------- disconnect (phone or kiosk) ----------

export async function endSession(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  if (!who) throw new AppError('not-signed-in', 'Please sign in first.');
  const sessionId = asId(args?.sessionId, 'sessionId');
  return db.runTransaction(async (tx) => {
    const ref = db.ref('Session', sessionId);
    const session = await tx.get<Session & Record<string, unknown>>(ref);
    if (!session) throw new AppError('session-not-found', 'Session not found.');
    const allowed = who.kind === 'kiosk' ? session.kioskId === who.kioskId : session.userId === who.uid;
    if (!allowed) throw new AppError('not-your-session', 'You cannot end this session.');

    const kioskRef = db.ref('Kiosk', session.kioskId);
    const kiosk = await tx.get<Kiosk & Record<string, unknown>>(kioskRef);
    if (session.status === 'active') tx.update(ref, { status: 'ended', endedAtMs: now });
    if (kiosk && kiosk.activeSessionId === sessionId) tx.update(kioskRef, { activeSessionId: null });
    return {
      type: 'ended',
      kioskId: session.kioskId,
      sessionId,
      storeId: session.storeId,
      status: session.status === 'active' ? 'ended' : session.status,
      atMs: now,
    };
  });
}

// ---------- orders ----------

export async function updateOrderStatus(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const { storeId } = requireKiosk(who);
  const orderId = asId(args?.orderId, 'orderId');
  const status = args?.status;
  if (typeof status !== 'string') throw new AppError('bad-status', 'status is required.');
  return db.runTransaction(async (tx) => {
    const ref = db.ref('Order', orderId);
    const order = await tx.get<Order & Record<string, unknown>>(ref);
    if (!order || order.storeId !== storeId) throw new AppError('order-not-found', 'Order not found in this store.');
    assertTransition(order.status, status);
    tx.update(ref, {
      status,
      updatedAtMs: now,
      [STATUS_TIME_FIELD[status]]: now,
      ...(status === 'cancelled' ? { cancelledBy: 'staff' } : {}),
    });
    return {
      type: 'order_status',
      kioskId: order.kioskId,
      sessionId: order.sessionId,
      storeId,
      orderId,
      orderNumber: order.orderNumber,
      status,
      atMs: now,
    };
  });
}

export async function cancelMyOrder(db: Db, who: Caller, args: any, now: number): Promise<LinkEvent> {
  const uid = requireUser(who);
  const orderId = asId(args?.orderId, 'orderId');
  return db.runTransaction(async (tx) => {
    const ref = db.ref('Order', orderId);
    const order = await tx.get<Order & Record<string, unknown>>(ref);
    if (!order || order.userId !== uid) throw new AppError('order-not-found', 'Order not found.');
    if (order.status !== 'submitted') {
      throw new AppError('too-late-to-cancel', 'Staff already started this order. Please ask at the counter.');
    }
    tx.update(ref, { status: 'cancelled', updatedAtMs: now, cancelledAtMs: now, cancelledBy: 'customer' });
    return {
      type: 'order_status',
      kioskId: order.kioskId,
      sessionId: order.sessionId,
      storeId: order.storeId,
      orderId,
      orderNumber: order.orderNumber,
      status: 'cancelled',
      atMs: now,
    };
  });
}

// ---------- real-time subscriptions (checked once, at subscribe time) ----------

/** A kiosk may only listen to its own events. */
export async function subscribeKiosk(_db: Db, who: Caller, args: any): Promise<null> {
  const { kioskId } = requireKiosk(who);
  if (args?.kioskId !== kioskId) throw new AppError('not-your-kiosk', 'A kiosk can only listen to its own events.');
  return null;
}

/** A phone may only listen to a session it created. */
export async function subscribeSession(db: Db, who: Caller, args: any): Promise<null> {
  const uid = requireUser(who);
  const sessionId = asId(args?.sessionId, 'sessionId');
  const session = await db.get<Session & Record<string, unknown>>(db.ref('Session', sessionId));
  if (!session || session.userId !== uid) throw new AppError('session-not-found', 'Session not found.');
  return null;
}

export async function getMyOrder(db: Db, who: Caller, args: any) {
  const uid = requireUser(who);
  const orderId = asId(args?.orderId, 'orderId');
  const order = await db.get<Order & Record<string, unknown>>(db.ref('Order', orderId));
  if (!order || order.userId !== uid) throw new AppError('order-not-found', 'Order not found.');
  return {
    orderId,
    orderNumber: order.orderNumber,
    status: order.status,
    total: order.total,
    summary: order.summary ?? null,
    lines: JSON.stringify(order.lines ?? []),
    paymentMethod: order.paymentMethod ?? null,
    createdAtMs: order.createdAtMs ?? null,
  };
}
