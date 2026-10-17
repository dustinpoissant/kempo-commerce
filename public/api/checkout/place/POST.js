import { placeOrder } from '../../../../server/utils/checkout/place.js';
import { body, cartFor, clientIp, gate, refuse } from '../../../../server/http/gate.js';
import { forCustomer } from '../../../../server/utils/orders/read.js';

/*
  Places the order. Idempotent on `checkoutKey`, which the page makes once per checkout. A signed-in
  customer needs `commerce:checkout`; a guest needs nothing but the site allowing guests, and the cart
  allowing it (credits for sale always need an account).
*/
export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return refuse(response, { code: 409, msg: 'Your cart is empty' });

  if(found.session){
    const [permissionError] = await gate(request, 'commerce:checkout');
    if(permissionError) return refuse(response, permissionError);
  }

  const { checkoutKey, billing, data, tenders, account, expectedTotal } = body(request);
  const [placeError, result] = await placeOrder({
    cartId: found.cart.id, userId: found.session?.user.id ?? null, checkoutKey, billing, data, tenders, account, expectedTotal, ip: await clientIp(request),
  });
  if(placeError) return refuse(response, placeError);

  const order = forCustomer(result.order);
  response.status(result.duplicate ? 200 : 201).json({
    order,
    payment: result.payment,
    duplicate: Boolean(result.duplicate),
    receivedUrl: `/commerce/order/${encodeURIComponent(order.id)}/received/${order.userId ? '' : `?key=${encodeURIComponent(order.orderKey)}`}`,
  });
};
