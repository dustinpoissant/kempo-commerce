import { setOrderStatus } from '../../../../../server/utils/orders/status.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';

/* Pauses, resumes, or marks a paid order processing or completed. Cancelling and refunding have their own routes. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const { status, note } = body(request);
  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error, updated] = await setOrderStatus(order.id, status, { actor: session.user.id, note });
  if(error) return refuse(response, error);
  response.json({ order: updated });
};
