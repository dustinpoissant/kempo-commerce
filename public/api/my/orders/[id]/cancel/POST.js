import { cancelUnpaidOrder } from '../../../../../../server/utils/checkout/unwind.js';
import { forCustomer, getOrder } from '../../../../../../server/utils/orders/read.js';
import { customerOrder, refuse, requireSession } from '../../../../../../server/http/gate.js';

/*
  Cancels an order that has not been paid, as WooCommerce lets a customer do: immediately, with no
  approval, because nothing was paid. A paid order is refunded by the shop, not cancelled by the customer.
*/
export default async (request, response) => {
  const [sessionError] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [accessError, access] = await customerOrder(request, request.params.id, null);
  if(accessError) return refuse(response, accessError);

  const [error] = await cancelUnpaidOrder(access.order.id, { actor: 'customer', reason: 'Cancelled by the customer' });
  if(error) return refuse(response, error);

  const [, order] = await getOrder(access.order.id, { notes: true });
  response.json({ order: forCustomer(order) });
};
