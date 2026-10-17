import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { group, groupPermission, permission } from 'kempo/server/db/schema.js';
import { createIndexes, ensureColumns } from './server/db/indexes.js';

/*
  What kempo-config.json cannot say.

  **The indexes**, which kempo's installer does not make from the schema — see server/db/indexes.js.
  The unique ones are correctness guarantees (one order per checkout, one number per order), so if one
  cannot be made the install fails.

  **`commerce:checkout` for every signed-in user, on the first install only.** Checking out is
  something an ordinary member of the site does, so the permission is given to `system:Users` — but
  only when this extension has never been installed here before. kempo runs this script before it
  creates the declared permissions, so a permission row that already exists means an earlier install
  left it behind, and a site that took the permission away from its users must not have it handed back
  by reinstalling. update.js never grants it. (A guest is not a user and needs no permission, which is
  governed by the `guest_checkout` setting.)
*/

const require = createRequire(import.meta.url);
const config = require('./kempo-config.json');
const CHECKOUT = 'commerce:checkout';

const grantCheckoutOnFirstInstall = async () => {
  const [existing] = await db.select().from(permission).where(eq(permission.name, CHECKOUT)).limit(1);
  if(existing) return false;

  const [users] = await db.select().from(group).where(eq(group.name, 'system:Users')).limit(1);
  if(!users){
    console.warn('[kempo-commerce] There is no system:Users group, so no signed-in user can check out until commerce:checkout is given to a group.');
    return false;
  }

  const description = config.permissions.find(entry => entry.name === CHECKOUT)?.description || null;
  await db.insert(permission).values({ name: CHECKOUT, description, owner: 'kempo-commerce', createdAt: new Date() }).onConflictDoNothing();
  const [granted] = await db.select().from(groupPermission).where(and(eq(groupPermission.groupName, 'system:Users'), eq(groupPermission.permissionName, CHECKOUT))).limit(1);
  if(!granted) await db.insert(groupPermission).values({ id: randomUUID(), groupName: 'system:Users', permissionName: CHECKOUT, createdAt: new Date() });
  return true;
};

export default async () => {
  await ensureColumns();
  await createIndexes();
  const granted = await grantCheckoutOnFirstInstall();

  console.log([
    '[kempo-commerce] Installed.',
    granted ? '  Every signed-in user can now check out.' : '  commerce:checkout was left as it was — this site has had kempo-commerce before.',
    '  Add a payment processor under Payments, and set the site address under Commerce settings so the links in emails work.',
    '  Existing sites need `npx drizzle-kit push` to add the scheduledJob table, or the order-expiry sweep will not run.',
  ].join('\n'));
};
