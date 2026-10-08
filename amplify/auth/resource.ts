import { defineAuth } from '@aws-amplify/backend';

/**
 * Who signs in, and how:
 *
 * - Phone users do NOT create accounts. They use Cognito guest access
 *   (an unauthenticated Identity Pool identity, enabled by default in
 *   Amplify Gen 2). The app keeps the same guest identity on the device,
 *   so a user can see their own orders without signing up.
 *
 * - Kiosk tablets sign in with email + password and belong to the
 *   "kiosks" group. scripts/createKiosk.ts creates these accounts and links
 *   each one to a kiosk ID (KioskAccount record).
 *
 * - Team members who manage store and menu data belong to "admins".
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['kiosks', 'admins'],
});
