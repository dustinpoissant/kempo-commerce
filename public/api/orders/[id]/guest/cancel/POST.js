import { cancelUnpaidOrder } from '../../../../../../server/utils/checkout/unwind.js';
import { forCustomer, getOrder } from '../../../../../../server/utils/orders/read.js';
import withProductLinks from '../../../../../../server/utils/orders/links.js';
import { body, customerOrder, refuse } from '../../../../../../server/http/gate.js';

/* A guest cancels their unpaid order with the key from their link. */
export default async (request, response) => {
  const [accessError, access] = await customerOrder(request, request.params.id, body(request).key ?? request.query.key);
  if(accessError) return refuse(response, accessError);

  const [error] = await cancelUnpaidOrder(access.order.id, { actor: 'customer', reason: 'Cancelled by the customer' });
  if(error) return refuse(response, error);

  const [, order] = await getOrder(access.order.id, { notes: true });
  response.json({ order: await withProductLinks(forCustomer(order)) });
};
