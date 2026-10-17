import db from 'kempo/server/db/index.js';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import {
  kempoCommerceOrder, kempoCommerceOrderLine, kempoCommerceOrderAdjustment, kempoCommerceTender, kempoCommerceNote, kempoCommerceRefund,
} from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import { formatOrderNumber } from './number.js';
import { sameSecret } from '../ids.js';

/*
  Reading orders. These are data operations: the routes decide who may see which.
*/

export const STATUSES = ['pending_payment', 'processing', 'completed', 'on_hold', 'cancelled', 'refunded', 'failed'];

/* The order with everything that belongs to it, in the shape both the admin and the customer pages use. */
export const assemble = async (order, { notes = false } = {}) => {
  const config = await readConfig();
  const [lines, adjustments, tenders, refunds] = await Promise.all([
    db.select().from(kempoCommerceOrderLine).where(eq(kempoCommerceOrderLine.orderId, order.id)).orderBy(asc(kempoCommerceOrderLine.position), asc(kempoCommerceOrderLine.id)),
    db.select().from(kempoCommerceOrderAdjustment).where(eq(kempoCommerceOrderAdjustment.orderId, order.id)).orderBy(asc(kempoCommerceOrderAdjustment.id)),
    db.select().from(kempoCommerceTender).where(eq(kempoCommerceTender.orderId, order.id)).orderBy(asc(kempoCommerceTender.createdAt)),
    db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.orderId, order.id)).orderBy(asc(kempoCommerceRefund.createdAt)),
  ]);
  const result = { ...order, numberLabel: formatOrderNumber(order.number, config), lines, adjustments, tenders, refunds };
  if(notes) result.notes = await db.select().from(kempoCommerceNote).where(eq(kempoCommerceNote.orderId, order.id)).orderBy(asc(kempoCommerceNote.createdAt));
  return result;
};

/* An order by its id, or its number (`1042` or `'#1042'`). */
export const getOrder = async (idOrNumber, { notes = false } = {}) => {
  if(idOrNumber === undefined || idOrNumber === null || idOrNumber === '') return [{ code: 400, msg: 'An order id or number is required' }, null];

  try {
    const text = String(idOrNumber);
    const digits = /^#?(\d+)$/.exec(text);
    const [order] = await db.select().from(kempoCommerceOrder).where(digits && !text.startsWith('ord_')
      ? eq(kempoCommerceOrder.number, Number(digits[1]))
      : eq(kempoCommerceOrder.id, text));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    return [null, await assemble(order, { notes })];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to read the order' }, null];
  }
};

/* A guest's order: the id and the key from their link, compared in constant time. A wrong key is the same 404 as no order. */
export const getOrderByKey = async (id, key) => {
  const [error, order] = await getOrder(id);
  if(error || !sameSecret(order.orderKey, key)) return [{ code: 404, msg: 'Order not found' }, null];
  return [null, order];
};

/* The orders list, newest first, searchable by number, email or the buyer's name. */
export const listOrders = async ({ userId, status, search, from, to, limit = 50, offset = 0 } = {}) => {
  try {
    const conditions = [];
    if(userId) conditions.push(eq(kempoCommerceOrder.userId, userId));
    if(status) conditions.push(inArray(kempoCommerceOrder.status, [status].flat()));
    if(from) conditions.push(gte(kempoCommerceOrder.placedAt, new Date(from)));
    if(to) conditions.push(lte(kempoCommerceOrder.placedAt, new Date(to)));
    if(search){
      const text = String(search).trim().replace(/^#/, '');
      const like = `%${text}%`;
      conditions.push(or(
        ilike(kempoCommerceOrder.email, like),
        ilike(sql`${kempoCommerceOrder.billing}->>'name'`, like),
        /^\d+$/.test(text) ? eq(kempoCommerceOrder.number, Number(text)) : sql`false`,
      ));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const config = await readConfig();
    const rows = await db.select().from(kempoCommerceOrder).where(where).orderBy(desc(kempoCommerceOrder.placedAt), desc(kempoCommerceOrder.number)).limit(take).offset(skip);
    const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCommerceOrder).where(where);
    return [null, { items: rows.map(order => ({ ...order, numberLabel: formatOrderNumber(order.number, config) })), total, limit: take, offset: skip }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to list the orders' }, null];
  }
};

/*
  What a customer is allowed to see of an order: no internal data, address of the buyer's connection or
  tax identifiers. The admin gets the whole order from getOrder.
*/
export const forCustomer = order => {
  const { ip, data, taxCalculationId, taxTransactionId, checkoutKey, cartId, ...rest } = order;
  return {
    ...rest,
    tenders: order.tenders?.map(({ idempotencyKey, reference, detail, ...tender }) => ({ ...tender, detail: { credits: detail?.credits } })),
    adjustments: order.adjustments?.map(({ data: adjustmentData, ...adjustment }) => adjustment),
    lines: order.lines?.map(({ data: lineData, ...line }) => line),
    refunds: order.refunds?.map(({ steps, issuedBy, ...refund }) => refund),
    notes: order.notes?.filter(note => note.visibleToCustomer).map(({ authorId, ...note }) => note),
  };
};
