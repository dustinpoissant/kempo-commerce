import { readConfig } from '../config/settings.js';
import { getCart } from '../carts/cart.js';
import { collectAdjustments, computeTotals } from '../totals.js';
import { EVENTS, guard } from '../hooks.js';
import { quoteTax, taxEnabled, addressRequirements } from './tax.js';
import { offerTenders, allocate } from './tenders.js';

/*
  Prices the cart for checkout, without changing anything. The checkout page calls this when it opens
  and again whenever the address or the tenders change; `placeOrder` runs the same work again on the
  server and refuses if it no longer matches what the customer saw.

  Returns the cart, the totals (tax included once there is an address), what could be used to pay and
  how that would be split, the extra fields extensions want collected, and what the customer must do
  about an account.
*/

/* Does this cart need an account? A guest cannot be given credits, and a site may turn guests off. */
export const accountRules = ({ cart, userId, config }) => {
  const givesCredits = cart.lines.some(line => line.creditsGranted > 0 || line.creditsOnly);
  const required = !userId && (givesCredits || !config.guestCheckout);
  return {
    signedIn: Boolean(userId),
    required,
    reason: required ? (givesCredits ? 'credits' : 'guests-off') : null,
    canCreate: !userId && (config.allowAccountCreation || required),
    guestAllowed: !userId && !required,
  };
};

export const collectFields = async cart => {
  const fields = [];
  await guard(EVENTS.checkoutFields, { cart, fields });
  return fields.filter(field => field && typeof field.key === 'string' && typeof field.label === 'string');
};

export const startCheckout = async ({ cartId, userId = null, billing = null, data = {}, tenders = {} } = {}) => {
  const [cartError, cart] = await getCart({ cartId });
  if(cartError) return [cartError, null];
  /* 'checkout' is the cart while a placement is in progress, which is when placeOrder prices it again. */
  if(!['open', 'checkout'].includes(cart.status)) return [{ code: 409, msg: 'This cart is no longer open' }, null];
  if(!cart.lines.length) return [{ code: 409, msg: 'Your cart is empty' }, null];
  if(cart.blocked) return [{ code: 409, msg: 'Something in your cart needs your attention before you can check out', notices: cart.notices }, null];

  const config = await readConfig();
  /* The fees that depend on what the customer has entered (shipping) are worked out here, with those details. */
  cart.adjustments = await collectAdjustments({ cart, checkout: { billing, data: data ?? {} } });
  const [taxError, tax] = await quoteTax({ lines: cart.lines, adjustments: cart.adjustments, billing, currency: cart.currency, cart });
  if(taxError) return [taxError, null];

  const totals = computeTotals({ lines: cart.lines, adjustments: cart.adjustments, tax, pricesIncludeTax: tax?.pricesIncludeTax ?? false });
  const [offerError, offers] = userId ? await offerTenders({ cart, userId, due: totals.total, currency: cart.currency }) : [null, []];
  if(offerError) return [offerError, null];

  const [planError, plan] = allocate({ offers, requested: tenders, due: totals.total, currency: cart.currency });
  if(planError) return [planError, null];

  return [null, {
    cart,
    totals,
    tax,
    taxEnabled: await taxEnabled(),
    required: await addressRequirements(billing),
    tenders: offers,
    plan,
    covered: totals.total === 0 || !plan.some(entry => entry.kind === 'card'),
    fields: await collectFields(cart),
    account: accountRules({ cart, userId, config }),
    refundPolicy: config.refundPolicy,
  }];
};
