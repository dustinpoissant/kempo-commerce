import { contactCustomer } from '../../../../../server/utils/orders/contact.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';

/* An email from the shop to the order's customer, from the admin order page. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:orders:manage');
  if(gateError) return refuse(response, gateError);

  const { subject, body: text } = body(request);
  const [error, result] = await contactCustomer(request.params.id, { subject, body: text, authorId: session.user.id });
  if(error) return refuse(response, error);
  response.json(result);
};
