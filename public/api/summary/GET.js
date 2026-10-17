import db from 'kempo/server/db/index.js';
import { and, gte, inArray, sql } from 'drizzle-orm';
import { kempoCommerceOrder } from '../../../server/db/schema.js';
import { gate, refuse } from '../../../server/http/gate.js';
import { readCurrency } from '../../../server/utils/carts/catalog.js';

/* The dashboard widget's figures: orders and revenue today and this week, and what is waiting. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay.getTime() - 6 * 86400000);
  const paid = inArray(kempoCommerceOrder.status, ['processing', 'completed', 'on_hold']);
  const totals = since => db.select({ orders: sql`count(*)::int`, revenue: sql`coalesce(sum(${kempoCommerceOrder.paidTotal} - ${kempoCommerceOrder.refundedTotal}), 0)::bigint` })
    .from(kempoCommerceOrder).where(and(paid, gte(kempoCommerceOrder.paidAt, since)));
  const waiting = status => db.select({ count: sql`count(*)::int` }).from(kempoCommerceOrder).where(inArray(kempoCommerceOrder.status, status));

  const [[today], [week], [processing], [onHold], [pending]] = await Promise.all([totals(startOfDay), totals(startOfWeek), waiting(['processing']), waiting(['on_hold']), waiting(['pending_payment'])]);
  response.json({
    currency: await readCurrency(),
    today: { orders: today.orders, revenue: Number(today.revenue) },
    week: { orders: week.orders, revenue: Number(week.revenue) },
    processing: processing.count, onHold: onHold.count, pending: pending.count,
  });
};
