import { loadCredits } from '../optional.js';
import { readConfig } from '../config/settings.js';
import { EVENTS, guard } from '../hooks.js';
import { getOrder } from '../orders/read.js';
import { getTender } from '../checkout/tenders.js';

/*
  Works out a refund without doing it: what each line comes to, how the money goes back tender by
  tender, and — when the customer was given credits that the refund takes back — whether they have
  already spent some. Changes nothing, and the issue step runs it again, so the numbers an
  administrator confirmed are never taken on trust.

  **Refunds go back to where the money came from, tender by tender**: card money to the card, store
  credit to store credit, credits to credits. An administrator may choose to return the card part as
  store credit instead. A refund is for lines and quantities, or an amount, never more than was paid
  and not yet returned. Per line, the amount is exactly that line's share (price, and tax unless
  prices include it), so refunding a line twice in parts adds up to the line.

  **Spent credits are never refunded as money.** If a product gave credits and the customer has
  already spent some, `credits.shortfall` says how many cannot be taken back, and the administrator
  has to choose before the refund can be issued: take what they hold and leave them at zero, or take
  all of it and leave them owing the rest.
*/

const COUNTED = ['issuing', 'issued', 'partial'];

const lineGross = (order, line) => line.lineTotal + (order.pricesIncludeTax ? 0 : line.tax);

/* What earlier refunds already returned for a line (or the fees), from their records. */
const returnedFor = (order, key) => order.refunds
  .filter(refund => COUNTED.includes(refund.status))
  .reduce((sum, refund) => sum + (refund.lines?.[key]?.amount ?? 0), 0);

export const previewRefund = async ({ orderId, lines = null, amount = null, includeFees = false, destination = 'original', restock = null, actor = '' } = {}) => {
  const [orderError, order] = await getOrder(orderId);
  if(orderError) return [orderError, null];
  if(!order.paidAt || ['pending_payment', 'failed', 'cancelled'].includes(order.status)){
    return [{ code: 409, msg: order.paidAt ? `A ${order.status.replace('_', ' ')} order cannot be refunded` : 'Only an order that was paid can be refunded. Cancel it instead.' }, null];
  }
  const refundable = order.paidTotal - order.refundedTotal;
  if(refundable <= 0) return [{ code: 409, msg: 'This order has already been refunded in full' }, null];
  if(!['original', 'store-credit'].includes(destination)) return [{ code: 400, msg: 'The destination is original or store-credit' }, null];
  if(destination === 'store-credit' && !order.userId) return [{ code: 400, msg: 'Store credit needs an account, and this order was placed as a guest' }, null];

  const config = await readConfig();
  const byLine = {};
  let total = 0;
  let feesReturned = 0;

  if(lines && Object.keys(lines).length){
    if(amount !== null && amount !== undefined) return [{ code: 400, msg: 'Refund lines or an amount, not both' }, null];
    for(const [lineId, asked] of Object.entries(lines)){
      const line = order.lines.find(candidate => candidate.id === lineId);
      if(!line) return [{ code: 404, msg: 'That line is not on this order' }, null];
      const quantity = typeof asked === 'string' && asked.trim() !== '' ? Number(asked) : asked;
      const left = line.quantity - line.refundedQuantity;
      if(!Number.isInteger(quantity) || quantity < 1 || quantity > left) return [{ code: 400, msg: `${line.name}: you can refund 1 to ${left}` }, null];

      /* A share of what is left of the line, so the last unit takes the rounding and the line adds up exactly. */
      const remainingGross = lineGross(order, line) - returnedFor(order, lineId);
      const remainingTax = line.tax - order.refunds.filter(refund => COUNTED.includes(refund.status)).reduce((sum, refund) => sum + (refund.lines?.[lineId]?.tax ?? 0), 0);
      const share = quantity === left ? remainingGross : Math.floor(remainingGross * quantity / left);
      const taxShare = quantity === left ? remainingTax : Math.floor(remainingTax * quantity / left);
      const wantsRestock = restock && typeof restock === 'object' ? Boolean(restock[lineId]) : (restock ?? config.restockOnRefund);
      byLine[lineId] = { quantity, amount: share, tax: taxShare, name: line.name, restock: Boolean(wantsRestock) && !line.creditsOnly };
      total += share;
    }
    if(includeFees){
      const fees = order.feeTotal - returnedFor(order, 'fees');
      if(fees > 0){
        byLine.fees = { quantity: 0, amount: fees, tax: 0, name: 'Fees' };
        feesReturned = fees;
        total += fees;
      }
    }
  } else if(amount !== null && amount !== undefined){
    const wanted = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
    if(!Number.isSafeInteger(wanted) || wanted < 1) return [{ code: 400, msg: 'The amount is a whole number of the smallest currency unit, above zero' }, null];
    total = wanted;
  } else {
    return [{ code: 400, msg: 'Say which lines to refund, or an amount' }, null];
  }

  if(total > refundable) return [{ code: 409, msg: `That is more than is left to refund (${refundable})` }, null];
  if(total < 1) return [{ code: 400, msg: 'There is nothing to refund' }, null];

  /*
    How the money goes back: in proportion to what each tender still holds, so a refund of a third
    returns a third of each. The card, last, takes the rounding; none is asked for more than it has.
  */
  const open = order.tenders
    .filter(tender => tender.status === 'applied')
    .map(tender => ({ tender, left: tender.amount - tender.refundedAmount }))
    .filter(entry => entry.left > 0)
    .sort((a, b) => (getTender(a.tender.kind)?.priority ?? 0) - (getTender(b.tender.kind)?.priority ?? 0));
  const held = open.reduce((sum, entry) => sum + entry.left, 0);
  if(held < total) return [{ code: 409, msg: 'The tenders hold less than this refund. The order may have been refunded outside the shop.' }, null];

  const tenders = open.map(entry => ({ tenderId: entry.tender.id, kind: entry.tender.kind, label: getTender(entry.tender.kind)?.label ?? entry.tender.kind, amount: Math.min(entry.left, Math.floor(total * entry.left / held)) }));
  let leftover = total - tenders.reduce((sum, entry) => sum + entry.amount, 0);
  for(const entry of [...tenders].reverse()){
    const room = open.find(candidate => candidate.tender.id === entry.tenderId).left - entry.amount;
    const add = Math.min(room, leftover);
    entry.amount += add;
    leftover -= add;
  }
  for(const entry of tenders) if(entry.kind === 'card' && destination === 'store-credit') entry.viaStoreCredit = true;

  /* The credits the products gave, for the units being refunded. */
  const warnings = [];
  let credits = null;
  /*
    By lines, the credits those units gave. By amount there are no units, so it is the same share of
    the credits still to take back as the share of the money still to return (all of them when the
    rest of the money goes back).
  */
  const stillGiven = order.lines.reduce((sum, line) => sum + line.creditsGranted * (line.quantity - line.refundedQuantity), 0);
  const given = Object.keys(byLine).length
    ? Object.entries(byLine).reduce((sum, [lineId, entry]) => {
      const line = order.lines.find(candidate => candidate.id === lineId);
      return sum + (line ? line.creditsGranted * entry.quantity : 0);
    }, 0)
    : (total === refundable ? stillGiven : Math.floor(stillGiven * total / refundable));
  if(given > 0 && order.userId){
    const sdk = await loadCredits();
    if(sdk){
      const [previewError, state] = await sdk.previewClawBack({ reference: { owner: 'kempo-commerce', ref: order.id }, amount: given });
      if(!previewError){
        credits = {
          userId: state.userId, given, wanted: state.wanted, held: state.held, takeable: state.takeable, shortfall: state.shortfall,
          historyUrl: `/admin/extension/kempo-credits/account/?user=${encodeURIComponent(state.userId)}`,
        };
      } else if(previewError.code !== 404){
        warnings.push(`The credits these products gave could not be checked: ${previewError.msg}`);
      }
    }
  }

  const preview = { orderId: order.id, number: order.number, currency: order.currency, amount: total, refundable, lines: byLine, tenders, destination, includeFees: feesReturned > 0, credits, warnings };

  /* Extensions add warnings or blocks the administrator must see (a fraud signal, a shipment already sent). */
  const refused = await guard(EVENTS.refundBeforeIssue, { order, refund: { amount: total, lines: byLine, destination, actor }, preview });
  if(refused) preview.blocked = refused.msg;

  return [null, preview];
};
