import { listOrders, forCustomer } from '../../../../server/utils/orders/read.js';
import { linkGuestOrders } from '../../../../server/utils/orders/link.js';
import { refuse, requireSession, wholeNumber } from '../../../../server/http/gate.js';

/*
  The signed-in customer's own orders. Guest orders placed with this account's email are attached
  first, but only when the email is verified: anyone can type anyone's address at a checkout.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return refuse(response, sessionError);

  await linkGuestOrders({ userId: session.user.id });
  const [error, result] = await listOrders({
    userId: session.user.id, limit: wholeNumber(request.query.limit) ?? 20, offset: wholeNumber(request.query.offset) ?? 0,
  });
  if(error) return refuse(response, error);
  response.json({ ...result, items: result.items.map(order => forCustomer(order)) });
};
