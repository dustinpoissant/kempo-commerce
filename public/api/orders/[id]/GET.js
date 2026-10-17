import { getOrder } from '../../../../server/utils/orders/read.js';
import { getOrderEvents } from '../../../../server/utils/orders/events.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* Everything on an order, with its whole history. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const [error, order] = await getOrder(request.params.id, { notes: true });
  if(error) return refuse(response, error);
  const [, events] = await getOrderEvents(order.id);
  response.json({ order, events: events ?? [] });
};
