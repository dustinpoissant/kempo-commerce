import * as kempo from 'kempo/server/sdk.js';
import { buildContext, escapeHtml } from './emails.js';
import { getOrder, listOrders } from './read.js';
import { renderPackingSlip } from './packingSlip.js';
import { readConfig } from '../config/settings.js';

/*
  An email template drawn as it would be sent, for the preview on the Emails tab of the settings: the same data a real send has,
  from the most recent order (or a made-up one when there are no orders yet) and made-up wording for the parts an order does not
  have (a note, a refund, a password link). Nothing is sent and nothing is recorded. The packing slip is drawn the way its button does.
  Resolves to [error, html].
*/
const SAMPLE_ORDER = {
  id: 'ord_sample',
  number: 1001,
  currency: 'usd',
  status: 'processing',
  email: 'customer@example.com',
  orderKey: 'sample',
  userId: 'sample',
  placedAt: new Date(),
  billing: { name: 'Sample Customer' },
  data: { shipping: { name: 'Sample Customer', line1: '123 Main Street', city: 'Springfield', state: 'VT', postalCode: '05156', country: 'US' } },
  subtotal: 4500,
  feeTotal: 500,
  taxTotal: 300,
  total: 5300,
  paidTotal: 5300,
  lines: [
    { id: 'line_1', name: 'Sample product', quantity: 1, unitPrice: 2500, lineTotal: 2500, fulfillment: 'pending', optionLines: [{ optionLabel: 'Color', choiceLabel: 'Blue' }], selections: {} },
    { id: 'line_2', name: 'Another product', quantity: 2, unitPrice: 1000, lineTotal: 2000, fulfillment: 'pending', optionLines: [], selections: {} },
  ],
  tenders: [{ kind: 'card', status: 'applied', amount: 5300 }],
  shown: { refundPolicy: 'Returns are accepted within 30 days.' },
};

const sampleOrder = async () => {
  const [, found] = await listOrders({ limit: 1 });
  if(found?.items?.length){
    const [, order] = await getOrder(found.items[0].id);
    if(order) return order;
  }
  return SAMPLE_ORDER;
};

export default async ({ template } = {}) => {
  const [owner, name] = String(template ?? '').split('/');
  if(owner !== 'kempo-commerce' || !name) return [{ code: 400, msg: 'Only kempo-commerce templates can be previewed here' }, null];

  const order = await sampleOrder();
  if(name === 'packing-slip') return renderPackingSlip(order);

  const config = await readConfig();
  const context = await buildContext(order, {
    note: escapeHtml('This is a sample note from the shop about your order.'),
    refundAmount: '$5.00',
    refundReason: escapeHtml('A sample reason for the refund.'),
    resetLink: `${config.siteUrl}/reset-password?token=sample`,
  });
  return kempo.renderEmailTemplate({ template, data: context });
};
