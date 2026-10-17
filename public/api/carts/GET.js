import { listCarts } from '../../../server/utils/carts/cart.js';
import { gate, refuse, wholeNumber } from '../../../server/http/gate.js';

/* Open or abandoned carts, read-only. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const status = ['open', 'abandoned', 'converted'].includes(request.query.status) ? request.query.status : 'open';
  const [error, result] = await listCarts({ status, limit: wholeNumber(request.query.limit) ?? 25, offset: wholeNumber(request.query.offset) ?? 0 });
  if(error) return refuse(response, error);
  response.json(result);
};
