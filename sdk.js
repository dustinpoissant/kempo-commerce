/*
  Server-side entry point — what shipping, coupons, digital delivery and every other extension that
  builds on a store imports.

  ```js
  import { getCart, addToCart, placeOrder, getOrder, setLineFulfillment, registerTender } from 'kempo-commerce/sdk';

  // Something was shipped: mark the line, and the order completes when no line is waiting.
  await setLineFulfillment(order.id, line.id, 'done', { actor: 'kempo-shipping', data: { shipmentId } });
  ```

  Every function returns `[error, data]` with `error = { code, msg }`, and none throws. These are data
  operations with **no permission checks of their own**: the routes under public/api decide who may
  do what, and anything calling in here is server-side code that has already decided it is allowed.
  Everything that changes an order takes an optional `{ actor }` (your extension's name), which is
  written to the order's history.

  Extending checkout is done with hooks (see README.md for every one): `cart:before_add` to refuse or
  change an add, `totals:fees` to add shipping, `checkout:fields` and `checkout:validate` to collect
  and check a delivery address, `checkout:tenders` to offer a way to pay, `order:paid` to do the work
  once money has arrived, `order:line_fulfillment` to say which lines need sending, `refund:issued` to
  put things back.

  The model is WooCommerce's: carts for visitors and customers, an order with a status and a history,
  guest checkout, and refunds issued by an administrator. Discounts, coupons, shipping, categories and
  the catalog itself are other extensions' business.
*/

export {
  resolveCart,
  getCart,
  addToCart,
  updateCartLine,
  removeCartLine,
  clearCart,
  mergeCarts,
  setCartData,
  listCarts,
} from './server/utils/carts/cart.js';

export { computeTotals, collectAdjustments } from './server/utils/totals.js';

export { startCheckout, accountRules } from './server/utils/checkout/quote.js';
export { placeOrder } from './server/utils/checkout/place.js';
export { completeOrder, markPaid } from './server/utils/checkout/complete.js';
export { failOrder, cancelUnpaidOrder } from './server/utils/checkout/unwind.js';
export { registerTender, unregisterTender, listTenders, getTender } from './server/utils/checkout/tenders.js';

export { getOrder, getOrderByKey, listOrders, forCustomer, STATUSES as orderStatuses } from './server/utils/orders/read.js';
export { setOrderStatus } from './server/utils/orders/status.js';
export { setLineFulfillment } from './server/utils/orders/fulfillment.js';
export { addOrderNote } from './server/utils/orders/notes.js';
export { getOrderEvents } from './server/utils/orders/events.js';
export { linkGuestOrders } from './server/utils/orders/link.js';
export { formatOrderNumber } from './server/utils/orders/number.js';
export { sendOrderEmail } from './server/utils/orders/emails.js';

export { readConfig, publicConfig, OWNER } from './server/utils/config/settings.js';
export { EVENTS } from './server/utils/events.js';
export { runSweep } from './server/utils/sweeps.js';

export { previewRefund } from './server/utils/refunds/preview.js';
export { refundOrder, finishRefund, getRefund } from './server/utils/refunds/issue.js';
