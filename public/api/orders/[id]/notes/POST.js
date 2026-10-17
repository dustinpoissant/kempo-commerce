import { addOrderNote } from '../../../../../server/utils/orders/notes.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';

/* A note on the order, private or visible to the customer (who is emailed it). */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const { body: text, visibleToCustomer } = body(request);
  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error, note] = await addOrderNote(order.id, { body: text, visibleToCustomer: visibleToCustomer === true, authorId: session.user.id });
  if(error) return refuse(response, error);
  response.status(201).json({ note });
};
