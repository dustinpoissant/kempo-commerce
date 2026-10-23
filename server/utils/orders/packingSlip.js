import * as kempo from 'kempo/server/sdk.js';
import { EVENTS, guard } from '../hooks.js';
import { buildContext, escapeHtml } from './emails.js';

/*
  The packing slip that goes in the box: the order's items and where it is going, with no prices. It is an email template
  (emails/packing-slip.page.html) rendered by kempo's email engine and handed back as HTML instead of being sent, so the shop
  changes it the same way as any email: a site puts its own at `templates/emails/kempo-commerce/packing-slip.page.html`, and
  the layout is the site's email layout. Nothing is stored: it is drawn from the order each time, so it always shows the
  address as it is now.

  Other extensions add to the data (a shipping method, a gift message) through the `order:email_context` guard, which gets
  `template: 'packing-slip'`. Everything that came from a customer or from staff is escaped here, once.
*/
const TEMPLATE = 'kempo-commerce/packing-slip';

const optionsOf = line => (line.optionLines?.length
  ? line.optionLines.map(option => `${option.optionLabel}: ${option.choiceLabel}`).join(', ')
  : Object.entries(line.selections ?? {}).map(([key, value]) => `${key}: ${value}`).join(', '));

/* The lines of the address, one string each, empty ones left out. */
export const addressLines = address => {
  if(!address || typeof address !== 'object') return [];
  const place = [address.city, address.state, address.postalCode].filter(Boolean).join(', ');
  return [address.name, address.line1, address.line2, place, address.country].map(part => String(part ?? '').trim()).filter(Boolean);
};

/* The items to pack: the ones that are sent, or every item when none says so (an order placed before that was recorded). */
export const itemsToPack = lines => {
  const sent = (lines ?? []).filter(line => line.fulfillment !== 'none');
  return sent.length ? sent : (lines ?? []);
};

export const renderPackingSlip = async order => {
  const items = itemsToPack(order.lines).map(line => ({ name: escapeHtml(line.name), options: escapeHtml(optionsOf(line)), hasOptions: Boolean(optionsOf(line)), quantity: line.quantity }));
  const shipTo = addressLines(order.data?.shipping).map(escapeHtml);
  const context = await buildContext(order, {
    placedDate: order.placedAt ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(order.placedAt)) : '',
    shipTo,
    hasShipTo: shipTo.length > 0,
    packItems: items,
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
  });
  const refused = await guard(EVENTS.orderEmailContext, { order, template: 'packing-slip', context });
  if(refused) return [refused, null];
  return kempo.renderEmailTemplate({ template: TEMPLATE, data: context });
};
