import { addToCart } from '../../../../server/utils/carts/cart.js';
import { body, cartFor, refuse } from '../../../../server/http/gate.js';

/*
  Adds a product. The browser names a product, a quantity and the choices made — never a price. Every
  price comes from the catalog.
*/
export default async (request, response) => {
  const [error, found] = await cartFor(request, response);
  if(error) return refuse(response, error);

  const { productId, quantity, selections, data } = body(request);
  const [addError, result] = await addToCart({ cartId: found.cart.id, productId, quantity, selections, data });
  if(addError) return refuse(response, addError);
  response.status(201).json(result);
};
