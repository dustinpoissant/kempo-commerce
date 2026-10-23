import { getOrder } from '../../../../../server/utils/orders/read.js';
import { renderPackingSlip } from '../../../../../server/utils/orders/packingSlip.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/* The order's packing slip as a page to print, opened in a new tab from the admin order page. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:orders:view');
  if(gateError) return refuse(response, gateError);

  const [orderError, order] = await getOrder(request.params.id);
  if(orderError) return refuse(response, orderError);
  const [error, page] = await renderPackingSlip(order);
  if(error) return refuse(response, error);
  response.type('html').send(page);
};
