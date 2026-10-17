import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';
import { resolveCart } from '../utils/carts/cart.js';
import { readConfig } from '../utils/config/settings.js';
import { getOrder } from '../utils/orders/read.js';
import { sameSecret } from '../utils/ids.js';

/*
  The HTTP layer's own helpers — who is asking, and are they allowed. They live here rather than in
  server/utils because they read requests, and nothing under server/utils does.

  Routes come in four kinds, and each says which it is by what it calls:

  - **Anyone.** The cart, the checkout and a guest's own order. A visitor is a cookie holding a random
    token for their cart; a guest's order is reached with the key from their link.
  - **Your own.** Everything under /commerce/api/my/ is about the signed-in user and nobody else, so it
    needs a session and no permission — the user id comes from the session, never the request.
  - **Administrative.** Every other route that reads or changes an order needs its own `commerce:*`
    permission.
  - **Public.** The settings a page needs to render.
*/

export const CART_COOKIE = 'kempo_cart';
const CART_COOKIE_AGE = 60 * 24 * 3600 * 1000;

/* The signed-in user, or null for a visitor. */
export const optionalSession = async request => {
  const token = request.cookies?.session_token;
  if(!token) return null;
  const [error, session] = await getSession({ token });
  return error || !session?.user ? null : { token, user: session.user };
};

export const requireSession = async request => {
  const session = await optionalSession(request);
  return session ? [null, session] : [{ code: 401, msg: 'Sign in first' }, null];
};

export const gate = async (request, permission) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return [sessionError, null];

  const [error, allowed] = await currentUserHasPermission(session.token, permission);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'You do not have permission to do that' }, null];

  return [null, session];
};

/*
  Sends an error tuple's error. The extra fields a refusal carries — the notices that block a cart,
  the real total when it changed, what an account must do, how long to wait — go to the caller too,
  since they are what a page needs to say something useful.
*/
export const refuse = (response, { code, msg, ...details }) => {
  if(details.retryAfter) response.set('Retry-After', String(details.retryAfter));
  return response.status(code || 500).json({ error: msg, ...details });
};

/*
  The visitor's address, for the checkout limits. Behind a proxy every visitor shares the proxy's
  address, so `trust_proxy` takes it from X-Forwarded-For instead — and only then: with no proxy that
  header is whatever the visitor sent.
*/
export const clientIp = async request => {
  const config = await readConfig();
  if(config.trustProxy){
    const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if(forwarded) return forwarded;
  }
  return request._originalRequest?.socket?.remoteAddress || request.socket?.remoteAddress || null;
};

/*
  The cart this request is using, found from the session and the cart cookie, created when `create` is
  set. A newly issued token is set as the cookie; a visitor who has just signed in has their cookie
  dropped, because their cart was merged into the customer's.
*/
export const cartFor = async (request, response, { create = true } = {}) => {
  const session = await optionalSession(request);
  const [error, found] = await resolveCart({ token: request.cookies?.[CART_COOKIE], userId: session?.user.id ?? null, create });
  if(error) return [error, null];

  if(found.token){
    response.cookie(CART_COOKIE, found.token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: CART_COOKIE_AGE,
    });
  } else if(found.clearToken){
    response.cookie(CART_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  }
  return [null, { cart: found.cart, session }];
};

/*
  An order the caller may see as its customer: the signed-in user it belongs to, or a guest holding its
  key. A wrong key and a wrong user are the same 404 as no order, so ids cannot be probed.
*/
export const customerOrder = async (request, id, key) => {
  const [error, order] = await getOrder(id, { notes: true });
  if(error) return [{ code: 404, msg: 'Order not found' }, null];

  const session = await optionalSession(request);
  if(session && order.userId === session.user.id) return [null, { order, session, asOwner: true }];
  if(key && sameSecret(order.orderKey, key)) return [null, { order, session, asOwner: false }];
  return [{ code: 404, msg: 'Order not found' }, null];
};

/* A whole number from a JSON body or a query string, or undefined when there is none. */
export const wholeNumber = value => {
  if(value === undefined || value === null || value === '') return undefined;
  if(typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
};

/* The same text for a page to show whatever the failure. */
export const body = request => (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {});
