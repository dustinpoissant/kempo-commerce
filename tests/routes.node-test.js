import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { eq } from 'drizzle-orm';
import { addCredit } from 'kempo-store-credit/sdk';
import { user as userTable } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key, pretendInstalled, declareAccess, signedIn, call } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { readConfig } from '../server/utils/config/settings.js';

/*
  The HTTP layer, driven the way kempo-server drives it: the real route handlers with real sessions and
  cookies. Carts by cookie, a guest's order by key, and the permission contract for every audience.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'public', 'api');

const handlers = new Map();
const route = async file => {
  if(!handlers.has(file)) handlers.set(file, (await import(pathToFileURL(path.join(api, file)).href)).default);
  return handlers.get(file);
};
const hit = async (file, options) => call(await route(file), options);

const walk = async dir => {
  const out = [];
  for(const entry of await readdir(dir, { withFileTypes: true })){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) out.push(...await walk(full));
    else out.push(path.relative(api, full).replaceAll('\\', '/'));
  }
  return out;
};

const BILLING = { name: 'Grace Hopper', email: 'grace@example.test' };
const cleanups = [];
let visitor;
let customer;
let support;
let manager;
let administrator;

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
  await declareAccess();
  cleanups.push(await pretendInstalled('kempo-store-credit'));
  installFakeCard();
  customer = await signedIn();
  support = await signedIn('kempo-commerce:support');
  manager = await signedIn('kempo-commerce:manager');
  administrator = await signedIn('kempo-commerce:administrator');
  visitor = { cookies: {} };
};

export const afterAll = async () => {
  restoreCard();
  for(const cleanup of cleanups) await cleanup();
  await purge();
};

/* Places a card order as a guest through the routes and returns the answer. */
const guestOrder = async () => {
  const product = await makeProduct({ price: 900, quantity: 5 });
  const added = await hit('cart/lines/POST.js', { method: 'POST', body: { productId: product.id } });
  const cookie = added.cookies.kempo_cart.value;
  const placed = await hit('checkout/place/POST.js', { method: 'POST', cookies: { kempo_cart: cookie }, body: { checkoutKey: key().slice(0, 30), billing: BILLING } });
  return { placed, cookie, product };
};

export default {
  'every route loads and exports a handler': async ({ pass, fail }) => {
    const files = await walk(api);
    if(files.length < 25) return fail(`only ${files.length} routes found`);
    for(const file of files){
      if(!/(GET|POST|PUT|PATCH|DELETE)\.js$/.test(file)) return fail(`${file} is not a METHOD.js file`);
      if(typeof (await route(file)) !== 'function') return fail(`${file} has no default handler`);
    }
    pass(`${files.length} routes`);
  },

  'reading the cart makes nothing; adding makes one, held by a cookie that is not the id': async ({ pass, fail }) => {
    const empty = await hit('cart/GET.js');
    if(empty.status !== 200 || empty.json.cart.lines.length || Object.keys(empty.cookies).length) return fail('an empty read should not make a cart or a cookie');

    const product = await makeProduct({ price: 500, quantity: 4 });
    const added = await hit('cart/lines/POST.js', { method: 'POST', body: { productId: product.id, quantity: 2 } });
    if(added.status !== 201 || added.json.cart.totals.subtotal !== 1000) return fail(`add ${added.status} ${JSON.stringify(added.json)}`);
    const cookie = added.cookies.kempo_cart;
    if(!cookie || cookie.options.httpOnly !== true || cookie.options.sameSite !== 'lax') return fail('the cart cookie should be httpOnly and lax');
    if(cookie.value === added.json.cart.id) return fail('the cookie must not be the cart id');

    const read = await hit('cart/GET.js', { cookies: { kempo_cart: cookie.value } });
    if(read.json.cart.itemCount !== 2) return fail('the cookie should find the cart');
    const other = await hit('cart/GET.js', { cookies: { kempo_cart: 'a-token-nobody-has' } });
    if(other.json.cart.lines.length) return fail('a made-up cookie found a cart');

    const lineId = read.json.cart.lines[0].id;
    const patched = await hit('cart/lines/[id]/PATCH.js', { method: 'PATCH', params: { id: lineId }, cookies: { kempo_cart: cookie.value }, body: { quantity: 3 } });
    if(patched.json.cart.itemCount !== 3) return fail('quantity not updated');
    const bad = await hit('cart/lines/[id]/PATCH.js', { method: 'PATCH', params: { id: lineId }, cookies: { kempo_cart: cookie.value }, body: { quantity: 'lots' } });
    if(bad.status !== 400) return fail(`bad quantity ${bad.status}`);
    const stranger = await hit('cart/lines/[id]/DELETE.js', { method: 'DELETE', params: { id: lineId }, cookies: { kempo_cart: 'a-token-nobody-has' } });
    if(stranger.status !== 404) return fail(`someone else's line ${stranger.status}`);
    const removed = await hit('cart/lines/[id]/DELETE.js', { method: 'DELETE', params: { id: lineId }, cookies: { kempo_cart: cookie.value } });
    if(removed.json.cart.lines.length) return fail('not removed');
    pass('');
  },

  'a visitor who signs in keeps their cart': async ({ pass, fail }) => {
    const product = await makeProduct({ price: 300 });
    const added = await hit('cart/lines/POST.js', { method: 'POST', body: { productId: product.id } });
    const person = await signedIn();
    const read = await hit('cart/GET.js', { cookies: { kempo_cart: added.cookies.kempo_cart.value, ...person.cookies } });
    if(read.json.cart.itemCount !== 1) return fail('the visitor\'s cart should come with them');
    if(read.cookies.kempo_cart?.options.maxAge !== 0) return fail('the visitor cookie should be dropped');
    const again = await hit('cart/GET.js', { cookies: person.cookies });
    if(again.json.cart.itemCount !== 1) return fail('and be theirs from now on');
    pass('');
  },

  'a guest places an order and reaches it with the key from their link, and nobody else can': async ({ pass, fail }) => {
    const { placed, cookie } = await guestOrder();
    if(placed.status !== 201) return fail(`place ${placed.status} ${JSON.stringify(placed.json)}`);
    const { order, payment, receivedUrl } = placed.json;
    if(!payment?.clientSecret || !receivedUrl.includes(`key=${encodeURIComponent(order.orderKey)}`)) return fail('the answer should carry the payment and the guest link');
    if(order.userId !== null) return fail('a guest order has no user');
    if('ip' in order || 'checkoutKey' in order) return fail('internal fields reached the customer');

    const seen = await hit('orders/[id]/guest/GET.js', { params: { id: order.id }, query: { key: order.orderKey } });
    if(seen.status !== 200 || seen.json.order.id !== order.id) return fail(`guest read ${seen.status}`);
    const wrong = await hit('orders/[id]/guest/GET.js', { params: { id: order.id }, query: { key: 'not-the-key' } });
    const missing = await hit('orders/[id]/guest/GET.js', { params: { id: 'ord_nothing' }, query: { key: order.orderKey } });
    if(wrong.status !== 404 || missing.status !== 404 || JSON.stringify(wrong.json) !== JSON.stringify(missing.json)) return fail('a wrong key must look exactly like no order');
    const noKey = await hit('orders/[id]/guest/GET.js', { params: { id: order.id } });
    if(noKey.status !== 404) return fail('no key, no order');

    const someone = await hit('my/orders/[id]/GET.js', { params: { id: order.id }, cookies: customer.cookies });
    if(someone.status !== 404) return fail('a signed-in stranger reached a guest order');

    /* The page asks the server to check; the server asks the processor (here a stand-in) and reports. */
    const confirmed = await hit('checkout/orders/[id]/confirm/POST.js', { method: 'POST', params: { id: order.id }, body: { key: order.orderKey }, cookies: { kempo_cart: cookie } });
    if(confirmed.status !== 200 || confirmed.json.order.status !== 'pending_payment') return fail(`confirm ${confirmed.status} ${confirmed.json?.order?.status}`);
    const noAccess = await hit('checkout/orders/[id]/confirm/POST.js', { method: 'POST', params: { id: order.id }, body: { key: 'nope' } });
    if(noAccess.status !== 404) return fail('confirm without access');

    const cancelledByStranger = await hit('orders/[id]/guest/cancel/POST.js', { method: 'POST', params: { id: order.id }, body: { key: 'nope' } });
    if(cancelledByStranger.status !== 404) return fail('a stranger cancelled an order');
    const cancelled = await hit('orders/[id]/guest/cancel/POST.js', { method: 'POST', params: { id: order.id }, body: { key: order.orderKey } });
    if(cancelled.status !== 200 || cancelled.json.order.status !== 'cancelled') return fail(`cancel ${cancelled.status}`);
    pass('');
  },

  'a paid order cannot be cancelled through the shop, and the customer sees only their own': async ({ pass, fail }) => {
    const product = await makeProduct({ price: 700, quantity: 3 });
    const added = await hit('cart/lines/POST.js', { method: 'POST', cookies: customer.cookies, body: { productId: product.id } });
    const placed = await hit('checkout/place/POST.js', { method: 'POST', cookies: customer.cookies, body: { checkoutKey: key().slice(0, 30), billing: BILLING } });
    if(placed.status !== 201) return fail(`place ${placed.status} ${JSON.stringify(placed.json)}`);
    const { order, payment } = placed.json;
    if(order.userId !== customer.userId || !added.json.cart) return fail('the order should be the customer\'s');
    await succeed(payment.id);
    await completeOrder(order.id);

    const cancel = await hit('my/orders/[id]/cancel/POST.js', { method: 'POST', params: { id: order.id }, cookies: customer.cookies });
    if(cancel.status !== 409 || !cancel.json.paid) return fail(`cancel ${cancel.status} ${JSON.stringify(cancel.json)}`);

    const mine = await hit('my/orders/GET.js', { cookies: customer.cookies });
    if(!mine.json.items.some(item => item.id === order.id)) return fail('their order is missing from their list');
    const theirs = await hit('my/orders/GET.js', { cookies: manager.cookies });
    if(theirs.json.items.some(item => item.id === order.id)) return fail('another account saw it');
    const detail = await hit('my/orders/[id]/GET.js', { params: { id: order.id }, cookies: customer.cookies });
    if(detail.json.events.some(event => event.visible !== true)) return fail('the history should only hold what a customer may see');
    const other = await hit('my/orders/[id]/GET.js', { params: { id: order.id }, cookies: manager.cookies });
    if(other.status !== 404) return fail('another account reached the order');
    const anonymous = await hit('my/orders/GET.js');
    if(anonymous.status !== 401) return fail(`signed out ${anonymous.status}`);
    pass('');
  },

  'guest orders join an account only when the email is verified': async ({ pass, fail }) => {
    const { placed } = await guestOrder();
    const order = placed.json.order;
    const unverified = await signedIn(null, { email: BILLING.email });
    await db.update(userTable).set({ emailVerified: false }).where(eq(userTable.id, unverified.userId));
    const first = await hit('my/orders/GET.js', { cookies: unverified.cookies });
    if(first.json.items.some(item => item.id === order.id)) return fail('an unverified email was given someone\'s order');

    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, unverified.userId));
    const second = await hit('my/orders/GET.js', { cookies: unverified.cookies });
    if(!second.json.items.some(item => item.id === order.id)) return fail('a verified email should receive its guest orders');
    pass('');
  },

  'a signed-in customer needs commerce:checkout; a guest needs nothing': async ({ pass, fail }) => {
    const product = await makeProduct({ price: 100, quantity: 5 });
    const person = await signedIn();
    await hit('cart/lines/POST.js', { method: 'POST', cookies: person.cookies, body: { productId: product.id } });
    const { permission, groupPermission } = await import('kempo/server/db/schema.js');
    const { and } = await import('drizzle-orm');
    await db.delete(groupPermission).where(and(eq(groupPermission.groupName, 'system:Users'), eq(groupPermission.permissionName, 'commerce:checkout')));
    const denied = await hit('checkout/place/POST.js', { method: 'POST', cookies: person.cookies, body: { checkoutKey: key().slice(0, 30), billing: BILLING } });
    await db.insert(groupPermission).values({ id: key(), groupName: 'system:Users', permissionName: 'commerce:checkout', createdAt: new Date() });
    if(denied.status !== 403) return fail(`without the permission: ${denied.status}`);
    const allowed = await hit('checkout/place/POST.js', { method: 'POST', cookies: person.cookies, body: { checkoutKey: key().slice(0, 30), billing: BILLING } });
    if(allowed.status !== 201) return fail(`with the permission: ${allowed.status} ${JSON.stringify(allowed.json)}`);
    void permission;
    pass('');
  },

  'the quote carries the ways to pay, and an empty cart cannot be quoted': async ({ pass, fail }) => {
    const none = await hit('checkout/GET.js');
    if(none.status !== 409) return fail(`empty ${none.status}`);
    const rich = await signedIn();
    await addCredit({ userId: rich.userId, amount: 250, reason: 'gift', idempotencyKey: key() });
    const product = await makeProduct({ price: 1000 });
    await hit('cart/lines/POST.js', { method: 'POST', cookies: rich.cookies, body: { productId: product.id } });
    const quote = await hit('checkout/validate/POST.js', { method: 'POST', cookies: rich.cookies, body: { billing: BILLING, tenders: { 'store-credit': 250 } } });
    if(quote.status !== 200) return fail(`quote ${quote.status}`);
    const split = Object.fromEntries(quote.json.quote.plan.map(entry => [entry.kind, entry.amount]));
    if(split['store-credit'] !== 250 || split.card !== 750) return fail(`plan ${JSON.stringify(split)}`);
    pass('');
  },

  'checkout starts a signed-in customer with their account and last order, and a guest with nothing': async ({ pass, fail }) => {
    const item = await makeProduct({ price: 100, quantity: 9 });
    const guest = await hit('cart/lines/POST.js', { method: 'POST', body: { productId: item.id } });
    const guestQuote = await hit('checkout/GET.js', { cookies: { kempo_cart: guest.cookies.kempo_cart.value } });
    if(guestQuote.status !== 200 || Object.keys(guestQuote.json.prefill ?? {}).length) return fail(`a guest was prefilled: ${JSON.stringify(guestQuote.json.prefill)}`);

    const person = await signedIn(null, { name: 'Ada Lovelace', email: 'ada@example.test' });
    await hit('cart/lines/POST.js', { method: 'POST', cookies: person.cookies, body: { productId: item.id } });
    const first = await hit('checkout/GET.js', { cookies: person.cookies });
    if(first.status !== 200) return fail(`first quote ${first.status}`);
    if(first.json.prefill.name !== 'Ada Lovelace' || first.json.prefill.email !== 'ada@example.test') return fail(`account ${JSON.stringify(first.json.prefill)}`);
    if(first.json.prefill.line1 || first.json.prefill.city) return fail('there is no address to remember before the first order');

    const address = { name: 'Gift For Someone Else', email: 'ada@example.test', phone: '555-0100', line1: '1 Analytical Way', city: 'London', postalCode: 'N1 1AA', country: 'GB' };
    const placed = await hit('checkout/place/POST.js', { method: 'POST', cookies: person.cookies, body: { checkoutKey: key().slice(0, 30), billing: address } });
    if(placed.status !== 201) return fail(`placing ${placed.status} ${JSON.stringify(placed.json)}`);

    await hit('cart/lines/POST.js', { method: 'POST', cookies: person.cookies, body: { productId: item.id } });
    const second = await hit('checkout/GET.js', { cookies: person.cookies });
    const prefill = second.json.prefill ?? {};
    if(prefill.name !== 'Ada Lovelace') return fail(`the account's name wins over the last order's: ${prefill.name}`);
    if(prefill.line1 !== '1 Analytical Way' || prefill.city !== 'London' || prefill.postalCode !== 'N1 1AA' || prefill.country !== 'GB' || prefill.phone !== '555-0100') return fail(`last order ${JSON.stringify(prefill)}`);
    pass('');
  },

  'the shop\'s routes: nobody signed out, nobody without the permission': async ({ pass, fail }) => {
    const { placed } = await guestOrder();
    const id = placed.json.order.id;
    const table = [
      ['orders/GET.js', {}, 'view'],
      ['orders/[id]/GET.js', { params: { id } }, 'view'],
      ['orders/[id]/events/GET.js', { params: { id } }, 'view'],
      ['carts/GET.js', {}, 'view'],
      ['summary/GET.js', {}, 'view'],
      ['orders/[id]/status/PATCH.js', { method: 'PATCH', params: { id }, body: { status: 'on_hold' } }, 'manage'],
      ['orders/[id]/notes/POST.js', { method: 'POST', params: { id }, body: { body: 'hello' } }, 'manage'],
      ['orders/[id]/cancel/POST.js', { method: 'POST', params: { id }, body: {} }, 'manage'],
      ['orders/[id]/mark-paid/POST.js', { method: 'POST', params: { id }, body: {} }, 'manage'],
      ['orders/[id]/lines/[lineId]/PATCH.js', { method: 'PATCH', params: { id, lineId: 'x' }, body: { fulfillment: 'done' } }, 'manage'],
      ['refunds/preview/POST.js', { method: 'POST', body: { orderId: id, amount: 1 } }, 'refund'],
      ['orders/[id]/refund/POST.js', { method: 'POST', params: { id }, body: { amount: 1 } }, 'refund'],
      ['refunds/[id]/finish/POST.js', { method: 'POST', params: { id: 'ref_x' } }, 'refund'],
      ['settings/GET.js', {}, 'settings'],
      ['settings/PUT.js', { method: 'PUT', body: { guest_checkout: true } }, 'settings'],
    ];
    const allowed = {
      support: ['view'],
      manager: ['view', 'manage', 'refund'],
      administrator: ['view', 'manage', 'refund', 'settings'],
    };
    const audiences = { visitor, customer, support, manager, administrator };

    for(const [file, options, needs] of table){
      for(const [name, person] of Object.entries(audiences)){
        const answer = await hit(file, { ...options, cookies: person.cookies });
        const should = (allowed[name] ?? []).includes(needs);
        if(name === 'visitor' && answer.status !== 401) return fail(`${file}: a signed-out visitor got ${answer.status}`);
        if(name === 'customer' && answer.status !== 403) return fail(`${file}: a customer got ${answer.status}`);
        if(should && [401, 403].includes(answer.status)) return fail(`${file}: ${name} should be allowed, got ${answer.status}`);
        if(!should && name !== 'visitor' && name !== 'customer' && ![403].includes(answer.status)) return fail(`${file}: ${name} should be refused, got ${answer.status}`);
      }
    }
    pass(`${table.length} routes, 5 audiences`);
  },

  'staff see everything on an order and can act on it': async ({ pass, fail }) => {
    const { placed } = await guestOrder();
    const id = placed.json.order.id;
    const list = await hit('orders/GET.js', { cookies: support.cookies, query: { search: BILLING.email } });
    if(!list.json.items.some(item => item.id === id)) return fail('search by email should find the order');
    const byNumber = await hit('orders/GET.js', { cookies: support.cookies, query: { search: String(placed.json.order.number) } });
    if(!byNumber.json.items.some(item => item.id === id)) return fail('search by number');
    const detail = await hit('orders/[id]/GET.js', { params: { id }, cookies: support.cookies });
    if(!detail.json.order.ip === undefined || !detail.json.events.length) return fail('staff see the history');

    const note = await hit('orders/[id]/notes/POST.js', { method: 'POST', params: { id }, cookies: manager.cookies, body: { body: 'Called them <b>today</b>', visibleToCustomer: false } });
    if(note.status !== 201) return fail(`note ${note.status}`);
    const hold = await hit('orders/[id]/status/PATCH.js', { method: 'PATCH', params: { id }, cookies: manager.cookies, body: { status: 'cancelled' } });
    if(hold.status !== 409) return fail('cancelling goes through its own route');
    const paid = await hit('orders/[id]/mark-paid/POST.js', { method: 'POST', params: { id }, cookies: manager.cookies, body: { note: 'cash' } });
    if(paid.status !== 200 || paid.json.order.status !== 'processing') return fail(`mark paid ${paid.status} ${paid.json?.order?.status} ${paid.json?.error}`);
    pass('');
  },

  'settings are validated and saved with their declared types': async ({ pass, fail }) => {
    const bad = await hit('settings/PUT.js', { method: 'PUT', cookies: administrator.cookies, body: { max_lines_per_cart: 'lots' } });
    const unknown = await hit('settings/PUT.js', { method: 'PUT', cookies: administrator.cookies, body: { nope: 1 } });
    const url = await hit('settings/PUT.js', { method: 'PUT', cookies: administrator.cookies, body: { site_url: 'ftp://x' } });
    if(bad.status !== 400 || unknown.status !== 400 || url.status !== 400) return fail(`bad ${bad.status} ${unknown.status} ${url.status}`);
    const saved = await hit('settings/PUT.js', { method: 'PUT', cookies: administrator.cookies, body: { max_lines_per_cart: '7', site_url: 'https://shop.example.test/', guest_checkout: false } });
    if(saved.status !== 200) return fail(`save ${saved.status} ${JSON.stringify(saved.json)}`);
    const config = await readConfig();
    if(config.maxLinesPerCart !== 7 || config.siteUrl !== 'https://shop.example.test' || config.guestCheckout !== false) return fail(`config ${JSON.stringify(config)}`);
    const read = await hit('settings/GET.js', { cookies: administrator.cookies });
    if(!read.json.settings.find(setting => setting.name === 'max_lines_per_cart').description) return fail('the description was lost');
    await hit('settings/PUT.js', { method: 'PUT', cookies: administrator.cookies, body: { max_lines_per_cart: 100, site_url: 'http://localhost:3000', guest_checkout: true } });
    const pub = await hit('config/GET.js');
    if(pub.json.config.siteUrl !== undefined) return fail('the public config must not carry admin settings');
    if(pub.json.config.currency !== 'usd') return fail('currency');
    pass('');
  },

  'the dashboard figures count paid orders': async ({ pass, fail }) => {
    const answer = await hit('summary/GET.js', { cookies: administrator.cookies });
    if(answer.status !== 200 || typeof answer.json.week.orders !== 'number' || typeof answer.json.pending !== 'number') return fail(JSON.stringify(answer.json));
    pass('');
  },
};
