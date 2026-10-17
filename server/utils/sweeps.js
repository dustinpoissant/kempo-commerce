import db from 'kempo/server/db/index.js';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  kempoCommerceCart, kempoCommerceCartLine, kempoCommerceOrder, kempoCommerceTender,
} from '../db/schema.js';
import { readConfig } from './config/settings.js';
import { EVENTS, notify } from './hooks.js';
import { completeOrder } from './checkout/complete.js';
import { failOrder } from './checkout/unwind.js';
import { recordSale } from './checkout/tax.js';
import { pruneAttempts } from './checkout/abuse.js';

/*
  The recovery sweep, run every minute by kempo's scheduler (see jobs/sweep.js) and safe to run any
  time, from any number of processes: each thing it does is a conditional change.

  - **Orders that ran out of time.** A `pending_payment` order older than `pending_expiry_minutes`
    asks the processor first (a webhook may have been missed and the customer may have paid); if it
    was paid the order is completed, and otherwise everything is given back and the order fails.
  - **Orders that were paid but never finished.** A crash between taking the money and finishing the
    order is completed here.
  - **Tax that was not recorded.**
  - **Carts** nobody touched are marked abandoned, and abandoned ones are eventually deleted.
  - **Old checkout attempts**, which only matter for the rate limits.
*/

const BATCH = 50;

const loadPayments = () => import('kempo-payments/sdk');

/* Asks the processor what happened to an order's card payment, which fires `payment:succeeded` if it was missed. */
const syncCard = async order => {
  const [card] = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, order.id), eq(kempoCommerceTender.kind, 'card')));
  if(!card?.reference) return;
  try {
    const payments = await loadPayments();
    await payments.syncPayment(card.reference);
  } catch(error) {
    console.error(`[kempo-commerce] Could not sync the payment for order ${order.id}:`, error);
  }
};

export const runSweep = async ({ now = new Date() } = {}) => {
  const config = await readConfig();
  const done = { failed: 0, completed: 0, abandoned: 0, purged: 0, tax: 0 };

  /* Orders that ran out of time. */
  const expired = await db.select().from(kempoCommerceOrder).where(and(
    eq(kempoCommerceOrder.status, 'pending_payment'),
    lt(kempoCommerceOrder.placedAt, new Date(now.getTime() - config.pendingExpiryMinutes * 60000)),
  )).limit(BATCH);
  for(const order of expired){
    await syncCard(order);
    const [fresh] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, order.id));
    if(fresh.status !== 'pending_payment') continue;
    const [error, result] = await failOrder(order.id, 'The payment did not arrive in time');
    if(error?.paid){
      const [completeError] = await completeOrder(order.id, { actor: 'system' });
      if(!completeError) done.completed++;
    } else if(!error && !result.duplicate){
      done.failed++;
    }
  }

  /* Paid, but the process died before it finished. */
  const stalled = await db.select().from(kempoCommerceOrder).where(and(
    eq(kempoCommerceOrder.status, 'pending_payment'),
    isNotNull(kempoCommerceOrder.paidAt),
    lt(kempoCommerceOrder.updatedAt, new Date(now.getTime() - 60000)),
  )).limit(BATCH);
  for(const order of stalled){
    const [error] = await completeOrder(order.id, { actor: 'system' });
    if(!error) done.completed++;
  }

  /* Tax for sales that were paid but not recorded. */
  const untaxed = await db.select().from(kempoCommerceOrder).where(and(
    isNotNull(kempoCommerceOrder.taxCalculationId), isNull(kempoCommerceOrder.taxTransactionId), isNotNull(kempoCommerceOrder.paidAt),
    inArray(kempoCommerceOrder.status, ['processing', 'completed', 'on_hold']),
  )).limit(BATCH);
  for(const order of untaxed){
    const [error, transactionId] = await recordSale({ calculationId: order.taxCalculationId, reference: order.id });
    if(!error && transactionId){
      await db.update(kempoCommerceOrder).set({ taxTransactionId: transactionId }).where(eq(kempoCommerceOrder.id, order.id));
      done.tax++;
    }
  }

  /* Carts nobody touched. */
  const stale = await db.select().from(kempoCommerceCart).where(and(eq(kempoCommerceCart.status, 'open'), lt(kempoCommerceCart.expiresAt, now))).limit(BATCH);
  for(const cart of stale){
    const [row] = await db.update(kempoCommerceCart).set({ status: 'abandoned', updatedAt: now })
      .where(and(eq(kempoCommerceCart.id, cart.id), eq(kempoCommerceCart.status, 'open'))).returning();
    if(row){
      done.abandoned++;
      await notify(EVENTS.cartExpired, { cart: row });
    }
  }
  const purgeBefore = new Date(now.getTime() - config.cartPurgeDays * 86400000);
  const old = await db.select({ id: kempoCommerceCart.id }).from(kempoCommerceCart)
    .where(and(inArray(kempoCommerceCart.status, ['abandoned', 'merged']), lt(kempoCommerceCart.updatedAt, purgeBefore))).limit(BATCH);
  if(old.length){
    const ids = old.map(cart => cart.id);
    await db.delete(kempoCommerceCartLine).where(inArray(kempoCommerceCartLine.cartId, ids));
    await db.delete(kempoCommerceCart).where(inArray(kempoCommerceCart.id, ids));
    done.purged = ids.length;
  }

  await pruneAttempts();
  return done;
};
