/*
 * Load a store (with its menu and accessibility info) and its kiosks.
 *
 *   npm run seed -- seed/gist-cafe.json
 *
 * Re-running replaces the store and menu, and updates kiosk names without
 * touching a running kiosk's state. It never touches sessions or orders.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { amplifyFields, loadOutputs, tableName } from './lib';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run seed -- <store.json>');
  const { storeId, store, kiosks = [], menu = [] } = JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (!storeId || !store) throw new Error('The JSON file needs "storeId" and "store".');

  for (const k of kiosks) {
    if (!/^[A-Z0-9]{4}$/.test(k.kioskId)) throw new Error(`Kiosk ID "${k.kioskId}" must be 4 characters, A-Z and 0-9.`);
  }
  const ids = new Set<string>();
  for (const m of menu) {
    if (!m.id || ids.has(m.id)) throw new Error(`Menu item id missing or duplicated: ${m.id}`);
    ids.add(m.id);
    if (!Number.isInteger(m.price) || m.price < 0) throw new Error(`${m.id}: price must be a whole number of won.`);
  }

  const outputs = loadOutputs();
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: outputs.data.aws_region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const { location, ...rest } = store;
  await doc.send(
    new PutCommand({
      TableName: tableName(outputs, 'Store'),
      Item: { ...rest, lat: location?.lat, lng: location?.lng, menu, id: storeId, ...amplifyFields('Store') },
    })
  );

  for (const k of kiosks) {
    const now = new Date().toISOString();
    await doc.send(
      new UpdateCommand({
        TableName: tableName(outputs, 'Kiosk'),
        Key: { id: k.kioskId },
        UpdateExpression:
          'SET storeId = :s, #n = :n, nameEn = :ne, updatedAt = :u, __typename = :t, createdAt = if_not_exists(createdAt, :u)',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':s': storeId, ':n': k.name, ':ne': k.nameEn ?? null, ':u': now, ':t': 'Kiosk' },
      })
    );
  }

  console.log(`Seeded ${storeId}: ${menu.length} menu items, ${kiosks.length} kiosk(s).`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
