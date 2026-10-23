import { randomInt } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { kempoCommerceCounter, kempoCommerceOrder } from '../../db/schema.js';

const RANDOM_MIN = 10000000;
const RANDOM_MAX = 99999999;
const RANDOM_ATTEMPTS = 20;

/*
  The next order number, taken inside the transaction that creates the order.

  In order, the counter row is one conditional UPDATE, so two orders placed at once cannot get the same number, and an order that
  fails to be created rolls its number back with it: there are no gaps from failures.

  Random (the `order_number_random` setting), a number of 8 digits drawn with a cryptographic generator and checked against the
  orders already placed, so it neither repeats nor says how many orders there have been. If no free number is found in 20 tries (which
  only a shop with millions of orders could see) the next number in order is used. The unique index on the number is the
  last guard: two orders drawing the same free number in the same instant (about one in ninety million) make the later one fail
  to be placed, and the customer tries again.
*/
export const takeOrderNumber = async (tx, config) => {
  if(config.orderNumberRandom){
    for(let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++){
      const number = randomInt(RANDOM_MIN, RANDOM_MAX + 1);
      const [taken] = await tx.select({ id: kempoCommerceOrder.id }).from(kempoCommerceOrder).where(eq(kempoCommerceOrder.number, number)).limit(1);
      if(!taken) return number;
    }
  }

  await tx.insert(kempoCommerceCounter).values({ id: 'orders', value: Math.max(0, config.orderNumberStart - 1) }).onConflictDoNothing();
  const [row] = await tx.update(kempoCommerceCounter)
    .set({ value: sql`${kempoCommerceCounter.value} + 1` })
    .where(eq(kempoCommerceCounter.id, 'orders'))
    .returning({ value: kempoCommerceCounter.value });
  return row.value;
};

/* `#1042`, with the configured prefix and zero padding. */
export const formatOrderNumber = (number, config) => `${config.orderNumberPrefix}${String(number).padStart(config.orderNumberPadding, '0')}`;
