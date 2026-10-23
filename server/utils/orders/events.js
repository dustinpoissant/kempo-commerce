import db from 'kempo/server/db/index.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { user } from 'kempo/server/db/schema.js';
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
    const events = await db.select().from(kempoCommerceEvent).where(where).orderBy(asc(kempoCommerceEvent.id));
    if(customerVisibleOnly) return [null, events];

    /* Staff see who did it by name; an actor that is not an account ('system', a payment id) is left as it is. */
    const ids = [...new Set(events.map(event => event.actor))];
    const names = new Map((ids.length ? await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : []).map(row => [row.id, row.name]));
    return [null, events.map(event => (names.has(event.actor) ? { ...event, actorName: names.get(event.actor) } : event))];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to read the order history' }, null];
  }
};
