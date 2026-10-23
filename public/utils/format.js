import { displayMoney } from '/products/sdk.js';
import { getConfig } from '/commerce/sdk.js';

/*
  Money for display. Every amount the server sends is an integer in the currency's smallest unit; the
  currency and its decimals come from the site (kempo-products' currency setting), fetched once.
*/

let loading = null;

export const loadFormat = () => {
  loading ??= getConfig().then(([error, data]) => {
    const config = error ? { currency: 'usd', decimals: 2 } : data.config;
    return { config, money: minor => displayMoney(minor, config.currency, config.decimals) };
  });
  return loading;
};

/* Customer-visible status words. */
export const STATUS_LABELS = {
  pending_payment: 'Waiting for payment',
  processing: 'Processing',
  completed: 'Completed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  failed: 'Failed',
};

export const statusLabel = status => STATUS_LABELS[status] ?? status;

/* Used as a class on a badge: kempo-css text colours. */
export const STATUS_COLORS = {
  pending_payment: 'tc-warning',
  processing: 'tc-primary',
  completed: 'tc-success',
  on_hold: 'tc-warning',
  cancelled: 'tc-muted',
  refunded: 'tc-muted',
  failed: 'tc-danger',
};

export const formatDate = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

/* "Size: Large, Color: Red" from an order line's option lines or a cart line's selections. */
export const optionsText = line => {
  if(line.optionLines?.length) return line.optionLines.map(option => `${option.optionLabel}: ${option.choiceLabel}`).join(', ');
  return Object.entries(line.selections ?? {}).map(([key, value]) => `${key}: ${value}`).join(', ');
};

/*
  The names of the items a discount or fee was taken for, from the `lineId`(s) it carries and the lines of the cart or
  order, each name once: "1000 Credits, Starter credits". Empty for a row that belongs to the whole order.
*/
export const itemNames = (lineIds, lines) => [...new Set((Array.isArray(lineIds) ? lineIds : [lineIds]).map(id => (lines ?? []).find(line => line.id === id)?.name).filter(Boolean))].join(', ');

/* The words for the history of an order. */
export const eventText = event => {
  const data = event.data ?? {};
  switch(event.type){
    case 'placed': return 'Order placed';
    case 'paid': return 'Payment received';
    case 'status': return `Status changed to ${statusLabel(data.to).toLowerCase()}${data.note ? ` (${data.note})` : ''}`;
    case 'fulfillment': return `${data.name}: ${data.to === 'done' ? 'sent' : 'waiting to be sent'}`;
    case 'refund': return `Refunded${data.reason ? `: ${data.reason}` : ''}`;
    case 'note': return 'A note was added';
    case 'message': return `Emailed the customer: ${data.subject}`;
    case 'email_sent': return `Email sent: ${String(data.template ?? '').replaceAll('-', ' ')}`;
    case 'email_failed': return `Email not sent (${String(data.template ?? '').replaceAll('-', ' ')}): ${data.error ?? 'unknown error'}`;
    case 'late_payment_refunded': return 'A payment arrived after the order expired and was refunded';
    case 'linked_to_account': return 'Added to your account';
    default: return data.summary || event.type.replaceAll('_', ' ');
  }
};
