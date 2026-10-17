import { cancelUnpaidOrder } from '../../../../../server/utils/checkout/unwind.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';

/* Cancels an unpaid order, giving back whatever it took. A paid order is refunded instead. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error] = await cancelUnpaidOrder(order.id, { actor: session.user.id, reason: String(body(request).reason ?? '').slice(0, 500) });
  if(error) return refuse(response, error);
  const [, fresh] = await getOrder(order.id, { notes: true });
  response.json({ order: fresh });
};
