import db from 'kempo/server/db/index.js';
import { and, eq, inArray } from 'drizzle-orm';
import { kempoCommerceOrder, kempoCommerceTender, kempoCommerceCart } from '../../db/schema.js';
import { addEvent } from '../orders/events.js';
import { assemble } from '../orders/read.js';
import { moveStatus } from '../orders/status.js';
import { getTender } from './tenders.js';
import { returnStock } from './stock.js';

/*
  Undoing an order that was never paid: every tender it took is given back in reverse order, the order
  becomes `failed` (the payment did not happen or expired) or
  `cancelled` (somebody cancelled it), and only then is its quantity returned to the ledger, so an order that
  was paid in the meantime never loses its quantity. Every step is idempotent, so a crash halfway is finished by
  running it again, which is what the recovery sweep does.

  The one thing that stops it is a card payment that has already gone through: that order is paid, and
  the caller is told (`paid: true`) so it completes the order instead of throwing the money away.
*/

export const setTenderStatus = async (id, from, to, patch = {}) => {
  const [row] = await db.update(kempoCommerceTender)
    .set({ status: to, updatedAt: new Date(), ...patch })
    .where(and(eq(kempoCommerceTender.id, id), inArray(kempoCommerceTender.status, [from].flat())))
    .returning();
  return row ?? null;
};

export const unwindOrder = async (orderId, { to = 'failed', actor = 'system', reason = '' } = {}) => {
  try {
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    if(['failed', 'cancelled'].includes(order.status)){
      await returnStock(orderId);
      return [null, { order: await assemble(order), duplicate: true }];
    }
    if(order.paidAt) return [{ code: 409, msg: 'This order has been paid. Refund it instead of cancelling it.', paid: true }, null];
    if(order.status !== 'pending_payment' && order.status !== 'on_hold') return [{ code: 409, msg: `A ${order.status.replace('_', ' ')} order cannot be cancelled` }, null];

    const tenders = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, orderId), inArray(kempoCommerceTender.status, ['pending', 'applied'])));
    tenders.sort((a, b) => (getTender(b.kind)?.priority ?? 0) - (getTender(a.kind)?.priority ?? 0));

    for(const tender of tenders){
      const definition = getTender(tender.kind);
      if(!definition) return [{ code: 500, msg: `The "${tender.kind}" payment method is not available, so this order cannot be undone yet` }, null];
      const [error] = await definition.reverse({ order, tender, userId: order.userId });
      if(error){
        /* A card payment that went through is a paid order, not an unpaid one. */
        if(tender.kind === 'card' && error.code === 409) return [{ code: 409, msg: error.msg, paid: true }, null];
        return [error, null];
      }
      if(await setTenderStatus(tender.id, ['pending', 'applied'], 'reversed')){
        await addEvent(db, orderId, 'tender_reversed', { data: { kind: tender.kind, amount: tender.amount } });
      }
    }

    const [moveError, moved] = await moveStatus(orderId, to, { actor, reason, visible: true });
    if(moveError){
      const [current] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
      if(current?.paidAt) return [{ code: 409, msg: 'This order has been paid. Refund it instead of cancelling it.', paid: true }, null];
      return [moveError, null];
    }

    const [stockError] = await returnStock(orderId);
    if(stockError) console.error(`[kempo-commerce] Could not put the quantity of order ${orderId} back: ${stockError.msg}`);

    /* The cart goes back to being the customer's, so they can try again. */
    if(order.cartId){
      await db.update(kempoCommerceCart).set({ status: 'open' }).where(and(eq(kempoCommerceCart.id, order.cartId), eq(kempoCommerceCart.status, 'checkout')));
    }
    return [null, { order: moved.order }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to undo the order' }, null];
  }
};

/* Payment failed or ran out of time. */
export const failOrder = (orderId, reason = '') => unwindOrder(orderId, { to: 'failed', reason });

/* Cancelled before it was paid, by the customer or an administrator. */
export const cancelUnpaidOrder = (orderId, { actor = 'system', reason = '' } = {}) => unwindOrder(orderId, { to: 'cancelled', actor, reason });
