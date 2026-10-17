import db from 'kempo/server/db/index.js';
import { and, asc, eq, sql, inArray } from 'drizzle-orm';
import { creditsEnabled, getCreditsPerUnit, computePrice, unavailableReason, resolveImages, UNLIMITED } from 'kempo-products/sdk';
import { kempoCommerceCart, kempoCommerceCartLine } from '../../db/schema.js';
import newId, { secret, hashToken } from '../ids.js';
import { readConfig } from '../config/settings.js';
import { EVENTS, guard, notify } from '../hooks.js';
import lineKey from './lineKey.js';
import { checkLine, loadProducts, readCurrency } from './catalog.js';
import { collectAdjustments, computeTotals } from '../totals.js';

/*
  The cart. A visitor's is held by a random token in a cookie (stored hashed); a signed-in customer has
  one open cart with `userId` set. Signing in merges the visitor's cart into the customer's.

  These are data operations with no permission checks of their own: the routes work out whose cart it
  is from the session or the cookie, and pass its id in. Every function returns `[error, data]`.

  Nothing is reserved by a cart. Only a checkout holds quantity, and only briefly.
*/

const MAX_DATA_BYTES = 4096;
const MAX_QUANTITY = 1000000;

const touch = async (cartId, config) => {
  const now = new Date();
  await db.update(kempoCommerceCart)
    .set({ updatedAt: now, expiresAt: new Date(now.getTime() + config.cartExpiryDays * 86400000) })
    .where(eq(kempoCommerceCart.id, cartId));
};

const cleanObject = (value, label) => {
  if(value === undefined || value === null) return [null, {}];
  if(typeof value !== 'object' || Array.isArray(value)) return [{ code: 400, msg: `${label} must be an object` }, null];
  if(JSON.stringify(value).length > MAX_DATA_BYTES) return [{ code: 400, msg: `${label} is too large` }, null];
  return [null, value];
};

const wholeQuantity = (value, { min = 1 } = {}) => {
  const quantity = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(quantity) && quantity >= min && quantity <= MAX_QUANTITY
    ? [null, quantity]
    : [{ code: 400, msg: `Quantity must be a whole number from ${min} to ${MAX_QUANTITY}` }, null];
};

/*
  Finds the cart a visitor or customer is using, creating one when there is none.

  `token` is the visitor's cookie value, `userId` the signed-in customer. A signed-in customer who also
  arrives with a visitor token has the visitor's cart merged into their own (or adopted, when they had
  none), and `clearToken` is true so the caller drops the cookie. A newly created visitor cart returns
  its plain `token` once, for the caller to set as the cookie: only its hash is kept.
*/
export const resolveCart = async ({ token, userId, create = true } = {}) => {
  try {
    const config = await readConfig();
    const now = new Date();
    const byToken = async () => token
      ? (await db.select().from(kempoCommerceCart).where(and(eq(kempoCommerceCart.token, hashToken(token)), eq(kempoCommerceCart.status, 'open'))))[0]
      : undefined;

    if(userId){
      let mine = (await db.select().from(kempoCommerceCart).where(and(eq(kempoCommerceCart.userId, userId), eq(kempoCommerceCart.status, 'open'))).orderBy(asc(kempoCommerceCart.createdAt)))[0];
      const visitor = await byToken();
      if(visitor && visitor.id !== mine?.id){
        if(mine){
          await mergeCarts({ from: visitor.id, into: mine.id });
        } else {
          const [adopted] = await db.update(kempoCommerceCart).set({ userId, token: null })
            .where(and(eq(kempoCommerceCart.id, visitor.id), eq(kempoCommerceCart.status, 'open'))).returning();
          mine = adopted;
        }
      }
      if(!mine && create){
        [mine] = await db.insert(kempoCommerceCart).values({
          id: newId('cart'), token: null, userId, currency: await readCurrency(), status: 'open', data: {},
          createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + config.cartExpiryDays * 86400000),
        }).returning();
      }
      return [null, { cart: mine ?? null, token: null, clearToken: Boolean(token) }];
    }

    const existing = await byToken();
    if(existing) return [null, { cart: existing, token: null, clearToken: false }];
    if(!create) return [null, { cart: null, token: null, clearToken: Boolean(token) }];

    const plain = secret();
    const [cart] = await db.insert(kempoCommerceCart).values({
      id: newId('cart'), token: hashToken(plain), userId: null, currency: await readCurrency(), status: 'open', data: {},
      createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + config.cartExpiryDays * 86400000),
    }).returning();
    return [null, { cart, token: plain, clearToken: false }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to find the cart' }, null];
  }
};

/*
  The cart as a page shows it: every line looked up and priced again, the notices that come of that,
  and the totals. A correction the catalog forces (less quantity than asked for, a price that moved) is
  saved back, so the cart and what the customer sees never disagree.
*/
export const getCart = async ({ cartId } = {}) => {
  if(!cartId) return [{ code: 400, msg: 'cartId is required' }, null];

  try {
    const [cart] = await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, cartId));
    if(!cart) return [{ code: 404, msg: 'Cart not found' }, null];

    const config = await readConfig();
    const rows = await db.select().from(kempoCommerceCartLine).where(eq(kempoCommerceCartLine.cartId, cartId)).orderBy(asc(kempoCommerceCartLine.addedAt), asc(kempoCommerceCartLine.id));
    const products = await loadProducts(rows.map(row => row.productId));
    const credits = { enabled: await creditsEnabled() };
    credits.perUnit = credits.enabled ? await getCreditsPerUnit() : 0;

    const lines = [];
    const notices = [];
    for(const row of rows){
      const { line, notices: found, change } = checkLine({
        row, product: products.get(row.productId), limits: { maxQuantityPerLine: config.maxQuantityPerLine, currency: cart.currency }, credits,
      });
      lines.push(line);
      notices.push(...found);
      if(change && cart.status === 'open'){
        await db.update(kempoCommerceCartLine).set({ quantity: change.quantity, unitPrice: change.unitPrice }).where(eq(kempoCommerceCartLine.id, row.id));
      }
    }

    /* A picture for each line, from kempo-media when it is there; without it there is simply none. */
    const pictures = await resolveImages([...products.values()]).catch(() => ({}));
    for(const line of lines){
      const first = (line.images ?? [])[0];
      line.image = first && pictures?.[first] ? { path: pictures[first].path, thumbnail: pictures[first].thumbnail ?? null, alt: pictures[first].alt || line.name } : null;
      delete line.images;
    }

    const view = { id: cart.id, userId: cart.userId, currency: cart.currency, status: cart.status, data: cart.data, updatedAt: cart.updatedAt, lines, notices };

    /* Extensions may add notices of their own (a regional restriction, a mixed-cart rule), and block checkout with them. */
    const refused = await guard(EVENTS.cartValidate, { cart: view, notices });
    if(refused) notices.push({ type: 'rejected', lineId: null, productId: null, message: refused.msg, blocking: true });

    view.adjustments = await collectAdjustments({ cart: view });
    view.totals = computeTotals({ lines, adjustments: view.adjustments });
    view.blocked = notices.some(notice => notice.blocking) || !lines.length;
    view.itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
    return [null, view];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to read the cart' }, null];
  }
};

const openCart = async cartId => {
  const [cart] = await db.select().from(kempoCommerceCart).where(eq(kempoCommerceCart.id, cartId));
  if(!cart) return [{ code: 404, msg: 'Cart not found' }, null];
  if(cart.status !== 'open') return [{ code: 409, msg: 'This cart is no longer open' }, null];
  return [null, cart];
};

/*
  Adds a product, or raises the quantity of the same line (same product, same choices, same extension
  data). The quantity is held to the per-line limit and to what is in stock; a product that cannot be
  bought, or choices that do not exist, are refused with the catalog's own reason. Returns the cart.
*/
export const addToCart = async ({ cartId, productId, quantity = 1, selections, data, actor = '' } = {}) => {
  if(!productId || typeof productId !== 'string') return [{ code: 400, msg: 'productId is required' }, null];
  const [quantityError, wanted] = wholeQuantity(quantity);
  if(quantityError) return [quantityError, null];
  const [selectionsError, chosen] = cleanObject(selections, 'Options');
  if(selectionsError) return [selectionsError, null];
  const [dataError, extra] = cleanObject(data, 'Line data');
  if(dataError) return [dataError, null];

  try {
    const [cartError, cart] = await openCart(cartId);
    if(cartError) return [cartError, null];
    const config = await readConfig();

    const draft = { productId, quantity: wanted, selections: { ...chosen }, data: { ...extra } };
    const refused = await guard(EVENTS.cartBeforeAdd, { cart, draft, userId: cart.userId, actor });
    if(refused) return [refused, null];
    const [draftQuantityError, finalQuantity] = wholeQuantity(draft.quantity);
    if(draftQuantityError) return [draftQuantityError, null];

    const products = await loadProducts([draft.productId]);
    const product = products.get(draft.productId);
    if(!product) return [{ code: 404, msg: 'That product does not exist' }, null];
    const reason = unavailableReason(product);
    if(reason) return [{ code: 409, msg: `${product.name}: ${reason.toLowerCase()}` }, null];
    const [priceError, priced] = computePrice(product, product.options, draft.selections);
    if(priceError) return [{ ...priceError, msg: `${product.name}: ${priceError.msg}` }, null];

    const key = lineKey({ productId: product.id, selections: priced.selections, data: draft.data });
    const [existing] = await db.select().from(kempoCommerceCartLine).where(and(eq(kempoCommerceCartLine.cartId, cartId), eq(kempoCommerceCartLine.lineKey, key)));

    if(!existing){
      const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(kempoCommerceCartLine).where(eq(kempoCommerceCartLine.cartId, cartId));
      if(count >= config.maxLinesPerCart) return [{ code: 409, msg: `A cart can have at most ${config.maxLinesPerCart} different products` }, null];
    }

    const ceiling = Math.min(config.maxQuantityPerLine, product.quantity === UNLIMITED ? Infinity : product.quantity);
    const target = Math.min((existing?.quantity ?? 0) + finalQuantity, ceiling);
    if(target <= (existing?.quantity ?? 0)){
      return [{ code: 409, msg: product.quantity !== UNLIMITED && target >= product.quantity ? `Only ${product.quantity} of ${product.name} available` : `You can buy at most ${config.maxQuantityPerLine} of one product at a time` }, null];
    }

    const now = new Date();
    const [line] = await db.insert(kempoCommerceCartLine).values({
      id: newId('cl'), cartId, productId: product.id, quantity: target, selections: priced.selections, data: draft.data,
      lineKey: key, unitPrice: priced.unit, addedAt: now,
    }).onConflictDoUpdate({
      target: [kempoCommerceCartLine.cartId, kempoCommerceCartLine.lineKey],
      set: { quantity: sql`least(${kempoCommerceCartLine.quantity} + ${finalQuantity}, ${ceiling === Infinity ? MAX_QUANTITY : ceiling})`, unitPrice: priced.unit },
    }).returning();
    await touch(cartId, config);

    const [readError, view] = await getCart({ cartId });
    if(readError) return [readError, null];
    await notify(EVENTS.cartItemAdded, { cart: view, line, actor });
    return [null, { cart: view, line }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to add to the cart' }, null];
  }
};

/* Sets a line's quantity; 0 removes it. A quantity beyond what is in stock is held to what is. */
export const updateCartLine = async ({ cartId, lineId, quantity, actor = '' } = {}) => {
  if(!lineId) return [{ code: 400, msg: 'lineId is required' }, null];
  const [quantityError, wanted] = wholeQuantity(quantity, { min: 0 });
  if(quantityError) return [quantityError, null];

  try {
    const [cartError, cart] = await openCart(cartId);
    if(cartError) return [cartError, null];
    const [line] = await db.select().from(kempoCommerceCartLine).where(and(eq(kempoCommerceCartLine.id, lineId), eq(kempoCommerceCartLine.cartId, cartId)));
    if(!line) return [{ code: 404, msg: 'That line is not in the cart' }, null];
    if(wanted === 0) return removeCartLine({ cartId, lineId, actor });

    const changes = { quantity: wanted };
    const refused = await guard(EVENTS.cartBeforeUpdate, { cart, line, changes, actor });
    if(refused) return [refused, null];
    const [finalError, finalQuantity] = wholeQuantity(changes.quantity);
    if(finalError) return [finalError, null];

    const config = await readConfig();
    const products = await loadProducts([line.productId]);
    const product = products.get(line.productId);
    const ceiling = Math.min(config.maxQuantityPerLine, product && product.quantity !== UNLIMITED ? product.quantity : Infinity);
    const target = Math.min(finalQuantity, ceiling);
    if(target < 1) return [{ code: 409, msg: product ? `${product.name} is out of stock` : 'This product is no longer available' }, null];

    await db.update(kempoCommerceCartLine).set({ quantity: target }).where(eq(kempoCommerceCartLine.id, lineId));
    await touch(cartId, config);

    const [readError, view] = await getCart({ cartId });
    if(readError) return [readError, null];
    await notify(EVENTS.cartItemUpdated, { cart: view, line: { ...line, quantity: target }, previous: line, actor });
    return [null, { cart: view }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to update the cart' }, null];
  }
};

export const removeCartLine = async ({ cartId, lineId, actor = '' } = {}) => {
  if(!lineId) return [{ code: 400, msg: 'lineId is required' }, null];

  try {
    const [cartError] = await openCart(cartId);
    if(cartError) return [cartError, null];
    const [line] = await db.delete(kempoCommerceCartLine).where(and(eq(kempoCommerceCartLine.id, lineId), eq(kempoCommerceCartLine.cartId, cartId))).returning();
    if(!line) return [{ code: 404, msg: 'That line is not in the cart' }, null];
    await touch(cartId, await readConfig());

    const [readError, view] = await getCart({ cartId });
    if(readError) return [readError, null];
    await notify(EVENTS.cartItemRemoved, { cart: view, line, actor });
    return [null, { cart: view }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to remove from the cart' }, null];
  }
};

export const clearCart = async ({ cartId, actor = '' } = {}) => {
  try {
    const [cartError] = await openCart(cartId);
    if(cartError) return [cartError, null];
    await db.delete(kempoCommerceCartLine).where(eq(kempoCommerceCartLine.cartId, cartId));
    await touch(cartId, await readConfig());

    const [readError, view] = await getCart({ cartId });
    if(readError) return [readError, null];
    await notify(EVENTS.cartCleared, { cart: view, actor });
    return [null, { cart: view }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to clear the cart' }, null];
  }
};

/*
  What signing in does: the visitor's lines are added to the customer's cart (the same line adds the
  quantities, held to the per-line limit), and the visitor's cart is marked merged. Idempotent: a cart
  that is no longer open merges nothing.
*/
export const mergeCarts = async ({ from, into } = {}) => {
  if(!from || !into || from === into) return [{ code: 400, msg: 'from and into must be two different carts' }, null];

  try {
    const config = await readConfig();
    const merged = await db.transaction(async tx => {
      const [claimed] = await tx.update(kempoCommerceCart).set({ status: 'merged', updatedAt: new Date() })
        .where(and(eq(kempoCommerceCart.id, from), eq(kempoCommerceCart.status, 'open'))).returning();
      if(!claimed) return null;
      const [target] = await tx.select().from(kempoCommerceCart).where(and(eq(kempoCommerceCart.id, into), eq(kempoCommerceCart.status, 'open')));
      if(!target) throw new Error('target');

      const lines = await tx.select().from(kempoCommerceCartLine).where(eq(kempoCommerceCartLine.cartId, from));
      for(const line of lines){
        await tx.insert(kempoCommerceCartLine).values({
          id: newId('cl'), cartId: into, productId: line.productId, quantity: Math.min(line.quantity, config.maxQuantityPerLine),
          selections: line.selections, data: line.data, lineKey: line.lineKey, unitPrice: line.unitPrice, addedAt: line.addedAt,
        }).onConflictDoUpdate({
          target: [kempoCommerceCartLine.cartId, kempoCommerceCartLine.lineKey],
          set: { quantity: sql`least(${kempoCommerceCartLine.quantity} + ${line.quantity}, ${config.maxQuantityPerLine})` },
        });
      }
      await tx.update(kempoCommerceCart).set({ data: { ...claimed.data, ...target.data }, updatedAt: new Date() }).where(eq(kempoCommerceCart.id, into));
      return { lines: lines.length, claimed };
    });

    if(!merged) return [null, { merged: 0 }];
    await notify(EVENTS.cartMerged, { from: merged.claimed, into, userId: merged.claimed.userId });
    return [null, { merged: merged.lines }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to merge the carts' }, null];
  }
};

/* Extension data on a cart, merged in. */
export const setCartData = async (cartId, patch) => {
  const [dataError, clean] = cleanObject(patch, 'Cart data');
  if(dataError) return [dataError, null];

  try {
    const [cartError, cart] = await openCart(cartId);
    if(cartError) return [cartError, null];
    const data = { ...cart.data, ...clean };
    if(JSON.stringify(data).length > MAX_DATA_BYTES * 4) return [{ code: 400, msg: 'Cart data is too large' }, null];
    await db.update(kempoCommerceCart).set({ data, updatedAt: new Date() }).where(eq(kempoCommerceCart.id, cartId));
    return [null, { data }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to save the cart data' }, null];
  }
};

/* Every open cart for the admin's read-only list, newest touched first. */
export const listCarts = async ({ status = 'open', limit = 50, offset = 0 } = {}) => {
  try {
    const where = status ? eq(kempoCommerceCart.status, status) : undefined;
    const carts = await db.select().from(kempoCommerceCart).where(where).orderBy(sql`${kempoCommerceCart.updatedAt} desc`).limit(limit).offset(offset);
    const ids = carts.map(cart => cart.id);
    const lines = ids.length ? await db.select().from(kempoCommerceCartLine).where(inArray(kempoCommerceCartLine.cartId, ids)) : [];
    const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCommerceCart).where(where);
    return [null, { items: carts.map(cart => ({ ...cart, token: undefined, lines: lines.filter(line => line.cartId === cart.id) })), total }];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to list the carts' }, null];
  }
};
