import path from 'path';
import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import { createHook, clearHandlerCache } from 'kempo/server/sdk.js';
import { hook } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart, getCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { previewRefund } from '../server/utils/refunds/preview.js';
import { resolveUnitDiscounts, resolveDiscountRows } from '../server/utils/discounts.js';
import { EVENTS } from '../server/utils/events.js';

/*
  How discounts from other extensions combine on a line: fixed amounts first, then the added percents, the best
  standalone discount against the combination, the minimum price as a floor, and that a refund of a discounted
  line returns what was paid for it. The arithmetic is proved on its own, then through a real cart, order and refund.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'kempo-commerce-discounts-fixture';
const BILLING = { name: 'Fixture Buyer', email: 'fixture@example.test', line1: '1 Test St' };

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const listen = async () => {
  ok(await createHook({ owner: OWNER, event: EVENTS.totalsDiscounts, callback: path.join(root, 'tests', 'fixtures', 'hooks', 'discounts.js') }));
  clearHandlerCache();
};

const stopListening = async () => {
  await db.delete(hook).where(eq(hook.owner, OWNER));
  clearHandlerCache();
};

const cartWith = async (product, quantity = 1) => {
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: product.id, quantity }));
  return cart.id;
};

const fixed = (value, stackable = true) => ({ kind: 'fixed', value, stackable });
const percent = (value, stackable = true) => ({ kind: 'percent', value, stackable });
const total = discounts => resolveUnitDiscounts({ unitPrice: 5000, discounts }).total;

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  await stopListening();
  installFakeCard();
};

export const afterAll = async () => {
  await stopListening();
  restoreCard();
  await purge();
};

export default {
  'a fixed amount comes off first, then the added percents come off what is left': async ({ pass, fail }) => {
    const { amounts, total: all, limited } = resolveUnitDiscounts({ unitPrice: 5000, discounts: [percent(25), fixed(1000), percent(10)] });
    if(all !== 2400 || limited) return fail(`total ${all}`);
    if(amounts[1] !== 1000) return fail(`the fixed amount ${amounts[1]}`);
    if(amounts[0] + amounts[2] !== 1400) return fail(`the percents ${amounts[0]} + ${amounts[2]}`);
    pass('a $50 car with $10 off, then 25% and 10%, is $26');
  },

  'one discount alone, whatever its kind': async ({ pass, fail }) => {
    if(total([fixed(1000)]) !== 1000) return fail('a lone fixed amount');
    if(total([percent(20)]) !== 1000) return fail('a lone percent');
    if(total([fixed(9000)]) !== 5000) return fail('a fixed amount larger than the price takes all of it, no more');
    if(total([percent(100)]) !== 5000) return fail('100%');
    if(total([percent(70), percent(70)]) !== 5000) return fail('percents past 100 stop at the price');
    pass('');
  },

  'a discount that cannot be combined applies alone, and the better of that and the combination wins': async ({ pass, fail }) => {
    if(total([percent(30, false), fixed(500), percent(10)]) !== 1500) return fail('the exclusive 30% beats $5 and 10% together');
    if(total([percent(10, false), fixed(1000), percent(10)]) !== 1400) return fail('the combination beats the exclusive 10%');
    if(total([percent(10, false), percent(20, false)]) !== 1000) return fail('two exclusive ones: the larger');
    const { amounts } = resolveUnitDiscounts({ unitPrice: 5000, discounts: [percent(30, false), fixed(500), percent(10)] });
    if(amounts[1] !== 0 || amounts[2] !== 0) return fail('the combinable ones take nothing when the exclusive one wins');
    pass('');
  },

  'percents round down and the rows add up to the whole': async ({ pass, fail }) => {
    const { amounts, total: all } = resolveUnitDiscounts({ unitPrice: 999, discounts: [percent(33), percent(33), percent(33)] });
    if(all !== Math.floor(999 * 99 / 100)) return fail(`total ${all}`);
    if(amounts.reduce((sum, amount) => sum + amount, 0) !== all) return fail('the rows do not add up');
    if(resolveUnitDiscounts({ unitPrice: 999, discounts: [percent(10)] }).total !== 99) return fail('10% of $9.99 is 99 cents, never 100');
    pass('');
  },

  'the minimum price is a floor, and says when it held a discount back': async ({ pass, fail }) => {
    const held = resolveUnitDiscounts({ unitPrice: 2500, minimumPrice: 500, discounts: [fixed(1000), percent(90)] });
    if(held.total !== 2000 || !held.limited) return fail(`held ${JSON.stringify(held)}`);
    const free = resolveUnitDiscounts({ unitPrice: 2500, minimumPrice: 500, discounts: [percent(10)] });
    if(free.total !== 250 || free.limited) return fail(`not held ${JSON.stringify(free)}`);
    const under = resolveUnitDiscounts({ unitPrice: 400, minimumPrice: 500, discounts: [percent(50)] });
    if(under.total !== 0) return fail('a price already under its minimum is not discounted, and not raised');
    pass('a $25 car with a $5 minimum never sells under $5');
  },

  'rows that say what they are get amounts per line, the rest are left alone': async ({ pass, fail }) => {
    const lines = [{ id: 'a', unitPrice: 5000, quantity: 2, minimumPrice: null }, { id: 'b', unitPrice: 1000, quantity: 1, minimumPrice: 900 }];
    const rows = resolveDiscountRows({
      lines,
      adjustments: [
        { type: 'fee', label: 'Shipping', amount: 700 },
        { type: 'discount', label: 'Old style', amount: 50, lineId: 'a' },
        { type: 'discount', label: 'Sale', lineId: 'a', data: { kind: 'fixed', value: 1000, stackable: true } },
        { type: 'discount', label: 'Sale', lineId: 'b', data: { kind: 'percent', value: 50, stackable: true } },
        { type: 'discount', label: 'No line', data: { kind: 'percent', value: 50, stackable: true } },
      ],
    });
    if(rows.length !== 4) return fail(`rows ${rows.length}`);
    if(rows.find(row => row.label === 'Old style').amount !== 50) return fail('an old-style row changed');
    const [sale] = rows.filter(row => row.lineId === 'a' && row.label === 'Sale');
    if(sale.amount !== 2000) return fail(`the line's amount is per unit times quantity: ${sale.amount}`);
    const held = rows.find(row => row.lineId === 'b');
    if(held.amount !== 100 || held.data.limited !== true) return fail(`the floor: ${JSON.stringify(held)}`);
    pass('');
  },

  'through a real cart, order and refund: discounts stack on the line, and a refund returns what was paid': async ({ pass, fail }) => {
    await listen();
    try {
      const item = await makeProduct({ price: 5000, minimumPrice: 3000, quantity: 5 });
      const cartId = await cartWith(item, 2);
      const cart = ok(await getCart({ cartId }));
      const rows = cart.adjustments.filter(adjustment => adjustment.type === 'discount');
      /* $50 less $10, then 35% of $40, is $26, but the minimum is $30: $20 off a unit, so the last row (the promo) is trimmed to nothing and dropped. */
      if(rows.length !== 2) return fail(`discount rows ${rows.length}`);
      if(cart.totals.discountTotal !== -4000 || cart.totals.total !== 6000) return fail(`totals ${JSON.stringify(cart.totals)}`);
      if(!rows.every(row => row.data.limited === true)) return fail('the cart is not told the minimum price held the discount back');

      const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING, expectedTotal: 6000 }));
      if(order.total !== 6000 || order.discountTotal !== -4000) return fail(`order ${order.total} ${order.discountTotal}`);
      await succeed(payment.id);
      ok(await completeOrder(order.id));

      const one = ok(await previewRefund({ orderId: order.id, lines: { [order.lines[0].id]: 1 } }));
      if(one.amount !== 3000) return fail(`one unit refunds ${one.amount}, not what was paid for it (3000)`);
      const both = ok(await previewRefund({ orderId: order.id, lines: { [order.lines[0].id]: 2 } }));
      if(both.amount !== 6000) return fail(`both units refund ${both.amount}`);
    } finally {
      await stopListening();
    }
    pass('');
  },
};
