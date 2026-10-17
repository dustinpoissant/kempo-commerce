import db from 'kempo/server/db/index.js';
import { asc, eq } from 'drizzle-orm';
import { addLedgerEntry } from 'kempo-products/sdk';
import { kempoCommerceOrderLine } from '../../db/schema.js';

/*
  An order's quantity, in kempo-products' ledger. Placing the order takes it (one entry, every line or
  none) under the ref `order:<id>`, and giving it back is the entry that undoes that one. Each ref is
  used once, so running either again, as the recovery sweep does, changes nothing the second time.
*/

const ACTOR = 'kempo-commerce';

export const takeStock = ({ orderId, lines, userId = '' }) => addLedgerEntry({
  ref: `order:${orderId}`,
  reason: 'sale',
  note: `Order ${orderId}`,
  lines: lines.map(line => ({ productId: line.productId, change: -line.quantity, options: line.selections ?? {} })),
  actor: ACTOR,
  userId,
});

/* Puts the order's quantity back. `lines` is given when the order row does not exist yet; otherwise they are read from it. */
export const returnStock = async (orderId, lines) => {
  const rows = lines ?? await db.select().from(kempoCommerceOrderLine).where(eq(kempoCommerceOrderLine.orderId, orderId)).orderBy(asc(kempoCommerceOrderLine.position));
  if(!rows.length) return [null, null];
  return addLedgerEntry({
    ref: `order:${orderId}:return`,
    undoes: `order:${orderId}`,
    reason: 'return',
    note: `Order ${orderId} was not completed`,
    lines: rows.map(line => ({ productId: line.productId, change: line.quantity })),
    actor: ACTOR,
  });
};
