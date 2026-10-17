import { listOrders } from '../../../server/utils/orders/read.js';
import { gate, refuse, wholeNumber } from '../../../server/http/gate.js';

/* The orders list: search by number, name or email; filter by status and date. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const { status, search, from, to } = request.query;
  const [error, result] = await listOrders({
    status: status ? String(status).split(',') : undefined, search, from, to,
    limit: wholeNumber(request.query.limit) ?? 25, offset: wholeNumber(request.query.offset) ?? 0,
  });
  if(error) return refuse(response, error);
  response.json(result);
};
