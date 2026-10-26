/*
  Browser client, served at /commerce/sdk.js.

  Every call returns an `[error, data]` tuple like the rest of kempo. An error carries the extra fields
  a route sent with it — the `notices` that block a cart, the real `totals` when the total changed,
  `account` rules, `retryAfter` — so a page can say something more useful than "no".

  The browser names a product and a quantity, never a price: every amount comes from the server.

  When anything changes the cart, call `announceCartChanged(source, cart)`. It fires a bubbling,
  composed `cart-changed` event from `source` (the mini-cart, the cart button and the cart page all
  listen) and tells the other tabs through a BroadcastChannel, so a cart open in two tabs never shows
  two different things. Methods cause actions; events only say that something happened.
*/

const BASE = '/commerce/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if(!response.ok){
      const { error, ...details } = data;
      return [{ code: response.status, msg: error || response.statusText, ...details }, null];
    }
    return [null, data];
  } catch(error) {
    return [{ code: 0, msg: error.message }, null];
  }
};

const send = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const query = params => {
  const search = new URLSearchParams();
  for(const [name, value] of Object.entries(params || {})){
    if(value !== undefined && value !== null && value !== '') search.set(name, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

/*
  An id for one checkout, sent as its idempotency key so a double click, a reload or a second tab
  places the order once. A page keeps it for as long as the same checkout is going on.
*/
export const newKey = () => crypto.randomUUID();

/*
  Cart
*/

export const getConfig = () => request('/config');
export const getRegions = () => request('/regions');
export const getCart = () => request('/cart');
export const addToCart = ({ productId, quantity = 1, selections = {}, data = {} }) => request('/cart/lines', send('POST', { productId, quantity, selections, data }));
export const updateLine = (lineId, quantity) => request(`/cart/lines/${encodeURIComponent(lineId)}`, send('PATCH', { quantity }));
export const removeLine = lineId => request(`/cart/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' });
export const clearCart = () => request('/cart', { method: 'DELETE' });

/*
  Checkout
*/

export const startCheckout = () => request('/checkout');
export const validateCheckout = ({ billing, data, tenders }) => request('/checkout/validate', send('POST', { billing, data, tenders }));
export const placeOrder = ({ checkoutKey, billing, data, tenders, account, expectedTotal }) => request('/checkout/place', send('POST', { checkoutKey, billing, data, tenders, account, expectedTotal }));

/* Asks the server to check with the processor: the browser's word that a payment worked is never believed. */
export const confirmPayment = (orderId, key) => request(`/checkout/orders/${encodeURIComponent(orderId)}/confirm`, send('POST', { key }));

/*
  Orders
*/

export const getMyOrders = (params = {}) => request(`/my/orders${query(params)}`);
export const getMyOrder = id => request(`/my/orders/${encodeURIComponent(id)}`);
export const cancelOrder = id => request(`/my/orders/${encodeURIComponent(id)}/cancel`, send('POST'));

/* A guest's order, reached with the key in their link. */
export const getOrderByKey = (id, key) => request(`/orders/${encodeURIComponent(id)}/guest${query({ key })}`);
export const cancelOrderByKey = (id, key) => request(`/orders/${encodeURIComponent(id)}/guest/cancel`, send('POST', { key }));

/*
  The shop's side (each needs its own permission)
*/

export const listOrders = (params = {}) => request(`/orders${query(params)}`);
export const getOrder = id => request(`/orders/${encodeURIComponent(id)}`);
export const setOrderStatus = (id, status, note) => request(`/orders/${encodeURIComponent(id)}/status`, send('PATCH', { status, note }));
export const addNote = (id, body, visibleToCustomer) => request(`/orders/${encodeURIComponent(id)}/notes`, send('POST', { body, visibleToCustomer }));
export const contactCustomer = (id, subject, body) => request(`/orders/${encodeURIComponent(id)}/contact`, send('POST', { subject, body }));
export const setFulfillment = (id, lineId, fulfillment) => request(`/orders/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}`, send('PATCH', { fulfillment }));
export const cancelUnpaid = (id, reason) => request(`/orders/${encodeURIComponent(id)}/cancel`, send('POST', { reason }));
export const markPaid = (id, note) => request(`/orders/${encodeURIComponent(id)}/mark-paid`, send('POST', { note }));
export const previewRefund = options => request('/refunds/preview', send('POST', options));
export const refundOrder = (id, options) => request(`/orders/${encodeURIComponent(id)}/refund`, send('POST', options));
export const finishRefund = refundId => request(`/refunds/${encodeURIComponent(refundId)}/finish`, send('POST'));
export const listCarts = (params = {}) => request(`/carts${query(params)}`);
export const getAdminCart = id => request(`/carts/${encodeURIComponent(id)}`);
export const getSummary = () => request('/summary');
export const getSettings = () => request('/settings');
export const saveSettings = values => request('/settings', send('PUT', values));

/*
  Telling everyone the cart changed
*/

const CHANNEL = 'kempo-commerce-cart';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

export const announceCartChanged = (source, cart) => {
  (source || window).dispatchEvent(new CustomEvent('cart-changed', { detail: { cart }, bubbles: true, composed: true }));
  channel?.postMessage({ type: 'cart-changed' });
};

/* Runs `callback` when the cart changed in this tab (any component) or another. Returns a function that stops listening. */
export const onCartChanged = callback => {
  const here = event => callback(event.detail?.cart ?? null);
  const elsewhere = () => callback(null);
  window.addEventListener('cart-changed', here);
  channel?.addEventListener('message', elsewhere);
  return () => {
    window.removeEventListener('cart-changed', here);
    channel?.removeEventListener('message', elsewhere);
  };
};
