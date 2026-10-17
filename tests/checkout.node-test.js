import { eq } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import { addCredit, getBalance as storeBalance } from 'kempo-store-credit/sdk';
import { grantCredits, getBalance as creditBalance } from 'kempo-credits/sdk';
import { getProduct } from 'kempo-products/sdk';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, makeUser, freshUser, key, pretendInstalled } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed, paymentOf } from './helpers/fakeCard.js';
import { kempoCommerceCart, kempoCommerceOrder, kempoCommerceTender, kempoCommerceEvent } from '../server/db/schema.js';
import { resolveCart, addToCart, getCart } from '../server/utils/carts/cart.js';
import { startCheckout } from '../server/utils/checkout/quote.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { cancelUnpaidOrder } from '../server/utils/checkout/unwind.js';
import { registerTender, unregisterTender } from '../server/utils/checkout/tenders.js';
import { getOrder } from '../server/utils/orders/read.js';
import { runSweep } from '../server/utils/sweeps.js';

/*
  Checkout, end to end against a real database: pricing, the zero-total path with store credit and no
  payment processor, credits, a card payment, and everything that has to be undone when it goes wrong.
*/

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const refused = ([error], code) => {
  if(!error) throw new Error('expected an error');
  if(code && error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.msg}`);
  return error;
};

const BILLING = { name: 'Ada Lovelace', email: 'ada@example.test' };

const quantityOf = async product => ok(await getProduct(product.id)).quantity;

/* A cart with `quantity` of `product` for a visitor or a signed-in customer. */
const cartWith = async (product, { userId = null, quantity = 1 } = {}) => {
  const { cart, token } = ok(await resolveCart({ userId }));
  ok(await addToCart({ cartId: cart.id, productId: product.id, quantity }));
  return { cartId: cart.id, token };
};

const place = (cartId, extra = {}) => placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING, ...extra });

const cleanups = [];

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  cleanups.push(await pretendInstalled('kempo-store-credit'), await pretendInstalled('kempo-credits'));
  installFakeCard();
};

export const afterAll = async () => {
  restoreCard();
  for(const cleanup of cleanups) await cleanup();
  await purge();
};

export default {
  'the quote prices the cart, offers the ways to pay, and says what an account must do': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 400, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1000 });
    const { cartId } = await cartWith(item, { userId: buyer });
    const quote = ok(await startCheckout({ cartId, userId: buyer }));
    if(quote.totals.total !== 1000) return fail(`total ${quote.totals.total}`);
    const credit = quote.tenders.find(tender => tender.kind === 'store-credit');
    if(!credit || credit.max !== 400) return fail(`store credit offer ${JSON.stringify(credit)}`);
    if(!quote.tenders.some(tender => tender.kind === 'card')) return fail('no card offer');
    if(quote.account.required || !quote.account.signedIn) return fail('a signed-in customer needs nothing');

    const guestCart = await cartWith(item);
    const guest = ok(await startCheckout({ cartId: guestCart.cartId }));
    if(!guest.account.guestAllowed || guest.account.required) return fail('a guest should be allowed to check out');
    if(guest.tenders.length) return fail('a guest has no store credit or credits to use');
    pass('');
  },

  'store credit that covers the whole order completes it with no payment processor': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 5000, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1200, quantity: 5 });
    const { cartId } = await cartWith(item, { userId: buyer, quantity: 2 });

    const { order, payment } = ok(await place(cartId, { userId: buyer, tenders: { 'store-credit': true } }));
    if(payment) return fail('there was nothing for a card to pay');
    if(order.status !== 'processing') return fail(`status ${order.status}: paid, with something still to ship`);
    if(order.total !== 2400 || order.paidTotal !== 2400) return fail(`total ${order.total}, paid ${order.paidTotal}`);
    if(order.tenders.length !== 1 || order.tenders[0].kind !== 'store-credit' || order.tenders[0].status !== 'applied') return fail(`tenders ${JSON.stringify(order.tenders)}`);
    if(order.lines[0].fulfillment !== 'pending') return fail('a physical product should wait to be fulfilled');
    if(await quantityOf(item) !== 3) return fail('quantity was not taken');
    if(ok(await storeBalance({ userId: buyer })).amount !== 2600) return fail('store credit was not spent');
    const [cart] = await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, cartId));
    if(cart.status !== 'converted') return fail(`the cart is ${cart.status}`);
    pass('');
  },

  'a free order needs no tender and no processor': async ({ pass, fail }) => {
    const free = await makeProduct({ price: 0, quantity: 2 });
    const { cartId } = await cartWith(free);
    const { order, payment } = ok(await place(cartId));
    if(payment || order.total !== 0 || !order.paidAt) return fail(`order ${order.status} total ${order.total}`);
    if(await quantityOf(free) !== 1) return fail('quantity was not taken');
    pass('');
  },

  'a payment with part store credit and the rest on a card': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 300, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1000, quantity: 4 });
    const { cartId } = await cartWith(item, { userId: buyer });

    const { order, payment } = ok(await place(cartId, { userId: buyer, tenders: { 'store-credit': 300 } }));
    if(order.status !== 'pending_payment') return fail(`status ${order.status}`);
    if(!payment || payment.clientSecret !== 'cs_test_secret') return fail('no payment to complete');
    const amounts = Object.fromEntries(order.tenders.map(tender => [tender.kind, tender.amount]));
    if(amounts.card !== 700 || amounts['store-credit'] !== 300) return fail(`tenders ${JSON.stringify(amounts)}`);
    if(await quantityOf(item) !== 3) return fail('quantity should be held while waiting');
    if(ok(await storeBalance({ userId: buyer })).amount !== 0) return fail('store credit should be spent while waiting');

    const paid = await succeed(payment.id);
    const [error, done] = await completeOrder(order.id);
    if(error) return fail(error.msg);
    if(done.order.status !== 'processing' || done.order.paidTotal !== 1000) return fail(`status ${done.order.status} paid ${done.order.paidTotal}`);
    if(paid.amountCaptured !== 700) return fail('the fake payment was wrong');

    const again = ok(await completeOrder(order.id));
    if(!again.duplicate) return fail('completing twice should be a no-op');
    const paidEvents = await db.select().from(kempoCommerceEvent).where(eq(kempoCommerceEvent.orderId, order.id));
    if(paidEvents.filter(event => event.type === 'paid').length !== 1) return fail('the order was paid more than once');
    pass('');
  },

  'completing is safe to run many times at once': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 500, quantity: 3 });
    const { cartId } = await cartWith(item);
    const { order, payment } = ok(await place(cartId));
    await succeed(payment.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => completeOrder(order.id)));
    for(const result of results) ok(result);
    const events = await db.select().from(kempoCommerceEvent).where(eq(kempoCommerceEvent.orderId, order.id));
    if(events.filter(event => event.type === 'paid').length !== 1) return fail('paid events');
    if(await quantityOf(item) !== 2) return fail('quantity taken more than once');
    pass('');
  },

  'the card is not believed until the payment says it succeeded': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 500 });
    const { cartId } = await cartWith(item);
    const { order } = ok(await place(cartId));
    const error = refused(await completeOrder(order.id), 409);
    if(!/not completed/.test(error.msg)) return fail(error.msg);
    pass('');
  },

  'credits pay the part of the price a product allows': async ({ pass, fail }) => {
    const buyer = await makeUser();
    ok(await grantCredits({ userId: buyer, amount: 1000, kind: 'promo', reason: 'gift', reference: { owner: 'test', ref: key() }, idempotencyKey: key() }));
    await setSetting('kempo-products', 'credits_per_unit', 100, 'number', false, null);
    const item = await makeProduct({ price: 2000, creditPercent: 50, quantity: 3 });
    const { cartId } = await cartWith(item, { userId: buyer });

    const quote = ok(await startCheckout({ cartId, userId: buyer }));
    const offer = quote.tenders.find(tender => tender.kind === 'credits');
    if(!offer || offer.max !== 1000 || offer.detail.maxCredits !== 1000) return fail(`credits offer ${JSON.stringify(offer)}`);

    const { order, payment } = ok(await place(cartId, { userId: buyer, tenders: { credits: 600 } }));
    const credits = order.tenders.find(tender => tender.kind === 'credits');
    if(credits.amount !== 600 || credits.detail.credits !== 600 || credits.status !== 'applied') return fail(`credits tender ${JSON.stringify(credits)}`);
    if(order.tenders.find(tender => tender.kind === 'card').amount !== 1400) return fail('the card should take the rest');
    if(ok(await creditBalance({ userId: buyer })).total !== 400) return fail('credits were not spent');
    await succeed(payment.id);
    ok(await completeOrder(order.id));
    pass('');
  },

  'a failing tender undoes the ones before it, releases what it held and fails the order': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 500, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 2000, quantity: 5 });
    const { cartId } = await cartWith(item, { userId: buyer });

    /* A way to pay that is offered and then refuses to take the money, after store credit has already been spent. */
    registerTender({
      kind: 'gift-card', label: 'Gift card', priority: 30,
      available: async ({ due }) => ({ max: Math.min(500, due), detail: {} }),
      apply: async () => [{ code: 402, msg: 'The gift card is empty' }, null],
      reverse: async () => [null, true],
      refund: async () => [null, { reference: null }],
    });
    try {
      const error = refused(await place(cartId, { userId: buyer, tenders: { 'store-credit': true, 'gift-card': true } }), 402);
      if(!/gift card/.test(error.msg)) return fail(error.msg);
    } finally {
      unregisterTender('gift-card');
    }

    const [failed] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.userId, buyer));
    if(!failed || failed.status !== 'failed') return fail(`order ${failed?.status}`);
    if(await quantityOf(item) !== 5) return fail('quantity was not released');
    if(ok(await storeBalance({ userId: buyer })).amount !== 500) return fail('store credit was not given back');
    const tenders = await db.select().from(kempoCommerceTender).where(eq(kempoCommerceTender.orderId, failed.id));
    if(tenders.some(tender => tender.status === 'applied')) return fail('a tender is still applied');
    if(!tenders.some(tender => tender.kind === 'store-credit' && tender.status === 'reversed')) return fail('store credit should be marked reversed');
    pass('');
  },

  'a specific amount of a way to pay that is no longer available is refused, not moved to the card': async ({ pass, fail }) => {
    const buyer = await makeUser();
    const item = await makeProduct({ price: 1000 });
    const { cartId } = await cartWith(item, { userId: buyer });
    const error = refused(await place(cartId, { userId: buyer, tenders: { 'store-credit': 400 } }), 409);
    if(error.changed !== 'store-credit') return fail(`error ${JSON.stringify(error)}`);
    const orders = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.userId, buyer));
    if(orders.length) return fail('no order should exist');
    if(await quantityOf(item) !== -1) return fail('nothing should be held');
    pass('');
  },

  'placing the same checkout twice, even at once, makes one order': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 700, quantity: 5 });
    const { cartId } = await cartWith(item);
    const checkoutKey = key().slice(0, 30);
    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder({ cartId, checkoutKey, billing: BILLING })));
    const orders = results.filter(([error]) => !error).map(([, value]) => value.order.id);
    if(!orders.length) return fail(`all refused: ${results.map(([error]) => error?.msg).join('; ')}`);
    if(new Set(orders).size !== 1) return fail('more than one order was made');
    for(const [error] of results) if(error && error.code !== 409) return fail(`unexpected ${error.code} ${error.msg}`);
    const later = ok(await placeOrder({ cartId, checkoutKey, billing: BILLING }));
    if(!later.duplicate || later.order.id !== orders[0] || later.payment?.clientSecret !== 'cs_test_secret') return fail('the repeat did not return the first order with its payment');
    if(await quantityOf(item) !== 4) return fail('quantity held more than once');
    const rows = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.cartId, cartId));
    if(rows.length !== 1) return fail(`${rows.length} orders`);
    pass('');
  },

  'the last item goes to one of two customers who pay at once': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 900, quantity: 1 });
    const carts = [];
    for(let i = 0; i < 5; i++){
      const { cart } = ok(await resolveCart({}));
      await db.execute((await import('drizzle-orm')).sql.raw('select 1'));
      carts.push(cart.id);
    }
    /* Every cart is filled while the item is still in stock, then they all try to pay. */
    for(const cartId of carts) ok(await addToCart({ cartId, productId: item.id }));
    const results = await Promise.all(carts.map(cartId => place(cartId)));
    const won = results.filter(([error]) => !error);
    if(won.length !== 1) return fail(`${won.length} orders for one item`);
    if(await quantityOf(item) !== 0) return fail('quantity should be gone');
    pass('');
  },

  'a total that changed since the quote is refused with the new one': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const { cartId } = await cartWith(item);
    const error = refused(await place(cartId, { expectedTotal: 900 }), 409);
    if(!error.changed || error.totals.total !== 1000) return fail('the refusal should carry the real total');
    ok(await place(cartId, { expectedTotal: 1000 }));
    pass('');
  },

  'an order that is not paid in time fails, gives everything back, and a late payment is refunded': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 200, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1000, quantity: 3 });
    const { cartId } = await cartWith(item, { userId: buyer });
    const { order, payment } = ok(await place(cartId, { userId: buyer, tenders: { 'store-credit': true } }));
    if(await quantityOf(item) !== 2) return fail('not held');

    await db.update(kempoCommerceOrder).set({ placedAt: new Date(Date.now() - 3 * 3600000) }).where(eq(kempoCommerceOrder.id, order.id));
    const swept = await runSweep();
    if(swept.failed < 1) return fail(`sweep: ${JSON.stringify(swept)}`);
    const failed = ok(await getOrder(order.id));
    if(failed.status !== 'failed') return fail(`status ${failed.status}`);
    if(await quantityOf(item) !== 3) return fail('quantity not released');
    if(ok(await storeBalance({ userId: buyer })).amount !== 200) return fail('store credit not given back');
    if((await paymentOf(payment.id)).status !== 'canceled') return fail('the payment should be canceled');

    await succeed(payment.id);
    const error = refused(await completeOrder(order.id), 409);
    if(!error.expired) return fail('a payment after expiry should be flagged expired');
    pass('');
  },

  'a customer can cancel an unpaid order and everything is given back': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000, quantity: 2 });
    const { cartId } = await cartWith(item);
    const { order, payment } = ok(await place(cartId));
    const cancelled = ok(await cancelUnpaidOrder(order.id, { actor: 'customer' }));
    if(cancelled.order.status !== 'cancelled') return fail(`status ${cancelled.order.status}`);
    if(await quantityOf(item) !== 2) return fail('quantity not released');
    if((await paymentOf(payment.id)).status !== 'canceled') return fail('payment not canceled');
    const [cart] = await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, cartId));
    if(cart.status !== 'open') return fail('the cart should be the customer\'s again');
    const again = ok(await cancelUnpaidOrder(order.id));
    if(!again.duplicate) return fail('cancelling twice should be a no-op');
    pass('');
  },

  'a paid order cannot be cancelled': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const { cartId } = await cartWith(item);
    const { order, payment } = ok(await place(cartId));
    await succeed(payment.id);
    ok(await completeOrder(order.id));
    const error = refused(await cancelUnpaidOrder(order.id), 409);
    if(!error.paid) return fail('it should say the order was paid');
    pass('');
  },

  'a new checkout from the same cart replaces the earlier unpaid one': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000, quantity: 3 });
    const { cartId } = await cartWith(item);
    const first = ok(await place(cartId));
    const second = ok(await place(cartId));
    if(first.order.id === second.order.id) return fail('same order');
    if(ok(await getOrder(first.order.id)).status !== 'cancelled') return fail('the earlier order should be cancelled');
    if(await quantityOf(item) !== 2) return fail('only the new order should hold quantity');
    pass('');
  },

  'a guest checks out with an order key; guests off requires an account': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 500 });
    const { cartId } = await cartWith(item);
    const { order } = ok(await place(cartId));
    if(order.userId !== null || !order.orderKey || order.email !== BILLING.email) return fail('a guest order has no user, but has a key and an email');

    await setSetting('kempo-commerce', 'guest_checkout', false, 'boolean', false, null);
    const next = await cartWith(item);
    const error = refused(await place(next.cartId), 400);
    if(!error.account?.required) return fail('should say an account is required');
    await setSetting('kempo-commerce', 'guest_checkout', true, 'boolean', false, null);
    pass('');
  },

  'a cart with credits for sale needs an account, which checkout can create': async ({ pass, fail }) => {
    const pack = await makeProduct({ price: 500, creditsGranted: 100, creditsOnly: true });
    const { cartId } = await cartWith(pack);
    const error = refused(await place(cartId), 400);
    if(error.account?.reason !== 'credits') return fail('should say credits need an account');

    const email = `fresh-${key().slice(0, 8)}@example.test`;
    const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: { name: 'New Buyer', email }, account: { create: true } }));
    if(!order.userId) return fail('the order should belong to the new account');
    await succeed(payment.id);
    ok(await completeOrder(order.id));
    const done = ok(await getOrder(order.id));
    if(done.status !== 'completed') return fail(`a credit pack has nothing to ship, got ${done.status}`);
    if(done.lines[0].fulfillment !== 'none') return fail('credits need no fulfilment');
    if(ok(await creditBalance({ userId: order.userId })).total !== 100) return fail('the credits were not granted when it was paid');

    const again = await cartWith(pack);
    const clash = refused(await placeOrder({ cartId: again.cartId, checkoutKey: key().slice(0, 30), billing: { name: 'New Buyer', email }, account: { create: true } }), 409);
    if(!clash.existing) return fail('an email that already has an account should say so');
    pass('');
  },

  'checkout attempts are rate limited per address, and a flood is refused': async ({ pass, fail }) => {
    await setSetting('kempo-commerce', 'purchase_limit_per_ip', 2, 'number', false, null);
    const item = await makeProduct({ price: 100, quantity: 50 });
    const outcomes = [];
    for(let i = 0; i < 4; i++){
      const { cartId } = await cartWith(item);
      const [error] = await place(cartId, { ip: '203.0.113.9' });
      outcomes.push(error?.code ?? 200);
    }
    if(outcomes.slice(0, 2).some(code => code !== 200) || outcomes.slice(2).some(code => code !== 429)) return fail(`outcomes ${outcomes}`);
    const other = await cartWith(item);
    ok(await place(other.cartId, { ip: '203.0.113.10' }));
    await setSetting('kempo-commerce', 'purchase_limit_per_ip', 20, 'number', false, null);
    pass('');
  },

  'checkout is refused when the cart needs attention, and an empty cart cannot be placed': async ({ pass, fail }) => {
    const { cart } = ok(await resolveCart({}));
    refused(await place(cart.id), 409);
    const item = await makeProduct({ price: 100, quantity: 1 });
    ok(await addToCart({ cartId: cart.id, productId: item.id }));
    await db.execute((await import('drizzle-orm')).sql.raw(`update "kempoProduct" set "quantity" = 0 where "id" = '${item.id}'`));
    const error = refused(await place(cart.id), 409);
    if(!error.notices?.length) return fail('should carry the notices');
    pass('');
  },
};

void freshUser;
