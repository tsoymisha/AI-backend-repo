import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { api } from '../functions/api/resource';

/*
 * Data model and API for Linkage Lab.
 *
 * Principle: apps READ data directly, but every change goes through the
 * `api` Lambda function (custom mutations below). The Lambda validates
 * input and computes prices on the server, so a modified app cannot fake
 * prices, order numbers or kiosk pairing.
 *
 * Real time: the kiosk subscribes to `onKioskEvent` and the phone to
 * `onSessionEvent`. These fire automatically whenever the listed
 * mutations succeed, carrying the mutation's LinkEvent result. AppSync
 * delivers only events whose kioskId / sessionId equals the subscription
 * argument, and the api Lambda checks at subscribe time that the caller
 * is allowed to use that argument.
 *
 * Timestamps the Lambda manages are milliseconds since epoch (`...Ms`).
 */

const schema = a.schema({
  // ---------- stored records (DynamoDB tables) ----------

  /** A store, its accessibility info and its menu (menu kept as JSON). */
  Store: a
    .model({
      name: a.string().required(),
      nameEn: a.string(),
      address: a.string(),
      lat: a.float(),
      lng: a.float(),
      geofenceRadiusM: a.integer(),
      orderingMethods: a.string().array(),
      accessibility: a.json(),
      kioskFeatures: a.json(),
      indoorDirections: a.string(),
      // [{ id, name, nameEn, category, sortOrder, price, available,
      //    description, options: [{ id, name, type, required, maxChoices,
      //    choices: [{ id, name, priceDelta, available }] }] }]
      menu: a.json(),
    })
    .authorization((allow) => [
      allow.guest().to(['read']),
      allow.authenticated().to(['read']),
      allow.group('admins'),
    ]),

  /** A kiosk. Its id is a 4-character code (e.g. GK01) sent over BLE. */
  Kiosk: a
    .model({
      storeId: a.string().required(),
      name: a.string(),
      nameEn: a.string(),
      activeSessionId: a.string(),
      lastSeenAtMs: a.float(),
    })
    .authorization((allow) => [
      allow.guest().to(['read']),
      allow.authenticated().to(['read']),
      allow.group('admins'),
    ]),

  /** The rotating BLE pairing token. Never readable by apps. */
  KioskSecret: a
    .model({
      currentToken: a.string(),
      currentExpiresAt: a.float(),
      previousToken: a.string(),
      previousExpiresAt: a.float(),
    })
    .authorization((allow) => [allow.group('admins').to(['read'])]),

  /** Links a kiosk's Cognito login (id = user sub) to its kiosk ID. */
  KioskAccount: a
    .model({
      kioskId: a.string().required(),
      storeId: a.string().required(),
    })
    .authorization((allow) => [allow.group('admins')]),

  /** One phone connected to one kiosk. */
  Session: a
    .model({
      kioskId: a.string().required(),
      storeId: a.string().required(),
      userId: a.string().required(),
      status: a.string().required(), // active | ordered | ended | expired
      createdAtMs: a.float(),
      lastActiveAtMs: a.float(),
      endedAtMs: a.float(),
      helpRequested: a.boolean(),
      helpRequestedAtMs: a.float(),
      helpResolvedAtMs: a.float(),
      cart: a.json(), // { lines, total, summary }
      orderId: a.string(),
    })
    .authorization((allow) => [allow.group('kiosks').to(['read']), allow.group('admins').to(['read'])]),

  Order: a
    .model({
      storeId: a.string().required(),
      kioskId: a.string().required(),
      sessionId: a.string().required(),
      userId: a.string().required(),
      orderNumber: a.integer().required(),
      lines: a.json(),
      total: a.integer().required(),
      summary: a.string(),
      note: a.string(),
      paymentMethod: a.string(),
      status: a.string().required(), // submitted | accepted | preparing | ready | picked_up | cancelled
      createdAtMs: a.float().required(),
      updatedAtMs: a.float(),
      acceptedAtMs: a.float(),
      preparingAtMs: a.float(),
      readyAtMs: a.float(),
      pickedUpAtMs: a.float(),
      cancelledAtMs: a.float(),
      cancelledBy: a.string(),
    })
    // Lets the kiosk list today's orders: listOrderByStoreIdAndCreatedAtMs
    .secondaryIndexes((index) => [index('storeId').sortKeys(['createdAtMs'])])
    .authorization((allow) => [allow.group('kiosks').to(['read']), allow.group('admins').to(['read'])]),

  /** Daily order-number counter per store. id = "<storeId>#<YYYY-MM-DD>" (KST). */
  Counter: a
    .model({
      count: a.integer().required(),
    })
    .authorization((allow) => [allow.group('admins').to(['read'])]),

  // ---------- API results ----------

  /** Returned by most mutations and pushed to subscribers in real time. */
  LinkEvent: a.customType({
    type: a.string().required(), // connected | cart | ordered | help | help_resolved | ended | order_status
    kioskId: a.string().required(),
    sessionId: a.string(),
    storeId: a.string(),
    kioskName: a.string(),
    storeName: a.string(),
    orderId: a.string(),
    orderNumber: a.integer(),
    total: a.integer(),
    summary: a.string(),
    status: a.string(),
    atMs: a.float(),
  }),

  HeartbeatResult: a.customType({
    kioskId: a.string().required(),
    token: a.string().required(),
    expiresAtMs: a.float().required(),
    refreshInMs: a.integer().required(),
  }),

  /** What the phone sees about its own order. */
  MyOrder: a.customType({
    orderId: a.string().required(),
    orderNumber: a.integer().required(),
    status: a.string().required(),
    total: a.integer().required(),
    summary: a.string(),
    lines: a.json(),
    paymentMethod: a.string(),
    createdAtMs: a.float(),
  }),

  // ---------- kiosk operations ----------

  kioskHeartbeat: a
    .mutation()
    .returns(a.ref('HeartbeatResult'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.group('kiosks')]),

  resolveHelp: a
    .mutation()
    .arguments({ sessionId: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.group('kiosks')]),

  updateOrderStatus: a
    .mutation()
    .arguments({ orderId: a.string().required(), status: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.group('kiosks')]),

  // ---------- phone operations ----------

  connectToKiosk: a
    .mutation()
    .arguments({ kioskId: a.string().required(), token: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  /** items = JSON array: [{ itemId, qty, options: { optionId: choiceId | [choiceIds] } }] */
  syncCart: a
    .mutation()
    .arguments({ sessionId: a.string().required(), items: a.json().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  submitOrder: a
    .mutation()
    .arguments({
      sessionId: a.string().required(),
      items: a.json().required(),
      paymentMethod: a.string(), // counter (default) | kiosk
      note: a.string(),
    })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  requestHelp: a
    .mutation()
    .arguments({ sessionId: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  cancelMyOrder: a
    .mutation()
    .arguments({ orderId: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  getMyOrder: a
    .query()
    .arguments({ orderId: a.string().required() })
    .returns(a.ref('MyOrder'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest()]),

  // ---------- both ----------

  endSession: a
    .mutation()
    .arguments({ sessionId: a.string().required() })
    .returns(a.ref('LinkEvent'))
    .handler(a.handler.function(api))
    .authorization((allow) => [allow.guest(), allow.group('kiosks')]),

  // ---------- real-time ----------

  /** Kiosk screen: phone connected, cart changed, order placed, help asked. */
  onKioskEvent: a
    .subscription()
    .for([
      a.ref('connectToKiosk'),
      a.ref('syncCart'),
      a.ref('submitOrder'),
      a.ref('requestHelp'),
      a.ref('cancelMyOrder'),
      a.ref('endSession'),
    ])
    .arguments({ kioskId: a.string().required() })
    .handler(a.handler.function(api)) // checks the kiosk subscribes to itself
    .authorization((allow) => [allow.group('kiosks')]),

  /** Phone: staff answered help, order status changed, kiosk ended session. */
  onSessionEvent: a
    .subscription()
    .for([a.ref('resolveHelp'), a.ref('updateOrderStatus'), a.ref('endSession')])
    .arguments({ sessionId: a.string().required() })
    .handler(a.handler.function(api)) // checks the phone owns this session
    .authorization((allow) => [allow.guest()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Phones (guests) use IAM via the identity pool by default.
    // The kiosk app passes authMode 'userPool' on its calls.
    defaultAuthorizationMode: 'identityPool',
  },
});
