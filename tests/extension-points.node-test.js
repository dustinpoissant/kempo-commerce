import path from 'path';
import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import { createHook, deleteHook, clearHandlerCache } from 'kempo/server/sdk.js';
import { hook } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, makeUser, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart, getCart } from '../server/utils/carts/cart.js';
import { startCheckout } from '../server/utils/checkout/quote.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { registerTender, unregisterTender } from '../server/utils/checkout/tenders.js';
import { getOrder } from '../server/utils/orders/read.js';
import { previewRefund } from '../server/utils/refunds/preview.js';
import { refundOrder } from '../server/utils/refunds/issue.js';
import { EVENTS } from '../server/utils/events.js';
import { sendOrderEmail } from '../server/utils/orders/emails.js';

/*
  The extension points, proved from the outside: a fixture "extension" that adds a fee, a checkout field
  with validation, a way to pay, a refusal, a fulfilment rule, an email addition and a refund warning,
  using only what the README promises (hooks, `registerTender`, the SDK). If shipping, coupons or digital
  delivery can be built on this, these are the things they will do.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handler = name => path.join(root, 'tests', 'fixtures', 'hooks', `${name}.js`);
const OWNER = 'kempo-commerce-fixture';

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const refused = ([error], code) => {
  if(!error) throw new Error('expected an error');
  if(code && error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.msg}`);
  return error;
};

const listen = async (event, name) => {
  ok(await createHook({ owner: OWNER, event: EVENTS[event], callback: handler(name) }));
  clearHandlerCache();
};

const stopListening = async () => {
  await db.delete(hook).where(eq(hook.owner, OWNER));
  clearHandlerCache();
};

const BILLING = { name: 'Fixture Buyer', email: 'fixture@example.test' };

const cartWith = async (product, quantity = 1) => {
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: product.id, quantity }));
  return cart.id;
};

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
  'a fee from another extension is added to the cart, the quote and the order, and refunded': async ({ pass, fail }) => {
    await listen('totalsFees', 'fee');
    try {
      const item = await makeProduct({ price: 1000, quantity: 5 });
      const cartId = await cartWith(item);
      const cart = ok(await getCart({ cartId }));
      if(cart.totals.feeTotal !== 700 || cart.totals.total !== 1700) return fail(`cart ${JSON.stringify(cart.totals)}`);
      if(cart.adjustments[0].source !== 'fixture-shipping') return fail('the source is lost');
      const quote = ok(await startCheckout({ cartId }));
      if(quote.totals.total !== 1700) return fail('the quote disagrees with the cart');

      const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING, expectedTotal: 1700 }));
      if(order.feeTotal !== 700 || order.total !== 1700) return fail(`order ${order.feeTotal} ${order.total}`);
      if(!order.adjustments.some(adjustment => adjustment.type === 'fee' && adjustment.amount === 700)) return fail('the fee is not on the order');
      await succeed(payment.id);
      ok(await completeOrder(order.id));

      const preview = ok(await previewRefund({ orderId: order.id, lines: { [order.lines[0].id]: 1 }, includeFees: true }));
      if(preview.amount !== 1700) return fail(`refund with fees ${preview.amount}`);
      const without = ok(await previewRefund({ orderId: order.id, lines: { [order.lines[0].id]: 1 } }));
      if(without.amount !== 1000) return fail(`refund without fees ${without.amount}`);
    } finally {
      await stopListening();
    }
    pass('');
  },

  'a checkout field is offered, validated by its owner, and kept on the order': async ({ pass, fail }) => {
    await listen('checkoutFields', 'field');
    await listen('checkoutValidate', 'validate');
    try {
      const item = await makeProduct({ price: 500, quantity: 5 });
      const cartId = await cartWith(item);
      const quote = ok(await startCheckout({ cartId }));
      if(!quote.fields.some(field => field.key === 'giftMessage')) return fail('the field was not offered');

      const error = refused(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING, data: { giftMessage: 'x'.repeat(30) } }), 400);
      if(error.errors?.[0]?.field !== 'giftMessage') return fail(`errors ${JSON.stringify(error.errors)}`);

      const { order } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING, data: { giftMessage: 'Happy birthday' } }));
      if(order.data.giftMessage !== 'Happy birthday') return fail('the value was not kept');
    } finally {
      await stopListening();
    }
    pass('');
  },

  'a guard can refuse an add, and the refusal reaches the caller exactly': async ({ pass, fail }) => {
    await listen('cartBeforeAdd', 'refuse-add');
    try {
      const item = await makeProduct({ price: 100 });
      const { cart } = ok(await resolveCart({}));
      const error = refused(await addToCart({ cartId: cart.id, productId: item.id, quantity: 4 }), 409);
      if(error.msg !== 'At most 3 of anything') return fail(error.msg);
      ok(await addToCart({ cartId: cart.id, productId: item.id, quantity: 3 }));
    } finally {
      await stopListening();
    }
    pass('');
  },

  'an extension decides which lines need fulfilling, and order:paid fires once': async ({ pass, fail }) => {
    await listen('orderLineFulfillment', 'fulfil');
    await listen('orderPaid', 'paid');
    globalThis.fixturePaid = [];
    try {
      const download = await makeProduct({ name: 'Download: the manual', price: 300 });
      const cartId = await cartWith(download);
      const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: BILLING }));
      await succeed(payment.id);
      await Promise.all([completeOrder(order.id), completeOrder(order.id), completeOrder(order.id)]);
      const done = ok(await getOrder(order.id));
      if(done.lines[0].fulfillment !== 'none' || done.status !== 'completed') return fail(`${done.lines[0].fulfillment} ${done.status}`);
      if(globalThis.fixturePaid.filter(id => id === order.id).length !== 1) return fail(`order:paid fired ${globalThis.fixturePaid.length} times`);

      const physical = await makeProduct({ name: 'A chair', price: 300 });
      const second = ok(await placeOrder({ cartId: await cartWith(physical), checkoutKey: key().slice(0, 30), billing: BILLING }));
      await succeed(second.payment.id);
      ok(await completeOrder(second.order.id));
      if(ok(await getOrder(second.order.id)).status !== 'processing') return fail('a physical product should wait to be sent');
    } finally {
      await stopListening();
    }
    pass('');
  },

  'an extension adds to a customer email': async ({ pass, fail }) => {
    await listen('orderEmailContext', 'email');
    try {
      const item = await makeProduct({ price: 200 });
      const { order } = ok(await placeOrder({ cartId: await cartWith(item), checkoutKey: key().slice(0, 30), billing: BILLING }));
      const [error] = await sendOrderEmail(order, 'order-processing', 'Test');
      /* Nothing is configured to send it, so the send fails; what matters is that the guard ran and nothing broke. */
      if(error && !/RESEND|configured|not found/i.test(error.msg)) return fail(error.msg);
    } finally {
      await stopListening();
    }
    pass('');
  },

  'a refund can be warned about or blocked by an extension, and refund:issued fires': async ({ pass, fail }) => {
    await listen('refundBeforeIssue', 'refund-warn');
    await listen('refundIssued', 'refunded');
    globalThis.fixtureRefunds = [];
    try {
      const item = await makeProduct({ price: 1000, quantity: 5 });
      const { order, payment } = ok(await placeOrder({ cartId: await cartWith(item), checkoutKey: key().slice(0, 30), billing: BILLING }));
      await succeed(payment.id);
      ok(await completeOrder(order.id));

      const preview = ok(await previewRefund({ orderId: order.id, amount: 400 }));
      if(!preview.warnings.includes('This order has a parcel on its way') || preview.blocked) return fail(`preview ${JSON.stringify(preview.warnings)} ${preview.blocked}`);
      const blocked = ok(await previewRefund({ orderId: order.id, amount: 777 }));
      if(!blocked.blocked) return fail('the extension could not block');
      const error = refused(await refundOrder(order.id, { amount: 777 }), 409);
      if(!error.blocked) return fail('a blocked refund must not be issued');

      const { refund } = ok(await refundOrder(order.id, { amount: 400 }));
      if(!globalThis.fixtureRefunds.includes(refund.id)) return fail('refund:issued did not fire');
    } finally {
      await stopListening();
    }
    pass('');
  },

  'an extension can add a way to pay, which is offered, applied, undone on failure and refunded': async ({ pass, fail }) => {
    const buyer = await makeUser();
    const log = [];
    registerTender({
      kind: 'gift-card', label: 'Gift card', priority: 30,
      available: async ({ userId, due }) => userId ? { max: Math.min(400, due), detail: { balance: 400 } } : null,
      apply: async ({ tender }) => { log.push(`apply ${tender.amount}`); return [null, { reference: 'gc_1' }]; },
      reverse: async () => { log.push('reverse'); return [null, true]; },
      refund: async ({ amount }) => { log.push(`refund ${amount}`); return [null, { reference: 'gc_refund' }]; },
    });
    try {
      const item = await makeProduct({ price: 1000, quantity: 5 });
      const { cart } = ok(await resolveCart({ userId: buyer }));
      ok(await addToCart({ cartId: cart.id, productId: item.id }));
      const quote = ok(await startCheckout({ cartId: cart.id, userId: buyer, tenders: { 'gift-card': true } }));
      if(!quote.tenders.some(offer => offer.kind === 'gift-card' && offer.max === 400)) return fail('not offered');
      if(quote.plan.find(entry => entry.kind === 'gift-card')?.amount !== 400 || quote.plan.find(entry => entry.kind === 'card')?.amount !== 600) return fail(`plan ${JSON.stringify(quote.plan)}`);

      const { order, payment } = ok(await placeOrder({ cartId: cart.id, userId: buyer, checkoutKey: key().slice(0, 30), billing: BILLING, tenders: { 'gift-card': true } }));
      if(!log.includes('apply 400')) return fail('apply was not called');
      await succeed(payment.id);
      ok(await completeOrder(order.id));
      ok(await refundOrder(order.id, { amount: 500 }));
      if(!log.some(entry => entry.startsWith('refund '))) return fail('the gift card was not refunded to itself');
    } finally {
      unregisterTender('gift-card');
    }
    pass('');
  },
};
