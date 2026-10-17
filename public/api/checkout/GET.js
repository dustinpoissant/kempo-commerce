import { startCheckout } from '../../../server/utils/checkout/quote.js';
import prefillFor from '../../../server/utils/checkout/prefill.js';
import { cartFor, refuse } from '../../../server/http/gate.js';

/*
  The quote when checkout opens: the cart priced, what the customer could use to pay, the extra fields
  extensions want, and what an account must do. No address yet, so no tax. A signed-in customer also gets
  `prefill`: what the shop already knows, to start the form with.
*/
export default async (request, response) => {
  const [error, found] = await cartFor(request, response, { create: false });
  if(error) return refuse(response, error);
  if(!found.cart) return refuse(response, { code: 409, msg: 'Your cart is empty' });

  const userId = found.session?.user.id ?? null;
  const [quoteError, quote] = await startCheckout({ cartId: found.cart.id, userId });
  if(quoteError) return refuse(response, quoteError);
  const [, prefill] = await prefillFor({ userId });
  response.json({ quote, prefill });
};
