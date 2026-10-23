import { seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { getOrder } from '../server/utils/orders/read.js';
import { getOrderEvents } from '../server/utils/orders/events.js';
import { setOrderData, addOrderEvent } from '../server/utils/orders/data.js';
import { contactCustomer } from '../server/utils/orders/contact.js';

/*
  What the admin order page's tabs rely on: another extension changing its own part of an order (the shipping address),
  adding a line to the history (a label bought), and staff emailing the customer. The email itself is not sent here (no
  email service is configured in the test), so what is checked is everything before it and that a failure is reported.
*/

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  installFakeCard();
};

export const afterAll = async () => {
  restoreCard();
  await purge();
};

const sample = async () => {
  const item = await makeProduct({ name: 'Mug', price: 1250, quantity: 4 });
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: item.id, quantity: 1 }));
  const { order, payment } = ok(await placeOrder({ cartId: cart.id, checkoutKey: key().slice(0, 30), data: { shipping: { name: 'Ann', line1: '1 Test St' }, other: 'kept' }, billing: { name: 'Ann', email: 'ann@example.test', line1: '1 Test St' } }));
  await succeed(payment.id);
  ok(await completeOrder(order.id));
  return ok(await getOrder(order.id));
};

export default {
  'an extension changes its own key of the order data and nothing else, and the change is in the history': async ({ pass, fail }) => {
    const order = await sample();
    const address = { name: 'Ann Smith', line1: '9 New Rd', city: 'Burlington', state: 'VT', postalCode: '05401', country: 'US' };
    const data = ok(await setOrderData(order.id, 'shipping', address, { actor: 'user-1', summary: 'Shipping address changed' }));
    if(data.shipping.line1 !== '9 New Rd') return fail('the key was not changed');
    if(data.other !== 'kept') return fail('another key in the order data was lost');

    const reread = ok(await getOrder(order.id));
    if(reread.data.shipping.postalCode !== '05401' || reread.data.other !== 'kept') return fail('the change was not saved');

    const events = ok(await getOrderEvents(order.id));
    const entry = events.find(event => event.type === 'order_data');
    if(!entry) return fail('the change is not in the history');
    if(entry.actor !== 'user-1' || entry.visible !== false) return fail(`the entry should be private and name who did it: ${entry.actor} ${entry.visible}`);
    if(entry.data.summary !== 'Shipping address changed' || entry.data.key !== 'shipping') return fail(`the history keeps ${JSON.stringify(entry.data)}`);
    pass('only data.shipping changed, who did it is kept, and the history says so');
  },

  'order data is refused for a bad key, a missing order and a null byte': async ({ pass, fail }) => {
    const order = await sample();
    for(const badKey of ['', 'has space', '1starts-with-digit', 'x'.repeat(61), '__proto__ ', null]){
      const [error] = await setOrderData(order.id, badKey, {});
      if(error?.code !== 400) return fail(`${JSON.stringify(badKey)} was not refused`);
    }
    const [missing] = await setOrderData('ord_nope', 'shipping', {});
    if(missing?.code !== 404) return fail(`a missing order gave ${missing?.code}`);
    const [nul] = await setOrderData(order.id, 'shipping', { line1: 'a\u0000b' });
    if(nul?.code !== 400) return fail('a null byte was accepted');
    const [, events] = await getOrderEvents(order.id);
    if(events.some(event => event.type === 'order_data')) return fail('a refused change left a history entry');
    pass('400, 404 and 400 before anything is written');
  },

  'an extension adds a line to the history, private unless it says otherwise, with its own summary': async ({ pass, fail }) => {
    const order = await sample();
    const entry = ok(await addOrderEvent(order.id, 'label_bought', { actor: 'user-2', data: { summary: 'Label bought: USPS Ground Advantage, $5.73' } }));
    if(entry.visible !== false) return fail('the entry should be private by default');
    const shown = ok(await addOrderEvent(order.id, 'shipped_notice', { visible: true, data: { summary: 'Your order has shipped' } }));
    if(shown.visible !== true) return fail('visible was not kept');
    if(entry.data.summary !== 'Label bought: USPS Ground Advantage, $5.73') return fail('the summary was not kept');
    const [badType] = await addOrderEvent(order.id, 'bad type');
    const [missing] = await addOrderEvent('ord_nope', 'label_bought');
    if(badType?.code !== 400 || missing?.code !== 404) return fail(`bad inputs gave ${badType?.code} and ${missing?.code}`);
    pass('private by default, its own summary, bad inputs refused');
  },

  'emailing the customer checks the subject and message before anything is sent': async ({ pass, fail }) => {
    const order = await sample();
    const cases = [
      [{ subject: '', body: 'Hi' }, 400], [{ subject: '   ', body: 'Hi' }, 400], [{ subject: 'Hello', body: '' }, 400], [{ subject: 'Hello' }, 400],
      [{ subject: 'x'.repeat(201), body: 'Hi' }, 400], [{ subject: 'Hello', body: 'x'.repeat(5001) }, 400],
      [{ subject: 'two\nlines', body: 'Hi' }, 400], [{ subject: 'Hello', body: 'a\u0000b' }, 400],
    ];
    for(const [input, code] of cases){
      const [error] = await contactCustomer(order.id, input);
      if(error?.code !== code) return fail(`${JSON.stringify(input).slice(0, 60)} gave ${error?.code}, wanted ${code}`);
    }
    const [missing] = await contactCustomer('ord_nope', { subject: 'Hello', body: 'Hi' });
    if(missing?.code !== 404) return fail(`a missing order gave ${missing?.code}`);
    const events = ok(await getOrderEvents(order.id));
    if(events.some(event => event.type === 'message')) return fail('a refused email left a history entry');
    pass('subject and message are required, one line, and limited; a missing order is a 404');
  },

  'an email that cannot be sent is reported and leaves no "emailed" entry in the history': async ({ pass, fail }) => {
    const order = await sample();
    const [error, sent] = await contactCustomer(order.id, { subject: 'About your order', body: 'We have a question <b>about</b> it.' });
    if(sent) return fail('an email was reported sent with no email service configured');
    if(!error || !/could not be sent/i.test(error.msg)) return fail(`the failure was reported as "${error?.msg}"`);
    const events = ok(await getOrderEvents(order.id));
    if(events.some(event => event.type === 'message')) return fail('a failed email was noted as sent');
    pass(`reported: ${error.msg}`);
  },
};
