import { EVENTS, notify } from './hooks.js';
import { resolveDiscountRows } from './discounts.js';

/*
  The one place totals are calculated, used by the cart, the mini-cart, the checkout and the order, so
  what is shown is always what is charged.

    line total   = unit price × quantity            (kempo-products' price, never the browser's)
    subtotal     = Σ line totals
    discounts    = Σ adjustments of type discount   (negative; always 0 until a coupons extension exists)
    fees         = Σ adjustments of type fee        (shipping, handling, gift wrap)
    tax          = kempo-tax over the taxable lines (or nothing)
    total        = subtotal + discounts + fees + tax, and never below zero

  When prices include tax the tax is already inside the subtotal, so it is reported and not added again.

  Rounding is per line, never per order, so a refund of one line is exactly that line's amount.
*/

const KINDS = ['discount', 'fee'];

/*
  Other extensions contribute discounts and fees through hooks: `{ type, code, label, amount, lineId?,
  taxable?, source }`. A discount may instead say what it is, `data: { kind: 'fixed' | 'percent', value, stackable }` with a
  `lineId`, and leave `amount` out: the amounts are then worked out per line, together, by discounts.js. Commerce does not know what a coupon or a shipping rate is; it knows how to sum,
  display, tax and refund an adjustment. Anything malformed is dropped rather than trusted.
*/
export const collectAdjustments = async ({ cart, order, lines, currency }) => {
  const adjustments = [];
  const payload = { cart, order, lines: lines ?? cart?.lines ?? [], adjustments, currency: currency ?? cart?.currency ?? order?.currency };

  await notify(EVENTS.totalsDiscounts, payload);
  await notify(EVENTS.totalsFees, payload);

  /* A discount row that says what it is (a fixed amount or a percent, and whether it combines) gets its amount here, per line. */
  return resolveDiscountRows({ adjustments, lines: payload.lines })
    .filter(adjustment => adjustment && KINDS.includes(adjustment.type) && Number.isSafeInteger(adjustment.amount) && typeof adjustment.label === 'string' && adjustment.label)
    .map(adjustment => ({
      type: adjustment.type,
      code: String(adjustment.code ?? ''),
      label: adjustment.label,
      /* A discount always takes away and a fee always adds, whatever sign a handler wrote. */
      amount: adjustment.type === 'discount' ? -Math.abs(adjustment.amount) : Math.abs(adjustment.amount),
      lineId: adjustment.lineId ?? null,
      taxable: adjustment.taxable === true,
      source: String(adjustment.source ?? ''),
      data: adjustment.data ?? {},
    }));
};

const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

export const computeTotals = ({ lines, adjustments = [], tax = null, pricesIncludeTax = false }) => {
  const subtotal = sum(lines, line => line.lineTotal);
  const discountTotal = sum(adjustments.filter(adjustment => adjustment.type === 'discount'), adjustment => adjustment.amount);
  const feeTotal = sum(adjustments.filter(adjustment => adjustment.type === 'fee'), adjustment => adjustment.amount);
  const taxTotal = tax && Number.isSafeInteger(tax.tax) ? tax.tax : null;
  const before = subtotal + discountTotal + feeTotal;

  return {
    subtotal,
    discountTotal,
    feeTotal,
    taxTotal,
    taxComputed: taxTotal !== null,
    pricesIncludeTax,
    total: Math.max(0, before + (taxTotal !== null && !pricesIncludeTax ? taxTotal : 0)),
  };
};
