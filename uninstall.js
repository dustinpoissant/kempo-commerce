import { inArray, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoCommerceOrder } from './server/db/schema.js';

/*
  Nothing here is deleted. Uninstalling without purging leaves every table in place, so reinstalling
  restores every order exactly; purging drops them, and that is kempo's decision to make, not this
  script's.

  What this does is say what is at stake, because there is no undo. Orders that are paid but not yet
  fulfilled, and orders waiting for a payment, are promises to customers; removing this extension does
  not make them go away, it only removes the record of them.
*/
export default async () => {
  try {
    const [row] = await db.select({
      open: sql`count(*)::int`,
    }).from(kempoCommerceOrder).where(inArray(kempoCommerceOrder.status, ['pending_payment', 'processing', 'on_hold']));

    console.log(`[kempo-commerce] Removing. ${row?.open || 0} order${row?.open === 1 ? ' is' : 's are'} still open (waiting for payment, processing or on hold).`);
    if(row?.open){
      console.warn('[kempo-commerce] Purging the data deletes the only record of those orders — fulfil or refund them, or export them, first.');
    }
  } catch {
    // The tables may already be gone; there is nothing to report on.
  }
};
