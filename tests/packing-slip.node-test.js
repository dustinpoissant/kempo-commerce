import { seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { getOrder } from '../server/utils/orders/read.js';
import { addressLines, itemsToPack, renderPackingSlip } from '../server/utils/orders/packingSlip.js';

/*
  The packing slip is an email template drawn from the order and handed back as HTML. What matters: it names the items and
  where they go with no prices, it escapes what customers wrote, an extension can add to it through the email-context guard,
  and an order with no address still draws.
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

const sample = async ({ shipping, name = 'Mug' } = {}) => {
  const item = await makeProduct({ name, price: 1250, quantity: 4 });
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: item.id, quantity: 2 }));
  const { order, payment } = ok(await placeOrder({ cartId: cart.id, checkoutKey: key().slice(0, 30), data: shipping ? { shipping } : {}, billing: { name: 'Ann', email: 'ann@example.test', line1: '1 Test St' } }));
  await succeed(payment.id);
  ok(await completeOrder(order.id));
  return ok(await getOrder(order.id));
};

export default {
  'the address is written as lines, and the items to pack are the ones that are sent': async ({ pass, fail }) => {
    const lines = addressLines({ name: 'Ann Smith', line1: '9 New Rd', line2: '', city: 'Burlington', state: 'VT', postalCode: '05401', country: 'US' });
    if(JSON.stringify(lines) !== JSON.stringify(['Ann Smith', '9 New Rd', 'Burlington, VT, 05401', 'US'])) return fail(`the address is ${JSON.stringify(lines)}`);
    if(addressLines(null).length || addressLines('x').length) return fail('a missing address should give no lines');
    const packed = itemsToPack([{ name: 'Shirt', fulfillment: 'pending' }, { name: 'Credits', fulfillment: 'none' }]);
    if(packed.length !== 1 || packed[0].name !== 'Shirt') return fail('an item that is not sent was packed');
    if(itemsToPack([{ name: 'Old', fulfillment: 'none' }]).length !== 1) return fail('an order that records no shipped lines should list everything');
    pass('address lines, and which items');
  },

  'the slip names the items and the address, has no prices, and escapes what customers wrote': async ({ pass, fail }) => {
    const order = await sample({ name: 'Mug <b>big</b>', shipping: { name: 'Ann <i>Smith</i>', line1: '9 New Rd', city: 'Burlington', state: 'VT', postalCode: '05401', country: 'US' } });
    const html = ok(await renderPackingSlip(order));
    if(!html.includes('Packing slip') || !html.includes(order.numberLabel ?? '#')) return fail('the heading or order number is missing');
    if(!html.includes('9 New Rd') || !html.includes('Burlington, VT, 05401')) return fail('the address is missing');
    if(!html.includes('Mug &lt;b&gt;big&lt;/b&gt;') || !html.includes('Ann &lt;i&gt;Smith&lt;/i&gt;')) return fail('names were not escaped');
    if(html.includes('<b>big</b>') || html.includes('<i>Smith</i>')) return fail('customer HTML got through');
    if(!/<td[^>]*>2<\/td>/.test(html)) return fail('the quantity is missing');
    if(/\$\s?\d/.test(html)) return fail('a price is on the packing slip');
    if(html.includes('{{')) return fail('something was left unfilled');
    pass('items, address, escaped, no prices');
  },

  'an order with no address still draws, without a Ship to heading': async ({ pass, fail }) => {
    const html = ok(await renderPackingSlip(await sample()));
    if(html.includes('Ship to')) return fail('Ship to is shown with nothing under it');
    if(!html.includes('Mug')) return fail('the item is missing');
    pass('no address, no heading');
  },
};
