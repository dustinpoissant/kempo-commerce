import { renderEmailTemplate } from 'kempo/server/sdk.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { getOrder } from '../server/utils/orders/read.js';
import { buildContext, escapeHtml, orderLink } from '../server/utils/orders/emails.js';

/*
  Every email template renders with the data it is given, inside the site's email layout, and nothing a
  customer or a member of staff typed reaches it unescaped.
*/

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const TEMPLATES = ['order-processing', 'order-completed', 'order-on-hold', 'order-failed', 'order-cancelled', 'order-refunded', 'order-partial-refund', 'order-note'];

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
  const item = await makeProduct({ name: 'Mug <script>alert(1)</script>', price: 1250, quantity: 4 });
  const { cart } = ok(await resolveCart({}));
  ok(await addToCart({ cartId: cart.id, productId: item.id, quantity: 2 }));
  const { order, payment } = ok(await placeOrder({ cartId: cart.id, checkoutKey: key().slice(0, 30), billing: { name: 'Ann <b>Bold</b>', email: 'ann@example.test' } }));
  await succeed(payment.id);
  ok(await completeOrder(order.id));
  return ok(await getOrder(order.id));
};

export default {
  'every template renders with the order, in the layout, with nothing left unfilled': async ({ pass, fail }) => {
    const order = await sample();
    const context = await buildContext(order, { note: escapeHtml('A <i>note</i>'), refundAmount: '$5.00', refundReason: escapeHtml('Broken & late') });
    for(const template of TEMPLATES){
      const [error, html] = await renderEmailTemplate({ template: `kempo-commerce/${template}`, data: context });
      if(error) return fail(`${template}: ${error.msg}`);
      if(!html.includes('<html') || !html.includes('max-width: 600px')) return fail(`${template} is not in the email layout`);
      if(html.includes('{{')) return fail(`${template} has an unfilled {{...}}`);
      if(!html.includes(context.orderNumber)) return fail(`${template} does not name the order`);
    }
    const [, processing] = await renderEmailTemplate({ template: 'kempo-commerce/order-processing', data: context });
    if(!processing.includes('$25.00') || !processing.includes('&times; 2')) return fail('the lines and totals are missing');
    if(!processing.includes(order.id)) return fail('the link to the order is missing');
    pass(`${TEMPLATES.length} templates`);
  },

  'what customers and staff typed is escaped': async ({ pass, fail }) => {
    const order = await sample();
    const context = await buildContext(order, { note: escapeHtml('<img src=x onerror=alert(1)>') });
    const [, mail] = await renderEmailTemplate({ template: 'kempo-commerce/order-note', data: context });
    if(mail.includes('<img src=x') || mail.includes('<script>alert')) return fail('markup got through');
    const [, processing] = await renderEmailTemplate({ template: 'kempo-commerce/order-processing', data: context });
    if(processing.includes('<script>alert(1)</script>')) return fail('a product name was not escaped');
    if(!processing.includes('&lt;script&gt;')) return fail('the escaped product name is missing');
    if(escapeHtml(`"'&<>`) !== '&quot;&#39;&amp;&lt;&gt;') return fail('escapeHtml');
    pass('');
  },

  'the set-password email is worded for a new account and carries the link': async ({ pass, fail }) => {
    const [error, html] = await renderEmailTemplate({ template: 'kempo-commerce/set-password', data: { name: 'Ann', resetLink: 'https://shop.example.test/reset-password/abc' } });
    if(error) return fail(error.msg);
    if(!html.includes('https://shop.example.test/reset-password/abc') || !/Set your password/.test(html)) return fail('the link or the wording is missing');
    pass('');
  },

  'a guest is linked to their order, an account to their account page': async ({ pass, fail }) => {
    const base = 'https://shop.example.test';
    const guest = orderLink({ id: 'ord_1', userId: null, orderKey: 'k e/y' }, base);
    const member = orderLink({ id: 'ord_1', userId: 'u1' }, base);
    if(guest !== `${base}/commerce/order/ord_1/received/?key=k%20e%2Fy`) return fail(guest);
    if(member !== `${base}/commerce/account/orders/ord_1/`) return fail(member);
    pass('');
  },
};

void db;
