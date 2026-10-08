import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFIG,
  TOKEN_ALPHABET,
  assertTransition,
  buildOrderLines,
  generateToken,
  kstDayKey,
  parseJson,
  summarizeOrder,
  tokenMatches,
} from '../amplify/functions/api/src/pure';

const seed = JSON.parse(readFileSync(new URL('../seed/gist-cafe.json', import.meta.url), 'utf8'));
const MENU = seed.menu;

const reason = (r: string) => (err: any) => err.reason === r;

test('tokens use the unambiguous alphabet and the configured length', () => {
  for (let i = 0; i < 200; i++) {
    const t = generateToken();
    assert.equal(t.length, CONFIG.TOKEN_LENGTH);
    for (const ch of t) assert.ok(TOKEN_ALPHABET.includes(ch));
  }
});

test('tokenMatches accepts current and previous tokens until they expire', () => {
  const now = 1_000_000;
  const secret = { currentToken: 'AAAAAAAA', currentExpiresAt: now + 10, previousToken: 'BBBBBBBB', previousExpiresAt: now + 5 };
  assert.equal(tokenMatches(secret, 'AAAAAAAA', now), true);
  assert.equal(tokenMatches(secret, 'BBBBBBBB', now), true);
  assert.equal(tokenMatches(secret, 'BBBBBBBB', now + 5), false, 'expired previous token');
  assert.equal(tokenMatches(secret, 'CCCCCCCC', now), false);
  assert.equal(tokenMatches(null, 'AAAAAAAA', now), false);
});

test('kstDayKey rolls over at midnight Korea time (15:00 UTC)', () => {
  assert.equal(kstDayKey(Date.parse('2026-10-06T14:59:59Z')), '2026-10-06');
  assert.equal(kstDayKey(Date.parse('2026-10-06T15:00:00Z')), '2026-10-07');
});

test('prices are computed from the menu, including option surcharges', () => {
  const { lines, total } = buildOrderLines(MENU, [
    { itemId: 'americano', qty: 2, options: { temp: 'ice', size: 'large', extra: ['shot'] } },
    { itemId: 'grapefruit-ade', qty: 1 },
  ]);
  assert.equal(lines[0].unitPrice, 2500 + 500 + 500);
  assert.equal(lines[0].lineTotal, 7000);
  assert.equal(lines[1].lineTotal, 4500);
  assert.equal(total, 11500);
  assert.equal(
    summarizeOrder(lines),
    '아메리카노 (아이스, 라지, 샷 추가) 2개, 자몽에이드 1개'
  );
});

test('the whipped-cream example: "remove whipped cream" is a real menu choice', () => {
  const { lines } = buildOrderLines(MENU, [{ itemId: 'vanilla-latte', qty: 1, options: { temp: 'ice', whip: 'without' } }]);
  assert.deepEqual(lines[0].options.map((o) => o.choiceName), ['아이스', '휘핑크림 빼기']);
});

test('rejects bad orders with a specific reason', () => {
  const cases: Array<[unknown, string]> = [
    [[], 'empty-order'],
    ['not a list', 'empty-order'],
    [[{ itemId: 'nope', qty: 1 }], 'unknown-item'],
    [[{ itemId: 'cheesecake', qty: 1 }], 'item-unavailable'],
    [[{ itemId: 'grapefruit-ade', qty: 0 }], 'bad-qty'],
    [[{ itemId: 'grapefruit-ade', qty: 1.5 }], 'bad-qty'],
    [[{ itemId: 'grapefruit-ade', qty: 11 }], 'bad-qty'],
    [[{ itemId: 'americano', qty: 1, options: { size: 'large' } }], 'missing-option'],
    [[{ itemId: 'americano', qty: 1, options: { temp: 'lava', size: 'large' } }], 'unknown-choice'],
    [[{ itemId: 'americano', qty: 1, options: { temp: 'ice', size: 'large', color: 'red' } }], 'unknown-option'],
    [[{ itemId: 'americano', qty: 1, options: { temp: ['ice'], size: 'large' } }], 'bad-options'],
    [[{ itemId: 'americano', qty: 1, options: { temp: 'ice', size: 'large', extra: 'shot' } }], 'bad-options'],
    [[{ itemId: 'americano', qty: 1, options: { temp: 'ice', size: 'large', extra: ['shot', 'shot'] } }], 'bad-options'],
    [Array.from({ length: CONFIG.MAX_LINES_PER_ORDER + 1 }, () => ({ itemId: 'grapefruit-ade', qty: 1 })), 'too-many-lines'],
  ];
  for (const [items, r] of cases) {
    assert.throws(() => buildOrderLines(MENU, items), reason(r), `expected ${r} for ${JSON.stringify(items).slice(0, 80)}`);
  }
});

test('a client-supplied price is ignored', () => {
  const { total } = buildOrderLines(MENU, [{ itemId: 'grapefruit-ade', qty: 1, price: 1 } as any]);
  assert.equal(total, 4500);
});

test('AWSJSON arguments are accepted as strings or objects', () => {
  assert.deepEqual(parseJson('[1,2]', 'x'), [1, 2]);
  assert.deepEqual(parseJson([1, 2], 'x'), [1, 2]);
  assert.throws(() => parseJson('{oops', 'x'), reason('bad-request'));
});

test('order status can only move forward along the allowed path', () => {
  assertTransition('submitted', 'accepted');
  assertTransition('accepted', 'preparing');
  assertTransition('preparing', 'ready');
  assertTransition('ready', 'picked_up');
  assert.throws(() => assertTransition('submitted', 'ready'), reason('bad-transition'));
  assert.throws(() => assertTransition('picked_up', 'cancelled'), reason('bad-transition'));
  assert.throws(() => assertTransition('preparing', 'cancelled'), reason('bad-transition'));
});
