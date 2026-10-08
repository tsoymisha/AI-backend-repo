# Linkage Lab backend (AWS Amplify Gen 2)

Backend for the accessible kiosk-ordering app. A phone finds a kiosk over
BLE, connects to it, and places the order from an accessible phone screen;
the kiosk shows the cart and the order in real time.

```
Phone (Flutter)  --BLE scan-->  Kiosk tablet (Flutter, advertises token)
      |                                  |
      |  GraphQL (AppSync)               |  GraphQL + real-time subscription
      v                                  v
         AppSync API  -->  linkage-api Lambda  -->  DynamoDB tables
         Cognito: phones = guests, kiosks = "kiosks" group
```

## What is in here

| Path | What it does |
| --- | --- |
| `amplify/auth/resource.ts` | Cognito: guest access for phones, `kiosks` and `admins` groups |
| `amplify/data/resource.ts` | Tables, who can read them, every API operation, real-time subscriptions |
| `amplify/functions/api/handler.ts` | The one Lambda: identifies the caller, routes to the logic |
| `amplify/functions/api/src/service.ts` | Business logic: pairing, cart, orders, help, status |
| `amplify/functions/api/src/pure.ts` | Pricing, validation, tokens (no AWS code) |
| `amplify/functions/api/src/dynamoDb.ts` | DynamoDB access with safe (optimistic) transactions |
| `seed/gist-cafe.json` | Demo store, menu and kiosk (placeholder values: fix after visiting) |
| `scripts/` | Load store data, create kiosk logins |
| `test/` | 33 tests, run against an in-memory DB and a local DynamoDB |

## Setup (once per developer)

1. **AWS account.** New accounts get a free plan with credits for 6 months.
   In the AWS console, create a **budget alert** (Billing → Budgets, e.g. $5).
2. **Credentials.** Install the AWS CLI and run `aws configure sso` (or
   `aws configure` with an IAM user that has `AmplifyBackendDeployFullAccess`).
   Use region **ap-northeast-2 (Seoul)**.
3. **Install.** Node.js 22, then in this folder: `npm install`
4. **Run the tests.** `npm test` (no AWS needed)

## Run your own cloud sandbox

```bash
npx ampx sandbox            # deploys a personal copy; keeps running and redeploys on save
```

This writes `amplify_outputs.json`. Copy it into the Flutter apps (they need
it to connect). In a second terminal, load data and create the kiosk login:

```bash
npm run seed -- seed/gist-cafe.json
KIOSK_PASSWORD='choose-a-long-password' npm run create-kiosk -- GK01
```

Stop with Ctrl+C; `npx ampx sandbox delete` removes the sandbox resources.

## Contract for the Flutter apps

### BLE advertisement (kiosk → phone)

The kiosk advertises **manufacturer-specific data** with company ID
`0xFFFF` (reserved for testing) and this 14-byte ASCII payload:

```
"LK" + kioskId (4 chars) + token (8 chars)      e.g.  LKGK017H3KQ9ZC
```

- Get `token` from `kioskHeartbeat`; call it again after `refreshInMs`
  (about every 30 s) and update the advertisement.
- The phone filters scans for company ID `0xFFFF` and the `LK` prefix, then
  calls `connectToKiosk(kioskId, token)`. A token is valid for 60 s, so
  only a phone physically near the kiosk can connect.

### Operations

Phones call with the default auth mode (guest/IAM). Kiosks sign in and pass
`authMode: userPool`.

| Operation | Caller | Arguments | Returns |
| --- | --- | --- | --- |
| `kioskHeartbeat` | kiosk | — | `HeartbeatResult` {token, expiresAtMs, refreshInMs} |
| `connectToKiosk` | phone | kioskId, token | `LinkEvent` type `connected` (sessionId, kioskName, storeName) |
| `syncCart` | phone | sessionId, items | `LinkEvent` type `cart` (total, summary) |
| `submitOrder` | phone | sessionId, items, paymentMethod?, note? | `LinkEvent` type `ordered` (orderId, orderNumber, total, summary) |
| `requestHelp` | phone | sessionId | `LinkEvent` type `help` |
| `cancelMyOrder` | phone | orderId | `LinkEvent` type `order_status` |
| `getMyOrder` | phone | orderId | `MyOrder` |
| `resolveHelp` | kiosk | sessionId | `LinkEvent` type `help_resolved` |
| `updateOrderStatus` | kiosk | orderId, status | `LinkEvent` type `order_status` |
| `endSession` | either | sessionId | `LinkEvent` type `ended` |

`items` is a JSON array; prices are never sent, the server computes them:

```json
[{ "itemId": "americano", "qty": 1, "options": { "temp": "ice", "size": "large", "extra": ["shot"] } }]
```

Order status path: `submitted → accepted → preparing → ready → picked_up`
(`cancelled` allowed from `submitted` or `accepted`).

### Reading data

- Phone: `Store` (name, accessibility info, `menu` JSON) and `Kiosk` are readable by guests.
- Kiosk: also reads `Session` and `Order` (e.g. `listOrderByStoreIdAndCreatedAtMs` for today's queue).

### Real time

- Kiosk subscribes to `onKioskEvent(kioskId)`: phone connected, cart changed, order placed, help requested, cancelled, ended.
- Phone subscribes to `onSessionEvent(sessionId)`: help answered, order status changed, kiosk ended the session.

### Errors

Errors come back with `errorType` set to a stable reason. Map these to
Korean messages the screen reader can read:

| errorType | Meaning |
| --- | --- |
| `token-invalid` | Too far from the kiosk or token expired: move closer, rescan |
| `kiosk-busy` | Another phone is using this kiosk |
| `session-expired` / `session-not-found` | Connection ended: reconnect |
| `item-unavailable`, `choice-unavailable` | Sold out |
| `missing-option` | A required option (e.g. size) was not chosen |
| `too-late-to-cancel` | Staff already started the order |
| `bad-qty`, `unknown-item`, `bad-options`, … | App bug: invalid request |
| `internal` | Server problem: try again |

## Notes and limits

- Sessions end after 10 minutes of inactivity; one phone per kiosk at a time.
- Order numbers restart at 1 each day (Korea time) per store.
- Any kiosk account can read every store's sessions and orders through the
  table read rules; the Lambda still restricts what each kiosk can change.
  Fine for the pilot; tighten before real deployment.
- Payment is not handled: `paymentMethod` is `counter` or `kiosk` (pay there).
