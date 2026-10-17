import { getOrderEvents } from '../../../../../server/utils/orders/events.js';
import { forCustomer } from '../../../../../server/utils/orders/read.js';
import { customerOrder, refuse, requireSession } from '../../../../../server/http/gate.js';

/* One of the signed-in customer's orders, with the history they are meant to see. */
export default async (request, response) => {
  const [sessionError] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  const [error, access] = await customerOrder(request, request.params.id, null);
  if(error) return refuse(response, error);

  const [, events] = await getOrderEvents(access.order.id, { customerVisibleOnly: true });
  response.json({ order: forCustomer(access.order), events: events ?? [] });
};
