import db from 'kempo/server/db/index.js';
import { eq } from 'drizzle-orm';
import { kempoCommerceOrder } from '../../db/schema.js';
import { addEvent } from './events.js';

/*
  Another extension's own part of an order: `order.data[key]`, which `data` is for. The shipping address is `data.shipping`, so
  kempo-shipping changes it here when staff correct it. The change and its history entry are written together, and the entry
  says who did it. Only that key is changed: everything else in `data` is left as it was.

    await setOrderData(order.id, 'shipping', address, { actor: userId, summary: 'Shipping address changed' });
*/
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;

export const setOrderData = async (orderId, key, value, { actor = 'system', summary = '', visible = false } = {}) => {
  if(typeof key !== 'string' || !KEY.test(key)) return [{ code: 400, msg: 'The key must be a short name made of letters, numbers, underscores and dashes' }, null];
  if(JSON.stringify(value ?? null).includes('\\u0000')) return [{ code: 400, msg: 'Values cannot contain null characters' }, null];

  try {
    const changed = await db.transaction(async tx => {
      const [order] = await tx.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId)).for('update');
      if(!order) return null;
      const [saved] = await tx.update(kempoCommerceOrder).set({ data: { ...(order.data ?? {}), [key]: value }, updatedAt: new Date() }).where(eq(kempoCommerceOrder.id, orderId)).returning();
      await addEvent(tx, orderId, 'order_data', { actor, visible, data: { key, summary: summary || `${key} changed` } });
      return saved;
    });
    return changed ? [null, changed.data] : [{ code: 404, msg: 'Order not found' }, null];
  } catch {
    return [{ code: 500, msg: 'Failed to change the order' }, null];
  }
};

/* A line in the order's history that is not a change, such as "Label bought". `visible` shows it to the customer. */
export const addOrderEvent = async (orderId, type, { actor = 'system', visible = false, data = {} } = {}) => {
  if(typeof type !== 'string' || !KEY.test(type)) return [{ code: 400, msg: 'The type must be a short name made of letters, numbers, underscores and dashes' }, null];
  try {
    const [order] = await db.select({ id: kempoCommerceOrder.id }).from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    return [null, await addEvent(db, orderId, type, { actor, visible, data })];
  } catch {
    return [{ code: 500, msg: 'Failed to add to the order history' }, null];
  }
};
