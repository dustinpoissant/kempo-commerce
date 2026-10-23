import { getOrderEvents } from '../../../../../server/utils/orders/events.js';
import { forCustomer } from '../../../../../server/utils/orders/read.js';
import withProductLinks from '../../../../../server/utils/orders/links.js';
import { customerOrder, refuse } from '../../../../../server/http/gate.js';

/* A guest's order, reached with the key in their link. A wrong key is the same 404 as no order. */
export default async (request, response) => {
  const [error, access] = await customerOrder(request, request.params.id, request.query.key);
  if(error) return refuse(response, error);

  const [, events] = await getOrderEvents(access.order.id, { customerVisibleOnly: true });
  response.json({ order: await withProductLinks(forCustomer(access.order)), events: events ?? [] });
};
