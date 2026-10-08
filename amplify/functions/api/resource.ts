import { defineFunction } from '@aws-amplify/backend';

/** One Lambda handles every custom mutation/query (switches on field name). */
export const api = defineFunction({
  name: 'linkage-api',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 10,
  memoryMB: 256,
  // Lives in the data stack because it is a data resolver and also gets
  // table access; avoids a circular dependency between stacks.
  resourceGroupName: 'data',
});
