import db from 'kempo/server/db/index.js';
import { and, eq } from 'drizzle-orm';
import { kempoCommerceOrder, kempoCommerceRefund, kempoCommerceTender } from '../../db/schema.js';
import { addEvent } from '../orders/events.js';
import { assemble } from '../orders/read.js';
import { notifyAdmins } from '../orders/emails.js';
import { formatOrderNumber } from '../orders/number.js';
import { readConfig } from '../config/settings.js';
import { completeOrder } from './complete.js';
import { failOrder } from './unwind.js';
import { recordDecline } from './abuse.js';
import { setTenderStatus } from './unwind.js';

/*
  What the payment processor's events mean for an order. kempo-payments fires its hooks from the
  processor's signed webhook (and from asking the processor), never from the browser, so these are the
  moments the order learns, for certain, what happened to its money.

  Only payments this extension made are looked at: `owner` is `kempo-commerce` and `reference` is the
  order id.
*/

const OWNER = 'kempo-commerce';
const loadPayments = () => import('kempo-payments/sdk');

const orderFor = async payment => {
  if(payment?.owner !== OWNER || !payment.reference) return null;
  const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, payment.reference));
  return order ?? null;
};

/*
  The money arrived. Completes the order. If the order had already failed or expired, or its quantity had
  gone back on sale, the customer has paid for something that cannot be delivered: the payment is
  refunded in full straight away, the order says so, and the shop is told.
*/
export const onPaymentSucceeded = async payment => {
  const order = await orderFor(payment);
  if(!order) return;

  const [error] = await completeOrder(order.id, { actor: 'payment' });
  if(!error) return;
  if(!error.expired){
    console.error(`[kempo-commerce] Could not complete order ${order.id} after its payment succeeded: ${error.msg}`);
    return;
  }

  const payments = await loadPayments();
  const [refundError] = await payments.refundPayment(payment.id, { reason: 'The order had expired before the payment arrived', issuedBy: null, idempotencyKey: `late-payment:${payment.id}` });
  const config = await readConfig();
  const label = formatOrderNumber(order.number, config);
  await addEvent(db, order.id, refundError ? 'late_payment_unrefunded' : 'late_payment_refunded', { visible: true, data: { paymentId: payment.id, amount: payment.amountCaptured, ...(refundError ? { error: refundError.msg } : {}) } });
  if(!refundError){
    const [card] = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, order.id), eq(kempoCommerceTender.kind, 'card')));
    if(card) await db.update(kempoCommerceTender).set({ status: 'refunded', refundedAmount: payment.amountCaptured, updatedAt: new Date() }).where(eq(kempoCommerceTender.id, card.id));
  }
  await notifyAdmins({
    title: refundError ? `A payment arrived for expired order ${label} and could not be refunded` : `A payment arrived for expired order ${label} and was refunded`,
    message: refundError ? `Refund it by hand in the payments screen: ${refundError.msg}` : 'The customer was charged after the order expired, so the payment was refunded in full automatically.',
    level: refundError ? 'error' : 'warning', orderId: order.id, dedupeKey: `late-payment:${payment.id}`,
  });
};

/*
  A card was declined. Counted towards the cool-down; if this puts the account or address over the
  limit, the payment is cancelled at the processor so no more cards can be tried against it from the
  browser, and the order fails.
*/
export const onPaymentFailed = async payment => {
  const order = await orderFor(payment);
  if(!order || order.status !== 'pending_payment') return;

  const over = await recordDecline({ userId: order.userId, ip: order.ip, email: order.email });
  if(!over) return;

  const payments = await loadPayments();
  await payments.cancelPayment(payment.id);
  await failOrder(order.id, 'Too many declined payments');
};

/* The payment was cancelled by someone other than this extension (we mark our own tenders reversed first). */
export const onPaymentCanceled = async payment => {
  const order = await orderFor(payment);
  if(!order || order.status !== 'pending_payment') return;
  const [tender] = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, order.id), eq(kempoCommerceTender.reference, payment.id)));
  if(tender?.status === 'reversed') return;
  await failOrder(order.id, 'The payment was canceled');
};

/* A refund made in the processor's own dashboard, or by a chargeback. Recorded and flagged, never acted on. */
export const onPaymentRefunded = async (payment, refund) => {
  const order = await orderFor(payment);
  if(!order) return;

  const [issuing] = await db.select().from(kempoCommerceRefund).where(and(eq(kempoCommerceRefund.orderId, order.id), eq(kempoCommerceRefund.status, 'issuing')));
  if(issuing) return;
  const known = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.orderId, order.id));
  const accounted = known.flatMap(entry => entry.tenders).filter(entry => entry.kind === 'card').reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  const outside = payment.amountRefunded - accounted;
  if(outside <= 0) return;

  await addEvent(db, order.id, 'refund_outside', { visible: false, data: { paymentId: payment.id, amount: refund?.amount ?? outside } });
  const label = formatOrderNumber(order.number, await readConfig());
  await notifyAdmins({
    title: `Order ${label} was refunded outside the shop`, message: `${outside} was refunded from the payment in the processor's dashboard. Nothing was changed on the order: refund it here too if the goods came back.`,
    level: 'warning', orderId: order.id, dedupeKey: `refund-outside:${payment.id}:${payment.amountRefunded}`,
  });
};

export const onPaymentDisputed = async (payment, disputed, reason) => {
  const order = await orderFor(payment);
  if(!order) return;
  await addEvent(db, order.id, disputed ? 'dispute_opened' : 'dispute_closed', { visible: false, data: { paymentId: payment.id, reason: reason ?? null } });
  const label = formatOrderNumber(order.number, await readConfig());
  await notifyAdmins({
    title: disputed ? `Order ${label} was disputed` : `The dispute on order ${label} was closed`,
    message: disputed ? `The customer's bank opened a chargeback${reason ? ` (${reason})` : ''}. Answer it in the processor's dashboard; nothing was changed on the order.` : 'It may have been won. Nothing was changed on the order.',
    level: disputed ? 'error' : 'info', orderId: order.id, dedupeKey: `dispute:${payment.id}:${disputed}`,
  });
};

export { setTenderStatus, assemble };
