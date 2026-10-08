import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * Shared helpers for the admin scripts. They read amplify_outputs.json,
 * which `npx ampx sandbox` (or a branch deploy) writes to the project root,
 * and use your own AWS credentials (the same ones you deploy with).
 */

export interface Outputs {
  auth: { user_pool_id: string; aws_region: string };
  data: { url: string; aws_region: string };
}

export function loadOutputs(): Outputs {
  const path = resolve(process.cwd(), 'amplify_outputs.json');
  if (!existsSync(path)) {
    throw new Error('amplify_outputs.json not found. Run `npx ampx sandbox` first (from the project root).');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Amplify Gen 2 names each model table "<Model>-<AppSync API id>-NONE".
 * The API id is the first part of the GraphQL URL's host name.
 */
export function tableName(outputs: Outputs, model: string): string {
  const apiId = new URL(outputs.data.url).hostname.split('.')[0];
  return `${model}-${apiId}-NONE`;
}

/** Fields Amplify's own resolvers add to every record. */
export function amplifyFields(model: string) {
  const now = new Date().toISOString();
  return { __typename: model, createdAt: now, updatedAt: now };
}
