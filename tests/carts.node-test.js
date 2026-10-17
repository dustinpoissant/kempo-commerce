import { eq } from 'drizzle-orm';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, changeProduct, freshUser } from './helpers/shop.js';
import { kempoCommerceCart, kempoCommerceCartLine } from '../server/db/schema.js';
import { resolveCart, getCart, addToCart, updateCartLine, removeCartLine, clearCart, mergeCarts, setCartData } from '../server/utils/carts/cart.js';
import { setSetting } from 'kempo/server/sdk.js';

/*
  The cart: who has which, what adding does, what the catalog says back, and what signing in does.
*/

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.msg}`);
  return value;
};

const refused = ([error], code) => {
  if(!error) throw new Error('expected an error');
  if(code && error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.msg}`);
  return error;
};

const visitorCart = async () => {
  const { cart, token } = ok(await resolveCart({}));
  return { cartId: cart.id, token };
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await purge();
};

export default {
  'a visitor gets a cart and a token, and the same token finds the same cart': async ({ pass, fail }) => {
    const first = ok(await resolveCart({}));
    if(!first.token || !first.cart) return fail('no cart or token was issued');
    if(first.cart.token === first.token) return fail('the token was stored in the clear');
    const again = ok(await resolveCart({ token: first.token }));
    if(again.cart.id !== first.cart.id) return fail('the token found a different cart');
    if(again.token) return fail('a second token was issued for an existing cart');
    const stranger = ok(await resolveCart({ token: 'not-a-real-token' }));
    if(stranger.cart.id === first.cart.id) return fail('a made-up token reached someone else\'s cart');
    const none = ok(await resolveCart({ token: 'not-a-real-token', create: false }));
    if(none.cart) return fail('create: false made a cart');
    pass('');
  },

  'adding prices the line from the catalog and returns the cart with totals': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const car = await makeProduct({ name: 'Car', price: 2500 });
    const { cart } = ok(await addToCart({ cartId, productId: car.id, quantity: 2 }));
    if(cart.lines.length !== 1 || cart.lines[0].quantity !== 2) return fail('wrong lines');
    if(cart.lines[0].unitPrice !== 2500 || cart.lines[0].lineTotal !== 5000) return fail('wrong price');
    if(cart.totals.subtotal !== 5000 || cart.totals.total !== 5000) return fail(`totals ${JSON.stringify(cart.totals)}`);
    if(cart.itemCount !== 2 || cart.blocked) return fail('item count or blocked');
    pass('');
  },

  'adding the same product again raises the quantity; other choices or data are another line': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const shirt = await makeProduct({ name: 'Shirt', options: [{ label: 'Size', choices: [{ label: 'Small' }, { label: 'Large', price: 200 }] }] });
    ok(await addToCart({ cartId, productId: shirt.id, selections: { size: 'small' } }));
    let { cart } = ok(await addToCart({ cartId, productId: shirt.id, selections: { size: 'small' }, quantity: 2 }));
    if(cart.lines.length !== 1 || cart.lines[0].quantity !== 3) return fail('the same line did not merge');
    ({ cart } = ok(await addToCart({ cartId, productId: shirt.id, selections: { size: 'large' } })));
    if(cart.lines.length !== 2) return fail('another choice should be another line');
    if(cart.lines.find(line => line.selections.size === 'large').unitPrice !== 1200) return fail('the choice\'s price was not used');
    ({ cart } = ok(await addToCart({ cartId, productId: shirt.id, selections: { size: 'small' }, data: { engraving: 'AB' } })));
    if(cart.lines.length !== 3) return fail('different extension data should be another line');
    refused(await addToCart({ cartId, productId: shirt.id, selections: { size: 'huge' } }));
    refused(await addToCart({ cartId, productId: shirt.id }), 400);
    pass('');
  },

  'the same line added at once is one line with the right quantity': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const item = await makeProduct();
    const results = await Promise.all(Array.from({ length: 6 }, () => addToCart({ cartId, productId: item.id })));
    for(const result of results) ok(result);
    const lines = await db.select().from(kempoCommerceCartLine).where(eq(kempoCommerceCartLine.cartId, cartId));
    if(lines.length !== 1 || lines[0].quantity !== 6) return fail(`${lines.length} lines, quantity ${lines[0]?.quantity}`);
    pass('');
  },

  'what cannot be bought cannot be added': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const draft = await makeProduct({ status: 'draft' });
    const sold = await makeProduct({ availability: 'sold' });
    const empty = await makeProduct({ quantity: 0 });
    const unpriced = await makeProduct({ price: null });
    for(const product of [draft, sold, empty, unpriced]) refused(await addToCart({ cartId, productId: product.id }), 409);
    refused(await addToCart({ cartId, productId: 'ffffffffffffffff' }), 404);
    refused(await addToCart({ cartId, productId: draft.id, quantity: 0 }), 400);
    refused(await addToCart({ cartId, productId: draft.id, quantity: 1.5 }), 400);
    refused(await addToCart({ cartId: 'nope', productId: draft.id }), 404);
    pass('');
  },

  'quantity is held to what is available and to the per-line limit': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const scarce = await makeProduct({ quantity: 3 });
    let { cart } = ok(await addToCart({ cartId, productId: scarce.id, quantity: 10 }));
    if(cart.lines[0].quantity !== 3) return fail(`quantity ${cart.lines[0].quantity}, quantity is 3`);
    refused(await addToCart({ cartId, productId: scarce.id }), 409);

    await setSetting('kempo-commerce', 'max_quantity_per_line', 5, 'number', false, null);
    const plenty = await makeProduct();
    ({ cart } = ok(await addToCart({ cartId, productId: plenty.id, quantity: 4 })));
    ({ cart } = ok(await addToCart({ cartId, productId: plenty.id, quantity: 4 })));
    const line = cart.lines.find(candidate => candidate.productId === plenty.id);
    if(line.quantity !== 5) return fail(`quantity ${line.quantity}, limit is 5`);
    refused(await addToCart({ cartId, productId: plenty.id }), 409);
    await purge();
    pass('');
  },

  'the catalog changing under a cart is reported, not hidden': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const item = await makeProduct({ price: 1000, quantity: 10 });
    ok(await addToCart({ cartId, productId: item.id, quantity: 4 }));

    await changeProduct(item.id, { price: 1500 });
    let cart = ok(await getCart({ cartId }));
    if(!cart.notices.some(notice => notice.type === 'price_changed')) return fail('no price_changed notice');
    if(cart.lines[0].unitPrice !== 1500 || cart.totals.subtotal !== 6000) return fail('the new price was not used');
    cart = ok(await getCart({ cartId }));
    if(cart.notices.some(notice => notice.type === 'price_changed')) return fail('the price notice should only be said once');

    await changeProduct(item.id, { quantity: 2 });
    cart = ok(await getCart({ cartId }));
    if(!cart.notices.some(notice => notice.type === 'out_of_stock' && !notice.blocking)) return fail('no reduced-quantity notice');
    if(cart.lines[0].quantity !== 2) return fail(`quantity ${cart.lines[0].quantity}, quantity is 2`);

    await changeProduct(item.id, { quantity: 0 });
    cart = ok(await getCart({ cartId }));
    if(!cart.notices.some(notice => notice.type === 'out_of_stock' && notice.blocking) || !cart.blocked) return fail('sold out should block checkout');

    await changeProduct(item.id, { quantity: 5, status: 'draft' });
    cart = ok(await getCart({ cartId }));
    if(!cart.notices.some(notice => notice.type === 'unavailable' && notice.blocking)) return fail('an unpublished product should block checkout');
    pass('');
  },

  'a choice that goes out of stock blocks the line': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const item = await makeProduct({ options: [{ label: 'Color', choices: [{ label: 'Red' }, { label: 'Blue' }] }] });
    ok(await addToCart({ cartId, productId: item.id, selections: { color: 'red' } }));
    const fresh = await changeProduct(item.id, { options: [{ label: 'Color', key: 'color', choices: [{ label: 'Red', key: 'red', available: false }, { label: 'Blue', key: 'blue' }] }] });
    if(!fresh) return fail('could not change the options');
    const cart = ok(await getCart({ cartId }));
    if(!cart.notices.some(notice => notice.type === 'option_unavailable' && notice.blocking)) return fail(`notices: ${JSON.stringify(cart.notices)}`);
    pass('');
  },

  'update, remove and clear': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    const one = await makeProduct();
    const two = await makeProduct();
    let { cart } = ok(await addToCart({ cartId, productId: one.id }));
    ok(await addToCart({ cartId, productId: two.id }));
    const lineId = cart.lines[0].id;
    ({ cart } = ok(await updateCartLine({ cartId, lineId, quantity: 4 })));
    if(cart.lines.find(line => line.id === lineId).quantity !== 4) return fail('quantity not updated');
    refused(await updateCartLine({ cartId, lineId, quantity: -1 }), 400);
    refused(await updateCartLine({ cartId, lineId: 'nope', quantity: 1 }), 404);
    ({ cart } = ok(await updateCartLine({ cartId, lineId, quantity: 0 })));
    if(cart.lines.length !== 1) return fail('quantity 0 should remove the line');
    refused(await removeCartLine({ cartId, lineId }), 404);
    ({ cart } = ok(await clearCart({ cartId })));
    if(cart.lines.length !== 0 || !cart.blocked) return fail('clear left lines, or an empty cart is not blocked');
    pass('');
  },

  'a cart holds at most the configured number of lines': async ({ pass, fail }) => {
    await setSetting('kempo-commerce', 'max_lines_per_cart', 2, 'number', false, null);
    const { cartId } = await visitorCart();
    ok(await addToCart({ cartId, productId: (await makeProduct()).id }));
    ok(await addToCart({ cartId, productId: (await makeProduct()).id }));
    refused(await addToCart({ cartId, productId: (await makeProduct()).id }), 409);
    await purge();
    pass('');
  },

  'signing in merges the visitor\'s cart into the customer\'s': async ({ pass, fail }) => {
    const userId = freshUser();
    const shared = await makeProduct();
    const onlyVisitor = await makeProduct();
    const onlyMine = await makeProduct();

    const mine = ok(await resolveCart({ userId })).cart;
    ok(await addToCart({ cartId: mine.id, productId: shared.id, quantity: 1 }));
    ok(await addToCart({ cartId: mine.id, productId: onlyMine.id }));

    const { cartId, token } = await visitorCart();
    ok(await addToCart({ cartId, productId: shared.id, quantity: 2 }));
    ok(await addToCart({ cartId, productId: onlyVisitor.id }));

    const signedIn = ok(await resolveCart({ userId, token }));
    if(signedIn.cart.id !== mine.id) return fail('the customer did not keep their own cart');
    if(!signedIn.clearToken) return fail('the visitor cookie should be dropped');
    const cart = ok(await getCart({ cartId: mine.id }));
    const byProduct = Object.fromEntries(cart.lines.map(line => [line.productId, line.quantity]));
    if(byProduct[shared.id] !== 3 || byProduct[onlyVisitor.id] !== 1 || byProduct[onlyMine.id] !== 1) return fail(`merged: ${JSON.stringify(byProduct)}`);

    const [visitor] = await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, cartId));
    if(visitor.status !== 'merged') return fail(`the visitor cart is ${visitor.status}`);
    const again = ok(await mergeCarts({ from: cartId, into: mine.id }));
    if(again.merged !== 0) return fail('merging twice added the lines twice');
    const afterwards = ok(await getCart({ cartId: mine.id }));
    if(afterwards.lines.find(line => line.productId === shared.id).quantity !== 3) return fail('the second merge changed a quantity');
    pass('');
  },

  'a customer with no cart adopts the visitor\'s on signing in': async ({ pass, fail }) => {
    const userId = freshUser();
    const { cartId, token } = await visitorCart();
    ok(await addToCart({ cartId, productId: (await makeProduct()).id }));
    const signedIn = ok(await resolveCart({ userId, token }));
    if(signedIn.cart.id !== cartId) return fail('the cart was not adopted');
    if(signedIn.cart.userId !== userId || signedIn.cart.token !== null) return fail('the adopted cart should belong to the user and lose its token');
    const again = ok(await resolveCart({ userId }));
    if(again.cart.id !== cartId) return fail('the customer does not find their cart again');
    pass('');
  },

  'extension data on a cart is merged in': async ({ pass, fail }) => {
    const { cartId } = await visitorCart();
    ok(await setCartData(cartId, { gift: true }));
    const { data } = ok(await setCartData(cartId, { note: 'hi' }));
    if(data.gift !== true || data.note !== 'hi') return fail(`data ${JSON.stringify(data)}`);
    refused(await setCartData(cartId, 'text'), 400);
    refused(await setCartData(cartId, { big: 'x'.repeat(10000) }), 400);
    pass('');
  },
};
