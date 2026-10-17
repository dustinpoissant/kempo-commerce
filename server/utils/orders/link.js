import db from 'kempo/server/db/index.js';
import { and, isNull, sql } from 'drizzle-orm';
import { getUserById } from 'kempo/server/sdk.js';
import { kempoCommerceOrder } from '../../db/schema.js';
import { addEvent } from './events.js';

/*
  A guest's orders belong to an account once the person proves they own the email address. The guest
  typed the address at checkout; anyone can type anyone's, so attaching orders to whichever account
  has that email would hand a stranger the order history of someone else. Only a verified email is
  proof.

  Called when kempo says an email was verified (`user:email_verified`), and when a signed-in customer
  with an already verified email opens their orders. Idempotent: it only touches orders with no user.
*/
export const linkGuestOrders = async ({ userId, email = null }) => {
  try {
    const [userError, user] = await getUserById(userId);
    if(userError || !user.emailVerified) return [null, { linked: 0 }];
    const address = String(email || user.email).trim().toLowerCase();
    if(address !== String(user.email).trim().toLowerCase()) return [null, { linked: 0 }];

    const linked = await db.update(kempoCommerceOrder)
      .set({ userId, updatedAt: new Date() })
      .where(and(isNull(kempoCommerceOrder.userId), sql`lower(${kempoCommerceOrder.email}) = ${address}`))
      .returning({ id: kempoCommerceOrder.id });
    for(const { id } of linked) await addEvent(db, id, 'linked_to_account', { actor: userId, data: {} });
    return [null, { linked: linked.length }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to link the orders' }, null];
  }
};
