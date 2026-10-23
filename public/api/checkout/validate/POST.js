import { startCheckout } from '../../../../server/utils/checkout/quote.js';
import { body, cartFor, refuse } from '../../../../server/http/gate.js';

/*
  The same quote with the details filled in so far: the address brings tax, and the tenders chosen show
  how the total would be split. Changes nothing.
*/
export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return refuse(response, { code: 409, msg: 'Your cart is empty' });

  const { billing = null, data = {}, tenders = {} } = body(request);
  const [quoteError, quote] = await startCheckout({ cartId: found.cart.id, userId: found.session?.user.id ?? null, billing, data, tenders });
  if(quoteError) return refuse(response, quoteError);
  response.json({ quote });
};
