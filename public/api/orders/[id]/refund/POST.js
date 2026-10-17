import { refundOrder } from '../../../../../server/utils/refunds/issue.js';
import { getOrder } from '../../../../../server/utils/orders/read.js';
import { body, gate, refuse } from '../../../../../server/http/gate.js';
import { currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  Issues a refund. Returning card money also needs kempo-payments' own `payments:refund`, so the
  shop's permission alone cannot reach the processor.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:refunds:issue');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);

  if(order.tenders.some(tender => tender.kind === 'card' && tender.status === 'applied')){
    const [permissionError, allowed] = await currentUserHasPermission(session.token, 'payments:refund');
    if(permissionError || !allowed) return refuse(response, { code: 403, msg: 'Refunding card money also needs the payments:refund permission' });
  }

  const { lines, amount, includeFees, destination, restock, credits, reason } = body(request);
  const [error, result] = await refundOrder(order.id, { lines, amount, includeFees: includeFees === true, destination, restock, credits, reason, actor: session.user.id });
  if(error) return refuse(response, error);
  response.status(201).json(result);
};
