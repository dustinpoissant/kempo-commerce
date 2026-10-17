import db from 'kempo/server/db/index.js';
import { desc, eq } from 'drizzle-orm';
import { user } from 'kempo/server/db/schema.js';
import { kempoCommerceOrder } from '../../db/schema.js';
import { fitToLists } from './regions.js';

/*
  What the checkout form can start with for a signed-in customer, so they do not type what the shop
  already knows: their name and email from the account, and the phone and address from the last order
  they placed. The account wins for name and email (an order can have been a gift for someone else).
  Nothing is ever required of what comes back, and a guest has none. A failure gives an empty answer
  rather than an error: a form that starts blank is the worst outcome, not a broken checkout.
*/

const FROM_LAST_ORDER = ['phone', 'line1', 'line2', 'city', 'state', 'postalCode', 'country'];

const text = value => typeof value === 'string' ? value.trim() : '';

export default async ({ userId } = {}) => {
  if(!userId) return [null, {}];

  try {
    const [account] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
    const [last] = await db.select({ billing: kempoCommerceOrder.billing }).from(kempoCommerceOrder)
      .where(eq(kempoCommerceOrder.userId, userId))
      .orderBy(desc(kempoCommerceOrder.placedAt))
      .limit(1);

    const prefill = {};
    if(text(account?.name)) prefill.name = text(account.name);
    if(text(account?.email)) prefill.email = text(account.email);
    for(const field of FROM_LAST_ORDER){
      const value = text(last?.billing?.[field]);
      if(value) prefill[field] = value;
    }
    return [null, fitToLists(prefill)];
  } catch {
    return [null, {}];
  }
};
