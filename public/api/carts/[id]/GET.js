import { readCart } from '../../../../server/utils/carts/cart.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* One cart as stored, for the admin's cart page. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await readCart({ cartId: request.params.id });
  if(error) return refuse(response, error);
  response.json(result);
};
