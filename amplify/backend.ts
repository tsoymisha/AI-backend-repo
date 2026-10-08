import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { api } from './functions/api/resource';

const backend = defineBackend({ auth, data, api });

// Give the api Lambda direct read/write access to the tables it manages,
// and tell it their names. Direct DynamoDB access lets it use
// transactions (needed for order numbers and one-phone-per-kiosk).
const tables = backend.data.resources.tables;
const fn = backend.api.resources.lambda;
const managed = ['Store', 'Kiosk', 'KioskSecret', 'KioskAccount', 'Session', 'Order', 'Counter'] as const;

for (const name of managed) {
  tables[name].grantReadWriteData(fn);
  backend.api.addEnvironment(`TABLE_${name.toUpperCase()}`, tables[name].tableName);
}
