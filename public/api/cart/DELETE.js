import { clearCart } from '../../../server/utils/carts/cart.js';
import { cartFor, refuse } from '../../../server/http/gate.js';

export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return response.json({ cart: null });

  const [clearError, result] = await clearCart({ cartId: found.cart.id });
  if(clearError) return refuse(response, clearError);
  response.json(result);
};
