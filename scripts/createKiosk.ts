/*
 * Create (or reset) the login a kiosk tablet uses, put it in the "kiosks"
 * group, and link it to a kiosk ID so the backend knows which kiosk it is.
 *
 *   KIOSK_PASSWORD='a-long-password' npm run create-kiosk -- GK01
 *
 * The kiosk must already exist (run the seed script first). The password
 * comes from KIOSK_PASSWORD so it never lands in this repository. The
 * kiosk app signs in with  kiosk-gk01@linkage.local  and that password.
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { amplifyFields, loadOutputs, tableName } from './lib';

async function main() {
  const kioskId = process.argv[2];
  const password = process.env.KIOSK_PASSWORD;
  if (!/^[A-Z0-9]{4}$/.test(kioskId ?? '')) {
    throw new Error('Usage: KIOSK_PASSWORD=... npm run create-kiosk -- <KIOSK_ID, e.g. GK01>');
  }
  if (!password || password.length < 12) throw new Error('Set KIOSK_PASSWORD to at least 12 characters.');

  const outputs = loadOutputs();
  const region = outputs.auth.aws_region;
  const userPoolId = outputs.auth.user_pool_id;
  const cognito = new CognitoIdentityProviderClient({ region });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const kiosk = await doc.send(new GetCommand({ TableName: tableName(outputs, 'Kiosk'), Key: { id: kioskId } }));
  if (!kiosk.Item) throw new Error(`Kiosk ${kioskId} not found. Run the seed script first.`);
  const storeId = kiosk.Item.storeId as string;

  const email = `kiosk-${kioskId.toLowerCase()}@linkage.local`;
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: 'SUPPRESS', // no invitation email: the address is not real
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
      })
    );
  }
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true })
  );
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: 'kiosks' }));

  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  const sub = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error('Could not read the new user id (sub).');

  await doc.send(
    new PutCommand({
      TableName: tableName(outputs, 'KioskAccount'),
      Item: { id: sub, kioskId, storeId, ...amplifyFields('KioskAccount') },
    })
  );

  console.log(`Kiosk login ready: ${email} -> kiosk ${kioskId} (store ${storeId}).`);
  console.log('If the kiosk app was already signed in, sign out and in again.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
