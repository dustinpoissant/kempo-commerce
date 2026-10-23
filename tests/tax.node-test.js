import { eq } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import { createRate } from 'kempo-tax/sdk';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key, pretendInstalled } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { kempoCommerceOrder } from '../server/db/schema.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { startCheckout } from '../server/utils/checkout/quote.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { refundOrder } from '../server/utils/refunds/issue.js';
import { getOrder } from '../server/utils/orders/read.js';
import { cleanBilling } from '../server/utils/checkout/billing.js';

/*
  Tax through kempo-tax, using its own rate table (no processor needed): exclusive prices add tax,
  inclusive prices report it, a country is required once tax is on, the sale is recorded when paid and
  a refund reverses its share.
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

const US = { name: 'Buyer', email: 'buyer@example.test', line1: '1 Test St', country: 'US', state: 'VT', postalCode: '05401' };

const cartWith = async (product, quantity = 1) => {
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: product.id, quantity }));
  return cart.id;
};

const cleanups = [];

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxEntry"')).catch(() => {});
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxQuote"')).catch(() => {});
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxRate"')).catch(() => {});
  cleanups.push(await pretendInstalled('kempo-tax'));
  await setSetting('kempo-tax', 'provider', 'rates', 'string', false, null);
  await setSetting('kempo-tax', 'currency', 'usd', 'string', false, null);
  ok(await createRate({ country: 'US', rate: '10', label: 'Sales tax' }));
  installFakeCard();
};

export const afterAll = async () => {
  restoreCard();
  for(const cleanup of cleanups) await cleanup();
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxEntry"')).catch(() => {});
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxQuote"')).catch(() => {});
  await db.execute((await import('drizzle-orm')).sql.raw('delete from "kempoTaxRate"')).catch(() => {});
  await purge();
};

export default {
  'without an address the quote has no tax yet, and with one it adds tax to the total': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const cartId = await cartWith(item);
    const bare = ok(await startCheckout({ cartId }));
    if(!bare.taxEnabled || bare.totals.taxComputed || bare.totals.total !== 1000) return fail(`bare ${JSON.stringify(bare.totals)}`);
    const quote = ok(await startCheckout({ cartId, billing: US }));
    if(quote.totals.taxTotal !== 100 || quote.totals.total !== 1100 || quote.totals.pricesIncludeTax) return fail(`quote ${JSON.stringify(quote.totals)}`);
    pass('');
  },

  'checkout needs a country once tax is on': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const cartId = await cartWith(item);
    const error = refused(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: { name: 'Buyer', email: 'b@example.test', line1: '1 Test St' } }), 400);
    if(!/country/i.test(error.msg)) return fail(error.msg);
    pass('');
  },

  'the order carries the tax, the sale is recorded when paid, and a refund reverses its share': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000, quantity: 5 });
    const cartId = await cartWith(item, 2);
    const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: US }));
    if(order.taxTotal !== 200 || order.total !== 2200 || order.lines[0].tax !== 200) return fail(`order ${order.taxTotal} ${order.total} ${order.lines[0].tax}`);
    if(!order.adjustments.some(adjustment => adjustment.type === 'tax' && adjustment.amount === 200)) return fail('no tax adjustment');
    if(order.tenders.find(tender => tender.kind === 'card').amount !== 2200) return fail('the card should pay the tax too');
    if(order.taxTransactionId) return fail('the sale must not be recorded before it is paid');

    await succeed(payment.id);
    const paid = ok(await completeOrder(order.id)).order;
    if(!paid.taxTransactionId) return fail('the sale should be recorded once paid');

    const half = ok(await refundOrder(order.id, { lines: { [paid.lines[0].id]: 1 } }));
    if(half.refund.amount !== 1100) return fail(`one unit with its tax is 1100, got ${half.refund.amount}`);
    const step = half.refund.steps.find(candidate => candidate.id === 'tax');
    if(step.status !== 'done') return fail(`tax step ${JSON.stringify(step)}`);
    const rest = ok(await refundOrder(order.id, { lines: { [paid.lines[0].id]: 1 } }));
    if(rest.order.status !== 'refunded' || rest.order.refundedTotal !== 2200) return fail(`rest ${rest.order.status} ${rest.order.refundedTotal}`);
    pass('');
  },

  'with prices that include tax the total does not change and tax is only reported': async ({ pass, fail }) => {
    await setSetting('kempo-tax', 'prices_include_tax', true, 'boolean', false, null);
    const item = await makeProduct({ price: 1100, quantity: 5 });
    const cartId = await cartWith(item);
    const quote = ok(await startCheckout({ cartId, billing: US }));
    if(!quote.totals.pricesIncludeTax || quote.totals.total !== 1100 || quote.totals.taxTotal !== 100) return fail(`quote ${JSON.stringify(quote.totals)}`);
    const { order, payment } = ok(await placeOrder({ cartId, checkoutKey: key().slice(0, 30), billing: US }));
    if(order.total !== 1100 || order.taxTotal !== 100 || !order.pricesIncludeTax) return fail(`order ${order.total} ${order.taxTotal}`);
    await succeed(payment.id);
    ok(await completeOrder(order.id));
    const refund = ok(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 } }));
    if(refund.refund.amount !== 1100) return fail(`an inclusive line refunds its price, got ${refund.refund.amount}`);
    await setSetting('kempo-tax', 'prices_include_tax', false, 'boolean', false, null);
    pass('');
  },

  'a country the rate table does not cover is charged no tax': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const cartId = await cartWith(item);
    const quote = ok(await startCheckout({ cartId, billing: { ...US, country: 'GB', state: '', postalCode: 'SW1A 1AA' } }));
    if(quote.totals.taxTotal !== 0 || quote.totals.total !== 1000) return fail(`quote ${JSON.stringify(quote.totals)}`);
    pass('');
  },

  'an address that is not complete enough to tax is not priced and is not an error': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const cartId = await cartWith(item);

    /* a US address with no postal code: the provider would refuse, so it is not asked */
    const early = ok(await startCheckout({ cartId, billing: { ...US, postalCode: '' } }));
    if(early.totals.taxComputed || early.totals.total !== 1000) return fail(`priced early: ${JSON.stringify(early.totals)}`);
    if(early.required.country !== true || early.required.state !== true || early.required.postalCode !== true) return fail(`required ${JSON.stringify(early.required)}`);

    /* no state either */
    const noState = ok(await startCheckout({ cartId, billing: { ...US, state: '' } }));
    if(noState.totals.taxComputed) return fail('a US address with no state was priced');

    const full = ok(await startCheckout({ cartId, billing: US }));
    if(!full.totals.taxComputed || full.totals.taxTotal !== 100) return fail(`complete: ${JSON.stringify(full.totals)}`);
    pass('');
  },

  'the pickers are told what tax needs, by country': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000 });
    const cartId = await cartWith(item);
    const needs = async billing => ok(await startCheckout({ cartId, billing })).required;

    const none = await needs(null);
    if(none.country !== true || none.state !== false || none.postalCode !== false) return fail(`no address yet: ${JSON.stringify(none)}`);
    const canada = await needs({ country: 'CA' });
    if(canada.state !== true || canada.postalCode !== false) return fail(`Canada: ${JSON.stringify(canada)}`);
    const britain = await needs({ country: 'GB' });
    if(britain.state !== false || britain.postalCode !== false) return fail(`GB needs only a country: ${JSON.stringify(britain)}`);
    pass('');
  },

  'placing an order refuses the missing state or postal code with a plain message': async ({ pass, fail }) => {
    const clean = billing => cleanBilling({ billing: { name: 'Buyer', email: 'b@example.test', line1: '1 Test St', ...billing } });
    const [noStreet] = await cleanBilling({ billing: { name: 'Buyer', email: 'b@example.test', country: 'US', state: 'VT', postalCode: '05401' } });
    if(noStreet?.code !== 400 || !/street address/.test(noStreet.msg)) return fail(`a postal code alone is not an address: ${JSON.stringify(noStreet)}`);
    const [noState] = await clean({ country: 'US', postalCode: '05401' });
    if(noState?.code !== 400 || !/state or region/.test(noState.msg) || !/calculated/.test(noState.msg)) return fail(`state: ${JSON.stringify(noState)}`);
    const [noPostal] = await clean({ country: 'US', state: 'VT' });
    if(noPostal?.code !== 400 || !/postal code/.test(noPostal.msg)) return fail(`postal: ${JSON.stringify(noPostal)}`);
    const [noCountry] = await clean({});
    if(noCountry?.code !== 400 || !/calculated/.test(noCountry.msg)) return fail(`country: ${JSON.stringify(noCountry)}`);
    const [error, ok2] = await clean({ country: 'GB', postalCode: 'SW1A 1AA' });
    if(error || ok2.country !== 'GB') return fail(`GB needs no state: ${JSON.stringify(error)}`);
    pass('');
  },
};

void eq;
void kempoCommerceOrder;
void getOrder;
