import { markPaid } from '../../../../../server/utils/checkout/complete.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';

/* Records money taken some other way (cash, a transfer) and completes the order as if it had been paid. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error] = await markPaid(order.id, { actor: session.user.id, note: String(body(request).note ?? '').slice(0, 500) });
  if(error) return refuse(response, error);
  const [, fresh] = await getOrder(order.id, { notes: true });
  response.json({ order: fresh });
};
