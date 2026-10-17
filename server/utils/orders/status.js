import db from 'kempo/server/db/index.js';
import { and, eq } from 'drizzle-orm';
import { kempoCommerceOrder } from '../../db/schema.js';
import { EVENTS, guard, notify } from '../hooks.js';
import { addEvent } from './events.js';
import { assemble } from './read.js';
import { sendStatusEmail } from './emails.js';

/*
  The order's status machine. Seven statuses, WooCommerce's:

    pending_payment   exists, quantity is held, payment has not completed. Expires, then becomes failed.
    processing        paid, with something still to fulfil.
    completed         paid and every line fulfilled or needing none. A credit pack goes straight here.
    on_hold           paused by an administrator or an extension.
    cancelled         cancelled before it was paid. Terminal.
    refunded          refunded in full. Terminal. A partial refund keeps the status.
    failed            payment failed or expired. Terminal.

  Extensions can add their own sub-state in `order.data`; they cannot add statuses, because every
  screen, report and hook listener depends on this list.

  Every change goes through `moveStatus`, which checks the move, makes it with a compare-and-set so two
  callers cannot both win, writes the event, and fires the hooks. Money moves elsewhere (checkout,
  refunds); this only records where the order stands.
*/

const GRAPH = {
  pending_payment: ['processing', 'completed', 'on_hold', 'cancelled', 'failed'],
  processing: ['completed', 'on_hold', 'refunded'],
  completed: ['processing', 'refunded'],
  on_hold: ['pending_payment', 'processing', 'completed', 'cancelled', 'failed', 'refunded'],
  cancelled: [],
  refunded: [],
  failed: [],
};

/* An order that has not been paid can only be cancelled or failed; one that has can only go on, never back to unpaid. */
const UNPAID_TARGETS = ['pending_payment', 'on_hold', 'cancelled', 'failed'];
const PAID_TARGETS = ['processing', 'completed', 'on_hold', 'refunded'];

export const canMove = (order, to) => {
  if(!(GRAPH[order.status] || []).includes(to)) return false;
  return (order.paidAt ? PAID_TARGETS : UNPAID_TARGETS).includes(to);
};

/*
  Moves an order to a status. `paying` is for the code that has just taken the money (completeOrder),
  the only caller allowed to take an unpaid order to processing or completed.
*/
export const moveStatus = async (orderId, to, { actor = 'system', note = '', paying = false, visible = true, reason = '' } = {}) => {
  try {
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    if(order.status === to) return [null, { order: await assemble(order), changed: false }];

    const allowed = (GRAPH[order.status] || []).includes(to)
      && (paying ? ['processing', 'completed'].includes(to) : (order.paidAt ? PAID_TARGETS : UNPAID_TARGETS).includes(to));
    if(!allowed) return [{ code: 409, msg: `An order that is ${order.status.replace('_', ' ')} cannot become ${to.replace('_', ' ')}` }, null];

    const refused = await guard(EVENTS.orderBeforeStatus, { order, from: order.status, to, actor });
    if(refused) return [refused, null];

    const now = new Date();
    const changes = { status: to, updatedAt: now };
    if(to === 'completed') changes.completedAt = now;
    if(to === 'cancelled') changes.cancelledAt = now;
    if(order.status === 'completed' && to === 'processing') changes.completedAt = null;

    const updated = await db.transaction(async tx => {
      const [row] = await tx.update(kempoCommerceOrder).set(changes)
        .where(and(eq(kempoCommerceOrder.id, orderId), eq(kempoCommerceOrder.status, order.status))).returning();
      if(!row) return null;
      await addEvent(tx, orderId, 'status', { actor, visible, data: { from: order.status, to, ...(note ? { note } : {}), ...(reason ? { reason } : {}) } });
      return row;
    });
    if(!updated) return [{ code: 409, msg: 'The order changed while this was happening; try again' }, null];

    const full = await assemble(updated);
    await notify(EVENTS.orderStatusChanged, { order: full, from: order.status, to, actor: actor === 'system' ? '' : actor });
    if(to === 'cancelled') await notify(EVENTS.orderCancelled, { order: full, actor, reason: reason || note });
    if(to === 'failed') await notify(EVENTS.orderFailed, { order: full, reason: reason || note });
    await sendStatusEmail(full, order.status, to);
    return [null, { order: full, changed: true }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to change the order status' }, null];
  }
};

/*
  The status changes a person or an extension may ask for directly: pausing an order, resuming it, and
  marking a paid order processing or completed. Cancelling, failing and refunding move money, so they
  have their own functions; an unpaid order is paid by `markPaid`.
*/
export const setOrderStatus = async (id, status, { actor = '', note = '' } = {}) => {
  if(!['processing', 'completed', 'on_hold', 'pending_payment'].includes(status)){
    const hint = { cancelled: 'Use cancelUnpaidOrder (before it is paid) or refundOrder', refunded: 'Use refundOrder', failed: 'Use failOrder' }[status];
    return [{ code: 409, msg: hint ? `${hint}, which also deal with the money` : `"${status}" is not a status an order can be set to` }, null];
  }
  const [error, result] = await moveStatus(id, status, { actor: actor || 'system', note });
  return error ? [error, null] : [null, result.order];
};
