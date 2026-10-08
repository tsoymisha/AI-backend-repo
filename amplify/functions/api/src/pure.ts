// Pure helpers with no AWS dependency, so they are easy to unit test.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';

export const CONFIG = {
  // How long a BLE pairing token stays valid. The kiosk refreshes it every
  // TOKEN_REFRESH_MS; the previous token is still accepted so a phone that
  // scanned just before a rotation can still connect.
  TOKEN_TTL_MS: 60_000,
  TOKEN_REFRESH_MS: 30_000,
  TOKEN_LENGTH: 8,
  // A phone session ends automatically after this much inactivity.
  SESSION_IDLE_MS: 10 * 60_000,
  MAX_LINES_PER_ORDER: 20,
  MAX_QTY_PER_LINE: 10,
  MAX_NOTE_LENGTH: 200,
  PAYMENT_METHODS: ['counter', 'kiosk'] as const,
  // Korea Standard Time, used for the daily order-number counter.
  KST_OFFSET_MS: 9 * 60 * 60_000,
};

// Crockford base32 without I, L, O, U: unambiguous if ever read aloud or typed.
export const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateToken(length = CONFIG.TOKEN_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] % 32];
  return out;
}

// Kiosk IDs are short codes like "GK01" so they fit in a BLE advertisement.
const KIOSK_ID_RE = /^[A-Z0-9]{4}$/;
const TOKEN_RE = new RegExp(`^[${TOKEN_ALPHABET}]{${CONFIG.TOKEN_LENGTH}}$`);

export function assertKioskId(kioskId: unknown): asserts kioskId is string {
  if (typeof kioskId !== 'string' || !KIOSK_ID_RE.test(kioskId)) {
    throw new AppError('bad-kiosk-id', 'Kiosk ID must be 4 characters (A-Z, 0-9).');
  }
}

export function assertToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new AppError('bad-token', 'Pairing token is malformed.');
  }
}

export interface KioskSecret {
  currentToken?: string | null;
  currentExpiresAt?: number | null;
  previousToken?: string | null;
  previousExpiresAt?: number | null;
}

/** Is `token` one of the kiosk's currently valid tokens? Constant-time compare. */
export function tokenMatches(secret: KioskSecret | null, token: string, now: number): boolean {
  if (!secret) return false;
  const candidates: Array<[string | null | undefined, number | null | undefined]> = [
    [secret.currentToken, secret.currentExpiresAt],
    [secret.previousToken, secret.previousExpiresAt],
  ];
  return candidates.some(
    ([t, exp]) =>
      typeof t === 'string' &&
      t.length === token.length &&
      typeof exp === 'number' &&
      exp > now &&
      timingSafeEqual(Buffer.from(t), Buffer.from(token))
  );
}

/** "2026-10-06" in Korea time: the daily order-number counter key. */
export function kstDayKey(now: number): string {
  return new Date(now + CONFIG.KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ---------- menu and order lines ----------

export interface MenuChoice {
  id: string;
  name: string;
  priceDelta?: number;
  available?: boolean;
}
export interface MenuOption {
  id: string;
  name: string;
  type: 'single' | 'multi';
  required?: boolean;
  maxChoices?: number;
  choices: MenuChoice[];
}
export interface MenuItem {
  id: string;
  name: string;
  nameEn?: string;
  price: number;
  available?: boolean;
  options?: MenuOption[];
}
export interface RequestedLine {
  itemId: string;
  qty: number;
  options?: Record<string, string | string[]>;
}
export interface OrderLine {
  itemId: string;
  name: string;
  nameEn: string | null;
  qty: number;
  options: Array<{
    optionId: string;
    optionName: string;
    choiceId: string;
    choiceName: string;
    priceDelta: number;
  }>;
  unitPrice: number;
  lineTotal: number;
}

/** Parse an AWSJSON argument, which may arrive as a string or already parsed. */
export function parseJson(value: unknown, what: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError('bad-request', `${what} is not valid JSON.`);
  }
}

/**
 * Validate the phone's requested lines against the store menu and compute
 * every price on the server. The phone never sends prices.
 */
export function buildOrderLines(menuList: unknown, requested: unknown): { lines: OrderLine[]; total: number } {
  const menu = new Map<string, MenuItem>();
  if (Array.isArray(menuList)) for (const m of menuList as MenuItem[]) if (m && m.id) menu.set(m.id, m);

  if (!Array.isArray(requested) || requested.length === 0) {
    throw new AppError('empty-order', 'The order has no items.');
  }
  if (requested.length > CONFIG.MAX_LINES_PER_ORDER) {
    throw new AppError('too-many-lines', `At most ${CONFIG.MAX_LINES_PER_ORDER} lines per order.`);
  }

  const lines = requested.map((req: RequestedLine, index): OrderLine => {
    if (!req || typeof req !== 'object') {
      throw new AppError('bad-line', `Line ${index + 1} is malformed.`);
    }
    const item = typeof req.itemId === 'string' ? menu.get(req.itemId) : undefined;
    if (!item) throw new AppError('unknown-item', `Line ${index + 1}: item not on this menu.`);
    if (item.available === false) throw new AppError('item-unavailable', `${item.name} is sold out.`);

    const qty = req.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > CONFIG.MAX_QTY_PER_LINE) {
      throw new AppError('bad-qty', `Quantity must be 1-${CONFIG.MAX_QTY_PER_LINE}.`);
    }

    const picked = req.options == null ? {} : req.options;
    if (typeof picked !== 'object' || Array.isArray(picked)) {
      throw new AppError('bad-options', `Line ${index + 1}: options are malformed.`);
    }
    const defs = Array.isArray(item.options) ? item.options : [];
    const known = new Set(defs.map((d) => d.id));
    for (const key of Object.keys(picked)) {
      if (!known.has(key)) throw new AppError('unknown-option', `${item.name}: unknown option.`);
    }

    let unitPrice = item.price;
    const chosen: OrderLine['options'] = [];
    for (const def of defs) {
      const raw = picked[def.id];
      const ids: unknown = raw == null ? [] : def.type === 'multi' ? raw : [raw];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new AppError('bad-options', `${item.name}: ${def.name} is malformed.`);
      }
      if (new Set(ids).size !== ids.length) {
        throw new AppError('bad-options', `${item.name}: ${def.name} has duplicates.`);
      }
      if (def.required && ids.length === 0) {
        throw new AppError('missing-option', `${item.name}: please choose ${def.name}.`);
      }
      const max = def.type === 'multi' ? def.maxChoices ?? def.choices.length : 1;
      if (ids.length > max) {
        throw new AppError('too-many-choices', `${item.name}: too many choices for ${def.name}.`);
      }
      for (const id of ids as string[]) {
        const choice = def.choices.find((c) => c.id === id);
        if (!choice) throw new AppError('unknown-choice', `${item.name}: unknown choice for ${def.name}.`);
        if (choice.available === false) {
          throw new AppError('choice-unavailable', `${item.name}: ${choice.name} is unavailable.`);
        }
        const delta = choice.priceDelta || 0;
        unitPrice += delta;
        chosen.push({ optionId: def.id, optionName: def.name, choiceId: choice.id, choiceName: choice.name, priceDelta: delta });
      }
    }

    return {
      itemId: req.itemId,
      name: item.name,
      nameEn: item.nameEn ?? null,
      qty,
      options: chosen,
      unitPrice,
      lineTotal: unitPrice * qty,
    };
  });

  return { lines, total: lines.reduce((sum, l) => sum + l.lineTotal, 0) };
}

/**
 * One-line Korean summary for the kiosk screen and the phone's screen
 * reader: "아이스 아메리카노 (아이스, 라지) 1개, 카페라떼 2개"
 */
export function summarizeOrder(lines: OrderLine[]): string {
  return lines
    .map((l) => {
      const opts = l.options.map((o) => o.choiceName);
      return `${l.name}${opts.length ? ` (${opts.join(', ')})` : ''} ${l.qty}개`;
    })
    .join(', ');
}

// ---------- order status ----------

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  submitted: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready'],
  ready: ['picked_up'],
  picked_up: [],
  cancelled: [],
};

/** Field that records when an order entered a status: ready -> readyAtMs */
export const STATUS_TIME_FIELD: Record<string, string> = {
  accepted: 'acceptedAtMs',
  preparing: 'preparingAtMs',
  ready: 'readyAtMs',
  picked_up: 'pickedUpAtMs',
  cancelled: 'cancelledAtMs',
};

export function assertTransition(from: string, to: string): void {
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed) throw new AppError('bad-status', `Unknown status ${from}.`);
  if (!allowed.includes(to)) throw new AppError('bad-transition', `Cannot change an order from ${from} to ${to}.`);
}
