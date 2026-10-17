import { finishRefund } from '../../../../../server/utils/refunds/issue.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/* Carries on a refund that was left partly issued, from the step that failed. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'commerce:refunds:issue');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await finishRefund(request.params.id, { actor: session.user.id });
  if(error) return refuse(response, error);
  response.json(result);
};
