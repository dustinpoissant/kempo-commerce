import db from 'kempo/server/db/index.js';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { kempoCommerceOrder, kempoCommerceOrderLine, kempoCommerceTender, kempoCommerceCart } from '../../db/schema.js';
import { EVENTS, notify } from '../hooks.js';
import { addEvent } from '../orders/events.js';
import { assemble } from '../orders/read.js';
import { moveStatus } from '../orders/status.js';
import { decideFulfillment } from '../orders/fulfillment.js';
import { getTender } from './tenders.js';
import { setTenderStatus } from './unwind.js';
import { recordSale } from './tax.js';
import { grantOrderCredits } from './credits.js';

/*
  The order has been paid for: make it real. Called from the payment's webhook, from asking the
  processor when the browser comes back, from the recovery sweep, and directly by anything that took
  payment its own way.

  **Idempotent, and safe to run twice at once.** Every step is a conditional change, so a redelivered
  webhook, two tabs and the sweep can all arrive and the order is completed once:

    1. the order is claimed as paid, which only one caller can do, and an order that failed or was cancelled
       first (so its quantity went back) cannot be; then the credits its products give are granted;
    2. the card payment is checked with the processor's own record, never the browser's word;
    3. tenders are marked applied, the order marked paid, each line's fulfilment decided;
    4. the sale is recorded with kempo-tax;
    5. status goes to processing, or completed when there is nothing to fulfil, and `order:paid` fires.

  Returns `[null, { order }]`. A 409 with `expired: true` means the order had already failed or been
  cancelled, and its quantity returned, before the money arrived: the caller refunds the payment.
*/

const loadPayments = () => import('kempo-payments/sdk');

export const completeOrder = async (orderId, { actor = 'system' } = {}) => {
  try {
    let [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    if(['failed', 'cancelled'].includes(order.status)) return [{ code: 409, msg: `This order was ${order.status} before the payment arrived`, expired: true }, null];
    if(order.paidAt && order.status !== 'pending_payment') return [null, { order: await assemble(order), duplicate: true }];

    const tenders = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, orderId), inArray(kempoCommerceTender.status, ['pending', 'applied'])));

    /* The card's own record decides whether it was paid. */
    let captured = null;
    const card = tenders.find(tender => tender.kind === 'card');
    if(card){
      const payments = await loadPayments();
      const [paymentError, payment] = await payments.getPayment(card.reference);
      if(paymentError) return [paymentError, null];
      if(payment.status !== 'succeeded') return [{ code: 409, msg: 'The card payment has not completed', status: payment.status }, null];
      captured = payment.amountCaptured ?? card.amount;
    }

    /*
      Claiming the order as paid is the one step that decides between this and giving the quantity back:
      it only succeeds while the order is unpaid and not failed or cancelled, and giving the quantity back
      only follows the order becoming failed or cancelled. A run that crashed after claiming it finds the order
      already marked paid and goes on from here.
    */
    const [claimed] = await db.update(kempoCommerceOrder).set({ paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kempoCommerceOrder.id, orderId), isNull(kempoCommerceOrder.paidAt), inArray(kempoCommerceOrder.status, ['pending_payment', 'on_hold']))).returning();
    if(!claimed){
      const [current] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
      if(!current?.paidAt) return [{ code: 409, msg: 'This order was cancelled or failed before the payment arrived', expired: true }, null];
    }

    for(const tender of tenders){
      if(tender.status === 'pending') await setTenderStatus(tender.id, 'pending', 'applied', tender.kind === 'card' ? { amount: captured } : {});
    }
    const applied = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, orderId), eq(kempoCommerceTender.status, 'applied')));
    const paidTotal = applied.reduce((sum, tender) => sum + tender.amount, 0);

    const lines = await db.select().from(kempoCommerceOrderLine).where(eq(kempoCommerceOrderLine.orderId, orderId)).orderBy(asc(kempoCommerceOrderLine.position));
    for(const line of lines){
      if(line.fulfillment !== 'none') continue;
      const fulfillment = await decideFulfillment(order, line);
      await db.update(kempoCommerceOrderLine).set({ fulfillment }).where(eq(kempoCommerceOrderLine.id, line.id));
    }

    const [creditsError] = await grantOrderCredits(order, lines);
    if(creditsError){
      console.error(`[kempo-commerce] Could not grant the credits for order ${orderId}: ${creditsError.msg}`);
      await addEvent(db, orderId, 'credits_not_granted', { data: { error: creditsError.msg } });
    }

    const now = new Date();
    [order] = await db.update(kempoCommerceOrder)
      .set({ paidAt: order.paidAt ?? now, paidTotal, updatedAt: now })
      .where(eq(kempoCommerceOrder.id, orderId)).returning();

    if(order.taxCalculationId && !order.taxTransactionId){
      const [taxError, transactionId] = await recordSale({ calculationId: order.taxCalculationId, reference: order.id });
      if(taxError){
        console.error(`[kempo-commerce] Could not record the tax for order ${order.id}: ${taxError.msg}`);
        await addEvent(db, orderId, 'tax_not_recorded', { data: { error: taxError.msg } });
      } else if(transactionId){
        await db.update(kempoCommerceOrder).set({ taxTransactionId: transactionId }).where(eq(kempoCommerceOrder.id, orderId));
      }
    }

    const waiting = await db.select({ id: kempoCommerceOrderLine.id }).from(kempoCommerceOrderLine)
      .where(and(eq(kempoCommerceOrderLine.orderId, orderId), eq(kempoCommerceOrderLine.fulfillment, 'pending'))).limit(1);
    const wasPending = order.status === 'pending_payment' || order.status === 'on_hold';
    const [moveError, moved] = await moveStatus(orderId, waiting.length ? 'processing' : 'completed', { actor, paying: true });
    if(moveError){
      if(moveError.code !== 409) return [moveError, null];
      const [now] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
      if(now?.paidAt && now.status !== 'pending_payment') return [null, { order: await assemble(now), duplicate: true }];
      return [moveError, null];
    }

    if(moved.changed && wasPending){
      await addEvent(db, orderId, 'paid', { actor, visible: true, data: { paidTotal } });
      if(order.cartId){
        await db.update(kempoCommerceCart).set({ status: 'converted', updatedAt: new Date() })
          .where(and(eq(kempoCommerceCart.id, order.cartId), inArray(kempoCommerceCart.status, ['open', 'checkout'])));
      }
      await notify(EVENTS.orderPaid, { order: moved.order, tenders: moved.order.tenders, actor: actor === 'system' ? '' : actor });
      return [null, { order: moved.order }];
    }
    return [null, { order: moved.order, duplicate: !moved.changed }];
  } catch(error) {
    console.error(`[kempo-commerce] Could not complete order ${orderId}:`, error);
    return [{ code: 500, msg: 'Failed to complete the order' }, null];
  }
};

/*
  Marks an unpaid order paid by hand, for money taken some other way (cash, a transfer). The administrator's
  word, recorded as a tender of kind `manual`; it is completed exactly as for any other payment.
*/
export const markPaid = async (orderId, { actor = 'system', note = '' } = {}) => {
  try {
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    if(order.status !== 'pending_payment' && order.status !== 'on_hold') return [{ code: 409, msg: `A ${order.status.replace('_', ' ')} order cannot be marked paid` }, null];
    if(order.paidAt) return [{ code: 409, msg: 'This order is already paid' }, null];

    const open = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, orderId), inArray(kempoCommerceTender.status, ['pending', 'applied'])));
    for(const tender of open.filter(entry => entry.status === 'pending')){
      const definition = getTender(tender.kind);
      const [error] = definition ? await definition.reverse({ order, tender, userId: order.userId }) : [null];
      if(error) return [error, null];
      await setTenderStatus(tender.id, 'pending', 'reversed');
    }

    const covered = open.filter(entry => entry.status === 'applied').reduce((sum, tender) => sum + tender.amount, 0);
    const remaining = order.total - covered;
    if(remaining > 0){
      await db.insert(kempoCommerceTender).values({
        id: `tdr_manual_${orderId}`, orderId, kind: 'manual', amount: remaining, status: 'applied', reference: null,
        idempotencyKey: `order:${orderId}:manual`, detail: { note, markedBy: actor }, createdAt: new Date(), updatedAt: new Date(),
      }).onConflictDoNothing();
    }
    await addEvent(db, orderId, 'marked_paid', { actor, data: { note } });
    return completeOrder(orderId, { actor });
  } catch(error) {
    return [{ code: 500, msg: 'Failed to mark the order paid' }, null];
  }
};
