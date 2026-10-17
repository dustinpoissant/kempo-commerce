import { updateCartLine } from '../../../../../server/utils/carts/cart.js';
import { body, cartFor, refuse, wholeNumber } from '../../../../../server/http/gate.js';

export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return refuse(response, { code: 404, msg: 'That line is not in the cart' });

  const [updateError, result] = await updateCartLine({ cartId: found.cart.id, lineId: request.params.id, quantity: wholeNumber(body(request).quantity) });
  if(updateError) return refuse(response, updateError);
  response.json(result);
};
