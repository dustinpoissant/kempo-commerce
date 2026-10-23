import { eq } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import { addCredit, getBalance as storeBalance } from 'kempo-store-credit/sdk';
import { grantCredits, spendCredits, getBalance as creditBalance } from 'kempo-credits/sdk';
import { getProduct } from 'kempo-products/sdk';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, makeUser, key, pretendInstalled } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed, paymentOf, behaviour } from './helpers/fakeCard.js';
import { kempoCommerceOrder, kempoCommerceRefund } from '../server/db/schema.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { getOrder } from '../server/utils/orders/read.js';
import { previewRefund } from '../server/utils/refunds/preview.js';
import { refundOrder, finishRefund } from '../server/utils/refunds/issue.js';
import { setLineFulfillment } from '../server/utils/orders/fulfillment.js';

/*
  Refunds: what each line comes to, how the money goes back tender by tender, the credits warning, and
  what happens when a step fails halfway.
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

const quantityOf = async product => ok(await getProduct(product.id)).quantity;

/* A paid order: `items` is [[product, quantity], ...], paid by card, or with store credit first when `credit` is given. */
const paidOrder = async (items, { userId = null, tenders = {}, billing = { name: 'Buyer', email: 'buyer@example.test', line1: '1 Test St' } } = {}) => {
  const { cart } = ok(await resolveCart({ userId }));
  for(const [product, quantity] of items) ok(await addToCart({ cartId: cart.id, productId: product.id, quantity }));
  const { order, payment } = ok(await placeOrder({ cartId: cart.id, userId, checkoutKey: key().slice(0, 30), billing, tenders }));
  if(payment) await succeed(payment.id);
  return ok(await completeOrder(order.id)).order;
};

const cleanups = [];

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  cleanups.push(await pretendInstalled('kempo-store-credit'), await pretendInstalled('kempo-credits'));
  installFakeCard();
};

export const afterAll = async () => {
  behaviour.refundsFail = false;
  restoreCard();
  for(const cleanup of cleanups) await cleanup();
  await purge();
};

export default {
  'refunding the whole order returns the card money, restocks, and marks it refunded': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000, quantity: 5 });
    const order = await paidOrder([[item, 2]]);
    if(await quantityOf(item) !== 3) return fail('setup');

    const { refund, order: after } = ok(await refundOrder(order.id, { lines: { [order.lines[0].id]: 2 }, reason: 'Changed their mind', actor: 'admin-1' }));
    if(refund.status !== 'issued' || refund.amount !== 2000) return fail(`refund ${refund.status} ${refund.amount}`);
    if(after.status !== 'refunded' || after.refundedTotal !== 2000) return fail(`order ${after.status} ${after.refundedTotal}`);
    if(await quantityOf(item) !== 5) return fail('the quantity should be back');
    const card = after.tenders.find(tender => tender.kind === 'card');
    if(card.status !== 'refunded' || card.refundedAmount !== 2000) return fail('the card tender should be refunded');
    if((await paymentOf(card.reference)).amountRefunded !== 2000) return fail('the payment was not refunded');
    refused(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 } }), 409);
    pass('');
  },

  'a partial refund keeps the status, and the rest can be refunded later': async ({ pass, fail }) => {
    const first = await makeProduct({ price: 1000, quantity: 5 });
    const second = await makeProduct({ price: 500, quantity: 5 });
    const order = await paidOrder([[first, 3], [second, 1]]);
    const [lineA, lineB] = order.lines;

    const one = ok(await refundOrder(order.id, { lines: { [lineA.id]: 1 }, restock: false }));
    if(one.order.status !== 'processing' || one.order.refundedTotal !== 1000) return fail(`after one: ${one.order.status} ${one.order.refundedTotal}`);
    if(await quantityOf(first) !== 2) return fail('restock: false should not put it back');

    const preview = ok(await previewRefund({ orderId: order.id, lines: { [lineA.id]: 2, [lineB.id]: 1 } }));
    if(preview.amount !== 2500) return fail(`preview ${preview.amount}`);
    refused(await previewRefund({ orderId: order.id, lines: { [lineA.id]: 3 } }), 400);

    const rest = ok(await refundOrder(order.id, { lines: { [lineA.id]: 2, [lineB.id]: 1 }, restock: true }));
    if(rest.order.status !== 'refunded' || rest.order.refundedTotal !== 3500) return fail(`after rest: ${rest.order.status} ${rest.order.refundedTotal}`);
    pass('');
  },

  'the money goes back in proportion to each tender': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 400, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1000, quantity: 5 });
    const order = await paidOrder([[item, 1]], { userId: buyer, tenders: { 'store-credit': 400 } });
    const before = ok(await storeBalance({ userId: buyer })).amount;

    const preview = ok(await previewRefund({ orderId: order.id, amount: 500 }));
    const byKind = Object.fromEntries(preview.tenders.map(tender => [tender.kind, tender.amount]));
    if(byKind['store-credit'] !== 200 || byKind.card !== 300) return fail(`split ${JSON.stringify(byKind)}`);

    ok(await refundOrder(order.id, { amount: 500, reason: 'goodwill' }));
    if(ok(await storeBalance({ userId: buyer })).amount !== before + 200) return fail('store credit should get its share back');
    const card = (await getOrder(order.id))[1].tenders.find(tender => tender.kind === 'card');
    if((await paymentOf(card.reference)).amountRefunded !== 300) return fail('the card should get its share back');
    pass('');
  },

  'card money can be returned as store credit instead, for an account': async ({ pass, fail }) => {
    const buyer = await makeUser();
    const item = await makeProduct({ price: 800, quantity: 3 });
    const order = await paidOrder([[item, 1]], { userId: buyer });
    ok(await refundOrder(order.id, { amount: 800, destination: 'store-credit' }));
    if(ok(await storeBalance({ userId: buyer })).amount !== 800) return fail('the money should come back as store credit');
    const card = ok(await getOrder(order.id)).tenders.find(tender => tender.kind === 'card');
    if((await paymentOf(card.reference)).amountRefunded !== 0) return fail('the card should not be refunded');

    const guestItem = await makeProduct({ price: 300, quantity: 3 });
    const guestOrder = await paidOrder([[guestItem, 1]]);
    refused(await previewRefund({ orderId: guestOrder.id, amount: 300, destination: 'store-credit' }), 400);
    pass('');
  },

  'the credits warning: spent credits need a decision before a refund can be issued': async ({ pass, fail }) => {
    const buyer = await makeUser();
    const pack = await makeProduct({ price: 500, creditsGranted: 100, creditsOnly: true });
    const order = await paidOrder([[pack, 1]], { userId: buyer });
    if(ok(await creditBalance({ userId: buyer })).total !== 100) return fail('setup: credits were not granted');

    /* Nothing spent yet: no question to answer. */
    const clean = ok(await previewRefund({ orderId: order.id, amount: 500 }));
    if(clean.credits.shortfall !== 0) return fail(`shortfall ${clean.credits.shortfall}`);

    ok(await spendCredits({ userId: buyer, amount: 60, reason: 'boost', reference: { owner: 'test', ref: key() }, idempotencyKey: key() }));
    const preview = ok(await previewRefund({ orderId: order.id, lines: { [order.lines[0].id]: 1 } }));
    const { credits } = preview;
    if(credits.given !== 100 || credits.held !== 40 || credits.shortfall !== 60 || credits.userId !== buyer) return fail(`credits ${JSON.stringify(credits)}`);
    if(!credits.historyUrl.includes(buyer)) return fail('no link to their history');

    const error = refused(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 } }), 409);
    if(!error.needsDecision) return fail('should ask for a decision');
    if((await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.orderId, order.id))).length) return fail('nothing should be recorded before the decision');
    refused(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 }, credits: 'maybe' }), 400);

    const done = ok(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 }, credits: 'zero' }));
    if(done.refund.credits !== 'zero' || done.order.status !== 'refunded') return fail(`refund ${JSON.stringify(done.refund.credits)} ${done.order.status}`);
    const balance = ok(await creditBalance({ userId: buyer }));
    if(balance.total !== 0 || balance.owed !== 0) return fail(`balance ${JSON.stringify(balance)}: they should be left at zero`);
    pass('');
  },

  'the other decision leaves the customer owing what they spent': async ({ pass, fail }) => {
    const buyer = await makeUser();
    const pack = await makeProduct({ price: 500, creditsGranted: 100, creditsOnly: true });
    const order = await paidOrder([[pack, 1]], { userId: buyer });
    ok(await spendCredits({ userId: buyer, amount: 70, reason: 'boost', reference: { owner: 'test', ref: key() }, idempotencyKey: key() }));
    ok(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 }, credits: 'owe' }));
    const balance = ok(await creditBalance({ userId: buyer }));
    if(balance.owed !== 70) return fail(`owed ${balance.owed}`);
    pass('');
  },

  'two refunds racing for the last of the money: one wins': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 1000, quantity: 3 });
    const order = await paidOrder([[item, 1]]);
    const results = await Promise.all([refundOrder(order.id, { amount: 700 }), refundOrder(order.id, { amount: 700 }), refundOrder(order.id, { amount: 700 })]);
    const wins = results.filter(([error]) => !error);
    if(wins.length !== 1) return fail(`${wins.length} refunds of 700 from 1000`);
    const final = ok(await getOrder(order.id));
    if(final.refundedTotal !== 700) return fail(`refunded ${final.refundedTotal}`);
    pass('');
  },

  'an unpaid, cancelled or over-large refund is refused': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 600, quantity: 3 });
    const { cart } = ok(await resolveCart({}));
    ok(await addToCart({ cartId: cart.id, productId: item.id }));
    const { order: unpaid } = ok(await placeOrder({ cartId: cart.id, checkoutKey: key().slice(0, 30), billing: { name: 'Buyer', email: 'b@example.test', line1: '1 Test St' } }));
    refused(await previewRefund({ orderId: unpaid.id, amount: 100 }), 409);

    const order = await paidOrder([[item, 1]]);
    refused(await previewRefund({ orderId: order.id, amount: 601 }), 409);
    refused(await previewRefund({ orderId: order.id, amount: 0 }), 400);
    refused(await previewRefund({ orderId: order.id }), 400);
    refused(await previewRefund({ orderId: order.id, amount: 100, lines: { [order.lines[0].id]: 1 } }), 400);
    refused(await previewRefund({ orderId: 'ord_nope', amount: 100 }), 404);
    pass('');
  },

  'a refund that fails partway is left partial and can be finished': async ({ pass, fail }) => {
    const buyer = await makeUser();
    await addCredit({ userId: buyer, amount: 300, reason: 'gift', idempotencyKey: key() });
    const item = await makeProduct({ price: 1000, quantity: 4 });
    const order = await paidOrder([[item, 1]], { userId: buyer, tenders: { 'store-credit': 300 } });
    const before = ok(await storeBalance({ userId: buyer })).amount;

    behaviour.refundsFail = true;
    const error = refused(await refundOrder(order.id, { lines: { [order.lines[0].id]: 1 } }), 502);
    behaviour.refundsFail = false;
    if(!error.partial) return fail('should say it was partly issued');

    const [record] = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.orderId, order.id));
    if(record.status !== 'partial') return fail(`refund ${record.status}`);
    const done = record.steps.filter(step => step.status === 'done').map(step => step.id.split(':')[0]);
    const failed = record.steps.filter(step => step.status === 'failed');
    if(failed.length !== 1 || !failed[0].error.includes('refused')) return fail(`steps ${JSON.stringify(record.steps)}`);
    if(ok(await storeBalance({ userId: buyer })).amount !== before + 300) return fail(`store credit should already be back (${done})`);
    const mid = ok(await getOrder(order.id));
    if(mid.status === 'refunded') return fail('a partly issued refund must not mark the order refunded');

    const finished = ok(await finishRefund(record.id, { actor: 'admin-1' }));
    if(finished.refund.status !== 'issued') return fail(`finish ${finished.refund.status}`);
    if(ok(await storeBalance({ userId: buyer })).amount !== before + 300) return fail('store credit was returned twice');
    const card = (await paymentOf(ok(await getOrder(order.id)).tenders.find(tender => tender.kind === 'card').reference));
    if(card.amountRefunded !== 700) return fail(`card refunded ${card.amountRefunded}`);
    const after = ok(await getOrder(order.id));
    if(after.status !== 'refunded') return fail(`status ${after.status}`);
    const again = ok(await finishRefund(record.id));
    if(!again.duplicate) return fail('finishing twice should do nothing');
    pass('');
  },

  'fulfilment: lines are marked done and the order completes, and a refund does not change the lines': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 400, quantity: 3 });
    const order = await paidOrder([[item, 1]]);
    if(order.status !== 'processing') return fail(`status ${order.status}`);
    const done = ok(await setLineFulfillment(order.id, order.lines[0].id, 'done', { actor: 'shipping', data: { shipmentId: 's1' } }));
    if(done.status !== 'completed') return fail(`status ${done.status}`);
    const reopened = ok(await setLineFulfillment(order.id, order.lines[0].id, 'pending'));
    if(reopened.status !== 'processing') return fail(`reopened ${reopened.status}`);
    ok(await setLineFulfillment(order.id, order.lines[0].id, 'done'));
    const refunded = ok(await refundOrder(order.id, { amount: 400 }));
    if(refunded.order.lines[0].fulfillment !== 'done') return fail('a refund keeps the lines\' fulfilment');
    refused(await setLineFulfillment(order.id, order.lines[0].id, 'pending'), 409);
    pass('');
  },
};

void kempoCommerceOrder;
void grantCredits;
void setSetting;
