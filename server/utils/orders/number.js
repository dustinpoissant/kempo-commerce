import { eq, sql } from 'drizzle-orm';
import { kempoCommerceCounter } from '../../db/schema.js';

/*
  The next order number, taken inside the transaction that creates the order. The counter row is one
  conditional UPDATE, so two orders placed at once cannot get the same number, and an order that fails
  to be created rolls its number back with it: there are no gaps from failures.
*/
export const takeOrderNumber = async (tx, config) => {
  await tx.insert(kempoCommerceCounter).values({ id: 'orders', value: Math.max(0, config.orderNumberStart - 1) }).onConflictDoNothing();
  const [row] = await tx.update(kempoCommerceCounter)
    .set({ value: sql`${kempoCommerceCounter.value} + 1` })
    .where(eq(kempoCommerceCounter.id, 'orders'))
    .returning({ value: kempoCommerceCounter.value });
  return row.value;
};

/* `#1042`, with the configured prefix and zero padding. */
export const formatOrderNumber = (number, config) => `${config.orderNumberPrefix}${String(number).padStart(config.orderNumberPadding, '0')}`;
