import { removeCartLine } from '../../../../../server/utils/carts/cart.js';
import { cartFor, refuse } from '../../../../../server/http/gate.js';

export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return refuse(response, { code: 404, msg: 'That line is not in the cart' });

  const [removeError, result] = await removeCartLine({ cartId: found.cart.id, lineId: request.params.id });
  if(removeError) return refuse(response, removeError);
  response.json(result);
};
