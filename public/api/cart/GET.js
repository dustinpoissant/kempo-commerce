import { getCart } from '../../../server/utils/carts/cart.js';
import { cartFor, refuse } from '../../../server/http/gate.js';

/*
  The visitor's or customer's cart, priced again from the catalog with the notices that come of it.
  Reading it never makes one: a visitor with no cart gets an empty one, so a crawler does not fill the
  table.
*/
export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);

  if(!found.cart){
    return response.json({ cart: { id: null, lines: [], notices: [], adjustments: [], blocked: true, itemCount: 0, totals: { subtotal: 0, discountTotal: 0, feeTotal: 0, taxTotal: null, taxComputed: false, total: 0 } } });
  }

  const [cartError, cart] = await getCart({ cartId: found.cart.id });
  if(cartError) return refuse(response, cartError);
  response.json({ cart });
};
