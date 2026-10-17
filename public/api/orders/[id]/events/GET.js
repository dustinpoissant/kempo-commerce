import { getOrderEvents } from '../../../../../server/utils/orders/events.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error, events] = await getOrderEvents(order.id);
  if(error) return refuse(response, error);
  response.json({ events });
};
