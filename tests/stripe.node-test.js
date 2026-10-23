import { setSetting } from 'kempo/server/sdk.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { cancelUnpaidOrder } from '../server/utils/checkout/unwind.js';
import { getOrder } from '../server/utils/orders/read.js';

/*
  The real card tender against Stripe in **test mode**. Needs STRIPE_TEST_SECRET_KEY (an sk_test_ key) and
  says plainly that it was skipped when it is not set, so a green run without it cannot be mistaken for one
  that talked to Stripe. It never uses a live key: a key that does not start with sk_test_ is refused.
*/

const KEY = process.env.STRIPE_TEST_SECRET_KEY || '';

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await purge();
};

export default KEY.startsWith('sk_test_') ? {
  'a card order creates a real test-mode payment, gives its secret back on a repeat, and cancels it': async ({ pass, fail }) => {
    await setSetting('kempo-payments', 'stripe_secret_key', KEY, 'secret', false, null);
    const item = await makeProduct({ price: 1999, quantity: 3 });
    const { cart } = ok(await resolveCart({}));
    ok(await addToCart({ cartId: cart.id, productId: item.id }));
    const checkoutKey = key().slice(0, 30);
    const placed = ok(await placeOrder({ cartId: cart.id, checkoutKey, billing: { name: 'Test Buyer', email: 'buyer@example.test', line1: '1 Test St' } }));
    if(!placed.payment?.clientSecret?.startsWith('pi_')) return fail(`no client secret: ${JSON.stringify(placed.payment)}`);
    const again = ok(await placeOrder({ cartId: cart.id, checkoutKey, billing: { name: 'Test Buyer', email: 'buyer@example.test', line1: '1 Test St' } }));
    if(again.payment?.clientSecret !== placed.payment.clientSecret) return fail('a repeat should return the same payment');
    ok(await cancelUnpaidOrder(placed.order.id, { actor: 'customer' }));
    if(ok(await getOrder(placed.order.id)).status !== 'cancelled') return fail('not cancelled');
    pass('');
  },
} : {
  'the real Stripe test (SKIPPED: set STRIPE_TEST_SECRET_KEY to an sk_test_ key to run it)': async ({ pass }) => pass('skipped: no Stripe test-mode key'),
};

void db;
