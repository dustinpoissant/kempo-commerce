import db from 'kempo/server/db/index.js';
import { and, eq, ne } from 'drizzle-orm';
import { kempoCommerceOrder, kempoCommerceOrderLine } from '../../db/schema.js';
import { EVENTS, guard, notify } from '../hooks.js';
import { addEvent } from './events.js';
import { assemble } from './read.js';
import { moveStatus } from './status.js';

/*
  Each line is `none` (nothing to send or deliver), `pending` or `done`. Commerce changes it only
  through `setLineFulfillment`, called by whatever fulfils: shipping, digital delivery, or an
  administrator ticking a box. The order becomes `completed` when no line is `pending`, and goes back
  to `processing` if a line is reopened. Commerce itself does nothing physical.
*/

/*
  What a line needs, decided when the order is paid: a product that gives nothing but credits has
  nothing to deliver; everything else is `pending` until something marks it done. Extensions override
  it per line through the `order:line_fulfillment` guard (shipping sets `pending` for physical
  products and `none` for downloads).
*/
export const decideFulfillment = async (order, line) => {
  const fulfillment = { value: line.creditsOnly ? 'none' : 'pending', data: {} };
  const refused = await guard(EVENTS.orderLineFulfillment, { order, line, fulfillment });
  if(refused) return 'pending';
  return ['none', 'pending', 'done'].includes(fulfillment.value) ? fulfillment.value : 'pending';
};

/* After any change to a line, an order that is paid settles into processing or completed to match. */
export const settleOrder = async (orderId, actor = 'system') => {
  const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
  if(!order || !order.paidAt || !['processing', 'completed'].includes(order.status)) return;
  const [waiting] = await db.select({ id: kempoCommerceOrderLine.id }).from(kempoCommerceOrderLine)
    .where(and(eq(kempoCommerceOrderLine.orderId, orderId), eq(kempoCommerceOrderLine.fulfillment, 'pending'))).limit(1);
  const target = waiting ? 'processing' : 'completed';
  if(order.status !== target) await moveStatus(orderId, target, { actor });
};

export const setLineFulfillment = async (orderId, lineId, fulfillment, { actor = '', data = {} } = {}) => {
  if(!['pending', 'done'].includes(fulfillment)) return [{ code: 400, msg: 'Fulfilment is pending or done' }, null];

  try {
    const [line] = await db.select().from(kempoCommerceOrderLine).where(and(eq(kempoCommerceOrderLine.id, lineId), eq(kempoCommerceOrderLine.orderId, orderId)));
    if(!line) return [{ code: 404, msg: 'That line is not on this order' }, null];
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order.paidAt) return [{ code: 409, msg: 'An order that has not been paid cannot be fulfilled' }, null];
    if(['cancelled', 'refunded', 'failed'].includes(order.status)) return [{ code: 409, msg: `A ${order.status} order cannot be fulfilled` }, null];

    if(line.fulfillment !== fulfillment){
      await db.transaction(async tx => {
        const [row] = await tx.update(kempoCommerceOrderLine).set({ fulfillment, data: { ...line.data, ...data } })
          .where(and(eq(kempoCommerceOrderLine.id, lineId), ne(kempoCommerceOrderLine.fulfillment, fulfillment))).returning();
        if(row) await addEvent(tx, orderId, 'fulfillment', { actor: actor || 'system', visible: true, data: { lineId, name: line.name, from: line.fulfillment, to: fulfillment, ...(data.shipmentId ? { shipmentId: data.shipmentId } : {}) } });
      });
      await settleOrder(orderId, actor || 'system');
    }

    const [fresh] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    const full = await assemble(fresh);
    if(line.fulfillment !== fulfillment) await notify(EVENTS.orderFulfillmentChanged, { order: full, line: full.lines.find(candidate => candidate.id === lineId), previous: line.fulfillment, actor });
    return [null, full];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to update the fulfilment' }, null];
  }
};
