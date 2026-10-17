import { setLineFulfillment } from '../../../../../../server/utils/orders/fulfillment.js';
import { getOrder } from '../../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../../server/http/gate.js';

/* Marks one line fulfilled, or puts it back to waiting. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error, updated] = await setLineFulfillment(order.id, request.params.lineId, body(request).fulfillment, { actor: session.user.id });
  if(error) return refuse(response, error);
  response.json({ order: updated });
};
