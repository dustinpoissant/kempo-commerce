import path from 'path';
import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import { createHook, clearHandlerCache } from 'kempo/server/sdk.js';
import { hook } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct } from './helpers/shop.js';
import { resolveCart, addToCart, getCart } from '../server/utils/carts/cart.js';
import { startCheckout } from '../server/utils/checkout/quote.js';
import { EVENTS } from '../server/utils/events.js';

/*
  A fee that depends on what the customer has entered (shipping's address) is worked out at checkout, from the
  checkout's details, and never shows on the cart, which has no details yet.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'kempo-commerce-checkout-context-fixture';
const BILLING = { name: 'Fixture Buyer', email: 'fixture@example.test', line1: '1 Test St' };

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const listen = async () => {
  ok(await createHook({ owner: OWNER, event: EVENTS.totalsFees, callback: path.join(root, 'tests', 'fixtures', 'hooks', 'checkout-fee.js') }));
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

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  await stopListening();
};

export const afterAll = async () => {
  await stopListening();
  await purge();
};

export default {
  'a checkout fee follows the details entered, and the cart never shows it': async ({ pass, fail }) => {
    await listen();
    try {
      const item = await makeProduct({ price: 1000, quantity: 5 });
      const cartId = await cartWith(item);
      if(ok(await getCart({ cartId })).totals.feeTotal !== 0) return fail('the cart shows a checkout fee');
      const without = ok(await startCheckout({ cartId, billing: BILLING }));
      if(without.totals.feeTotal !== 900) return fail(`no details: ${without.totals.feeTotal}`);
      const withShipping = ok(await startCheckout({ cartId, billing: BILLING, data: { shipping: { name: 'Ada' } } }));
      if(withShipping.totals.feeTotal !== 500 || withShipping.totals.total !== 1500) return fail(`with details: ${JSON.stringify(withShipping.totals)}`);
      if(ok(await getCart({ cartId })).totals.feeTotal !== 0) return fail('the checkout fee was kept on the cart');
      pass('no details: 9.00 fee; with a shipping address: 5.00; the cart still has none');
    } finally {
      await stopListening();
    }
  },
};
