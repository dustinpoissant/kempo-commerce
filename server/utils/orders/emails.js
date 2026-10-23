import * as kempo from 'kempo/server/sdk.js';
import { displayMoney } from 'kempo-products/sdk';
import db from 'kempo/server/db/index.js';
import { readConfig } from '../config/settings.js';
import { EVENTS, guard } from '../hooks.js';
import { addEvent } from './events.js';
import { formatOrderNumber } from './number.js';

/*
  Customer emails and administrator notifications.

  Commerce sends nothing itself: it uses kempo's own email system (`sendEmailFromTemplate`, which logs the
  email and has an email extension send it) and only supplies the templates in emails/ and their data. The set
  is WooCommerce's: received, processing, completed, on hold, failed, refunded, a note for the
  customer, and (new here) the link to set a password for an account made at checkout. Administrators
  get kempo notifications, not email.

  A send that fails is logged and recorded on the order's history, and never fails the order.

  `{{var}}` in a template is inserted as it is, with no escaping, so every string that came from a
  customer or a member of staff is escaped here, once, before it reaches a template.
*/

const OWNER = 'kempo-commerce';

export const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (order, amount) => displayMoney(amount, order.currency);

/* Where a customer finds their order: their account page, or for a guest the link carrying the order's key. */
export const orderLink = (order, siteUrl) => order.userId
  ? `${siteUrl}/commerce/account/orders/${encodeURIComponent(order.id)}/`
  : `${siteUrl}/commerce/order/${encodeURIComponent(order.id)}/received/?key=${encodeURIComponent(order.orderKey)}`;

export const buildContext = async (order, extra = {}) => {
  const config = await readConfig();
  const [, siteName] = await kempo.getSetting('system', 'site_name', 'our store');
  return {
    siteName: escapeHtml(siteName),
    siteUrl: config.siteUrl,
    name: escapeHtml(order.billing?.name || ''),
    orderNumber: escapeHtml(formatOrderNumber(order.number, config)),
    orderLink: orderLink(order, config.siteUrl),
    status: escapeHtml(order.status.replace('_', ' ')),
    subtotal: money(order, order.subtotal),
    feeTotal: money(order, order.feeTotal),
    hasFees: order.feeTotal !== 0,
    taxTotal: money(order, order.taxTotal),
    hasTax: order.taxTotal !== 0,
    total: money(order, order.total),
    paidTotal: money(order, order.paidTotal),
    lines: (order.lines ?? []).map(line => ({
      name: escapeHtml(line.name),
      quantity: line.quantity,
      unit: money(order, line.unitPrice),
      total: money(order, line.lineTotal),
    })),
    tenders: (order.tenders ?? []).filter(tender => tender.status === 'applied').map(tender => ({ label: escapeHtml(tender.kind.replace('-', ' ')), amount: money(order, tender.amount) })),
    refundPolicy: escapeHtml(order.shown?.refundPolicy ?? ''),
    hasRefundPolicy: Boolean(order.shown?.refundPolicy),
    ...extra,
  };
};

/*
  Sends one of this extension's templates to the order's customer. Other extensions can add to the data
  (a tracking number, a download link) through the `order:email_context` guard.
*/
export const sendOrderEmail = async (order, template, subject, extra = {}) => {
  try {
    const context = await buildContext(order, extra);
    const refused = await guard(EVENTS.orderEmailContext, { order, template, context });
    if(refused) return [refused, null];

    const [error] = await kempo.sendEmailFromTemplate({ to: order.email, subject, template: `${OWNER}/${template}`, data: context });
    if(error){
      console.error(`[kempo-commerce] Could not send "${template}" for order ${order.id}: ${error.msg}`);
      await addEvent(db, order.id, 'email_failed', { data: { template, error: error.msg } }).catch(() => {});
      return [error, null];
    }
    await addEvent(db, order.id, 'email_sent', { data: { template } }).catch(() => {});
    return [null, { sent: true }];
  } catch(error) {
    console.error(`[kempo-commerce] Could not send "${template}" for order ${order.id}:`, error);
    return [{ code: 500, msg: 'Failed to send the email' }, null];
  }
};

/*
  A notification for the people who run the shop. Notifications are optional for the user's kempo
  version, so a kempo that predates them just means no notification.
*/
export const notifyAdmins = async ({ title, message, level = 'info', orderId, dedupeKey }) => {
  if(typeof kempo.createNotification !== 'function') return;
  try {
    await kempo.createNotification({
      owner: OWNER, title, message, level, permission: 'commerce:orders:view', dedupeKey,
      actions: orderId ? [{ label: 'View order', href: `/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(orderId)}` }] : undefined,
    });
  } catch(error) {
    console.error('[kempo-commerce] Could not notify administrators:', error);
  }
};

const SUBJECTS = {
  'order-received': 'We received your order',
  'order-processing': 'Your order is being processed',
  'order-completed': 'Your order is complete',
  'order-on-hold': 'Your order is on hold',
  'order-failed': 'Your payment did not go through',
  'order-cancelled': 'Your order was cancelled',
  'order-refunded': 'Your order was refunded',
};

/* The emails and notifications a change of status sends. */
export const sendStatusEmail = async (order, from, to) => {
  const config = await readConfig();
  const label = formatOrderNumber(order.number, config);

  if(to === 'pending_payment' && from === 'on_hold') return;
  if(to === 'processing' && from === 'pending_payment'){
    await sendOrderEmail(order, 'order-processing', `${SUBJECTS['order-processing']} (${label})`);
    await notifyAdmins({ title: `New order ${label}`, message: `${order.billing?.name || order.email} placed an order for ${money(order, order.total)}.`, level: 'success', orderId: order.id, dedupeKey: `order:${order.id}:new` });
    return;
  }
  if(to === 'completed'){
    if(from === 'pending_payment') await notifyAdmins({ title: `New order ${label}`, message: `${order.billing?.name || order.email} placed an order for ${money(order, order.total)}.`, level: 'success', orderId: order.id, dedupeKey: `order:${order.id}:new` });
    if(from === 'processing' || from === 'pending_payment') await sendOrderEmail(order, 'order-completed', `${SUBJECTS['order-completed']} (${label})`);
    return;
  }
  const template = { on_hold: 'order-on-hold', failed: 'order-failed', cancelled: 'order-cancelled', refunded: 'order-refunded' }[to];
  if(template) await sendOrderEmail(order, template, `${SUBJECTS[template]} (${label})`);
};
