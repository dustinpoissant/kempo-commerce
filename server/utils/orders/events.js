import db from 'kempo/server/db/index.js';
import { and, asc, eq } from 'drizzle-orm';
import { kempoCommerceEvent } from '../../db/schema.js';

/*
  The order's history. Append-only: nothing here updates or deletes a row. Every change to an order —
  by a customer, an administrator or another extension — is an event with who did it, and the admin
  and the customer pages both render it. The customer sees only the events marked `visible`.
*/

/* `handle` is `db` or a transaction, so an event can be written in the same transaction as the change it records. */
export const addEvent = async (handle, orderId, type, { actor = 'system', visible = false, data = {} } = {}) => {
  const [row] = await handle.insert(kempoCommerceEvent).values({
    orderId, type, actor: String(actor || 'system'), visible, data, createdAt: new Date(),
  }).returning();
  return row;
};

export const getOrderEvents = async (orderId, { customerVisibleOnly = false } = {}) => {
  if(!orderId) return [{ code: 400, msg: 'orderId is required' }, null];

  try {
    const where = customerVisibleOnly
      ? and(eq(kempoCommerceEvent.orderId, orderId), eq(kempoCommerceEvent.visible, true))
      : eq(kempoCommerceEvent.orderId, orderId);
    return [null, await db.select().from(kempoCommerceEvent).where(where).orderBy(asc(kempoCommerceEvent.id))];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to read the order history' }, null];
  }
};
