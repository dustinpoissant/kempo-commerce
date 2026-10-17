import { previewRefund } from '../../../../server/utils/refunds/preview.js';
import { body, gate, refuse } from '../../../../server/http/gate.js';

/* What a refund would do, including the credits warning, without doing it. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:refunds:issue');
  if(gateError) return refuse(response, gateError);

  const { orderId, lines, amount, includeFees, destination, restock } = body(request);
  const [error, preview] = await previewRefund({ orderId, lines, amount, includeFees: includeFees === true, destination, restock, actor: session.user.id });
  if(error) return refuse(response, error);
  response.json({ preview });
};
