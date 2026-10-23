import previewEmail from '../../../../server/utils/orders/previewEmail.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* One of the shop's email templates drawn as it would be sent, to open in a tab. `?template=kempo-commerce/order-note`. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:settings:manage');
  if(gateError) return refuse(response, gateError);

  const [error, page] = await previewEmail({ template: request.query.template });
  if(error) return refuse(response, error);
  response.type('html').send(page);
};
