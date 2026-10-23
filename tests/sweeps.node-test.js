import { eq } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import { user as userTable } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, makeUser, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed, paymentOf } from './helpers/fakeCard.js';
import { kempoCommerceCart, kempoCommerceOrder, kempoCommerceEvent, kempoCommerceAttempt } from '../server/db/schema.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { getOrder } from '../server/utils/orders/read.js';
import { runSweep } from '../server/utils/sweeps.js';
import { onPaymentFailed, onPaymentCanceled, onPaymentDisputed, onPaymentRefunded } from '../server/utils/checkout/payments.js';
import { cancelUnpaidOrder } from '../server/utils/checkout/unwind.js';
import emailVerified from '../hooks/email-verified.js';
import paymentFailed from '../hooks/payment-failed.js';

/*
  What happens without anyone asking: carts nobody touched, orders nobody paid or finished, a payment
  that was declined, cancelled, disputed or refunded outside the shop, and an email that was verified.
*/

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const BILLING = { name: 'Sweep Buyer', email: 'sweep@example.test', line1: '1 Test St' };

const cartWith = async (product, userId = null) => {
  const { cart } = ok(await resolveCart({ userId }));
  ok(await addToCart({ cartId: cart.id, productId: product.id }));
  return cart.id;
};

const card = async (price = 500, { userId = null, ip = null } = {}) => {
  const item = await makeProduct({ price, quantity: 5 });
  const { order, payment } = ok(await placeOrder({ cartId: await cartWith(item, userId), userId, checkoutKey: key().slice(0, 30), billing: BILLING, ip }));
  return { item, order, payment };
};

const eventTypes = async orderId => (await db.select().from(kempoCommerceEvent).where(eq(kempoCommerceEvent.orderId, orderId))).map(event => event.type);

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  installFakeCard();
};

export const afterAll = async () => {
  restoreCard();
  await purge();
};

export default {
  'carts nobody touched are abandoned, and abandoned ones are deleted in time': async ({ pass, fail }) => {
    const item = await makeProduct();
    const stale = await cartWith(item);
    const fresh = await cartWith(item);
    await db.update(kempoCommerceCart).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(kempoCommerceCart.id, stale));
    const done = await runSweep();
    if(done.abandoned < 1) return fail(`sweep ${JSON.stringify(done)}`);
    const status = async id => (await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, id)))[0]?.status;
    if(await status(stale) !== 'abandoned' || await status(fresh) !== 'open') return fail(`${await status(stale)} ${await status(fresh)}`);

    await db.update(kempoCommerceCart).set({ updatedAt: new Date(Date.now() - 100 * 86400000) }).where(eq(kempoCommerceCart.id, stale));
    const later = await runSweep();
    if(later.purged < 1 || await status(stale) !== undefined) return fail('an old abandoned cart should be deleted');
    pass('');
  },

  'an order that was paid but never finished is finished by the sweep': async ({ pass, fail }) => {
    const { order, payment } = await card(600);
    await succeed(payment.id);
    await db.update(kempoCommerceOrder).set({ paidAt: new Date(), updatedAt: new Date(Date.now() - 5 * 60000) }).where(eq(kempoCommerceOrder.id, order.id));
    const done = await runSweep();
    if(done.completed < 1) return fail(`sweep ${JSON.stringify(done)}`);
    if(ok(await getOrder(order.id)).status !== 'processing') return fail('it should be finished');
    pass('');
  },

  'an unpaid order whose payment actually went through is completed, not failed, when it expires': async ({ pass, fail }) => {
    const { order, payment } = await card(700);
    await succeed(payment.id);
    await db.update(kempoCommerceOrder).set({ placedAt: new Date(Date.now() - 5 * 3600000) }).where(eq(kempoCommerceOrder.id, order.id));
    const done = await runSweep();
    if(done.completed < 1 || done.failed > 0) return fail(`sweep ${JSON.stringify(done)}`);
    if(ok(await getOrder(order.id)).status !== 'processing') return fail('the money arrived, so the order stands');
    pass('');
  },

  'a decline counts, and too many from one address cool the checkout down and fail the order': async ({ pass, fail }) => {
    await setSetting('kempo-commerce', 'failed_payment_limit', 2, 'number', false, null);
    try {
      const first = await card(500, { ip: '198.51.100.7' });
      await onPaymentFailed(await paymentOf(first.payment.id));
      if(ok(await getOrder(first.order.id)).status !== 'pending_payment') return fail('one decline is a customer, and should not end the order');

      const second = await card(500, { ip: '198.51.100.7' });
      await paymentFailed({ payment: await paymentOf(second.payment.id) });
      if(ok(await getOrder(second.order.id)).status !== 'failed') return fail('the second decline should end it');
      if((await paymentOf(second.payment.id)).status !== 'canceled') return fail('the payment should be cancelled so no more cards can be tried');

      const item = await makeProduct({ price: 100, quantity: 3 });
      const [error] = await placeOrder({ cartId: await cartWith(item), checkoutKey: key().slice(0, 30), billing: BILLING, ip: '198.51.100.7' });
      if(!error || error.code !== 429 || !error.retryAfter) return fail(`further attempts: ${JSON.stringify(error)}`);
      const refusals = await db.select().from(kempoCommerceAttempt).where(eq(kempoCommerceAttempt.kind, 'refused'));
      if(!refusals.length) return fail('the refusal was not logged');
      const other = ok(await placeOrder({ cartId: await cartWith(item), checkoutKey: key().slice(0, 30), billing: BILLING, ip: '198.51.100.8' }));
      if(!other.order) return fail('another address should be fine');
    } finally {
      await setSetting('kempo-commerce', 'failed_payment_limit', 3, 'number', false, null);
    }
    pass('');
  },

  'a payment cancelled by someone else fails the order, but our own cancellation does not': async ({ pass, fail }) => {
    const outside = await card(400);
    await onPaymentCanceled(await paymentOf(outside.payment.id));
    if(ok(await getOrder(outside.order.id)).status !== 'failed') return fail('a payment cancelled elsewhere should fail the order');

    const ours = await card(400);
    ok(await cancelUnpaidOrder(ours.order.id, { actor: 'customer' }));
    await onPaymentCanceled(await paymentOf(ours.payment.id));
    if(ok(await getOrder(ours.order.id)).status !== 'cancelled') return fail('our own cancellation was undone');
    pass('');
  },

  'a refund or a chargeback outside the shop is recorded and flagged, never acted on': async ({ pass, fail }) => {
    const { order, payment } = await card(900);
    await succeed(payment.id);
    const { completeOrder } = await import('../server/utils/checkout/complete.js');
    ok(await completeOrder(order.id));

    const paid = await paymentOf(payment.id);
    await onPaymentRefunded({ ...paid, amountRefunded: 300 }, { amount: 300 });
    await onPaymentDisputed(paid, true, 'fraudulent');
    const types = await eventTypes(order.id);
    if(!types.includes('refund_outside') || !types.includes('dispute_opened')) return fail(`events ${types}`);
    const after = ok(await getOrder(order.id));
    if(after.status !== 'processing' || after.refundedTotal !== 0) return fail('nothing should change on the order by itself');
    pass('');
  },

  'verifying an email attaches the guest orders placed with it': async ({ pass, fail }) => {
    const { order } = await card(250);
    const buyer = await makeUser(undefined, { email: BILLING.email });
    await emailVerified({ userId: buyer, email: BILLING.email });
    if(ok(await getOrder(order.id)).userId !== buyer) return fail('the guest order should be theirs now');

    const stranger = await makeUser(undefined, { email: 'someone-else@example.test' });
    await db.update(userTable).set({ emailVerified: false }).where(eq(userTable.id, stranger));
    const other = await card(260);
    await emailVerified({ userId: stranger, email: BILLING.email });
    if(ok(await getOrder(other.order.id)).userId !== null) return fail('an address that is not the account\'s attached an order');
    pass('');
  },
};
