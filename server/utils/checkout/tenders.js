import { decimalsFor } from 'kempo-products/sdk';
import { loadCredits, loadStoreCredit } from '../optional.js';
import { EVENTS, guard } from '../hooks.js';

/*
  A tender is a way an order is paid. Card, store credit and credits are all "a way the order was paid"
  with the same life: apply, maybe reverse before the order is finished, maybe refund after. Treating
  them as one thing means refunds and failed-payment cleanup are one loop instead of three special
  cases, and a later extension (a gift card, a wallet) is a new tender kind, not a change to commerce.

    registerTender({
      kind: 'gift-card',
      label: 'Gift card',
      priority: 30,                                                   // applied in this order; cards are last
      available: async ({ userId, cart, due, currency }) => ({ max: 5000, detail: {} }),   // or null
      apply: async ({ order, tender, userId }) => [error, { reference, detail }],
      reverse: async ({ order, tender, userId }) => [error, true],    // before the order is finished
      refund: async ({ order, tender, amount, refundId, userId }) => [error, { reference }],
    });

  Tenders are applied in `priority` order against what is still due, undone in reverse, and refunded to
  themselves. The card is always last and takes whatever is left. Every function returns `[error, data]`.

  The registry is in memory, one per process: an extension registers its tender from a module its own
  routes or hooks import.
*/

const registry = new Map();

export const registerTender = definition => {
  if(!definition || typeof definition.kind !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(definition.kind)) return [{ code: 400, msg: 'A tender needs a kind of lowercase letters, numbers and dashes' }, null];
  if(typeof definition.label !== 'string' || !definition.label) return [{ code: 400, msg: 'A tender needs a label' }, null];
  for(const fn of ['available', 'apply', 'reverse', 'refund']){
    if(typeof definition[fn] !== 'function') return [{ code: 400, msg: `A tender needs an ${fn} function` }, null];
  }
  registry.set(definition.kind, { priority: 100, ...definition });
  return [null, true];
};

export const unregisterTender = kind => registry.delete(kind);

export const getTender = kind => registry.get(kind) ?? null;

export const listTenders = () => [...registry.values()].sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind));

/* ---- credits: the site's in-app currency, for the part of the price a product lets it pay ---- */

const unitsToMinor = (credits, perUnit, currency) => Math.floor(credits * 10 ** decimalsFor(currency) / perUnit);
const minorToUnits = (minor, perUnit, currency) => Math.ceil(minor * perUnit / 10 ** decimalsFor(currency));

registerTender({
  kind: 'credits',
  label: 'Credits',
  priority: 10,
  available: async ({ userId, cart, due, currency }) => {
    if(!userId) return null;
    const sdk = await loadCredits();
    if(!sdk) return null;

    const eligible = cart.lines.filter(line => !line.blocked && line.credits && line.credits.maxCredits > 0);
    if(!eligible.length) return null;
    const maxCredits = eligible.reduce((sum, line) => sum + line.credits.maxCredits * line.quantity, 0);
    const coveredMinor = eligible.reduce((sum, line) => sum + line.credits.coveredMinor * line.quantity, 0);
    const perUnit = eligible[0].credits.perUnit;

    const [error, balance] = await sdk.getBalance({ userId });
    if(error) return null;
    const usable = Math.min(balance.total, maxCredits);
    if(usable <= 0) return null;

    const max = Math.min(unitsToMinor(usable, perUnit, currency), coveredMinor, due);
    return max > 0 ? { max, detail: { balance: balance.total, perUnit, maxCredits: usable } } : null;
  },
  /* The customer says how many credits; the tender works in the money they cover. */
  toAmount: (asked, offer, currency) => unitsToMinor(Number(asked), offer.detail.perUnit, currency),
  describe: ({ amount, offer, currency }) => ({ credits: minorToUnits(amount, offer.detail.perUnit, currency), perUnit: offer.detail.perUnit }),
  apply: async ({ order, tender, userId }) => {
    const sdk = await loadCredits();
    if(!sdk) return [{ code: 409, msg: 'Credits are not available right now' }, null];
    const [error, spent] = await sdk.spendCredits({
      userId, amount: tender.detail.credits, reason: 'order', reference: { owner: 'kempo-commerce', ref: order.id }, idempotencyKey: tender.idempotencyKey,
    });
    if(error) return [error, null];
    return [null, { reference: spent.operationId, detail: tender.detail }];
  },
  reverse: async ({ tender, userId }) => {
    const sdk = await loadCredits();
    if(!sdk) return [{ code: 409, msg: 'Credits are not available right now' }, null];
    const [error] = await sdk.reverseSpend({ userId, idempotencyKey: tender.idempotencyKey });
    return error && error.code !== 404 ? [error, null] : [null, true];
  },
  /* Credits come back as a new grant, which also works for part of a spend. */
  refund: async ({ order, tender, amount, refundId, userId }) => {
    const sdk = await loadCredits();
    if(!sdk) return [{ code: 409, msg: 'Credits are not available right now' }, null];
    const credits = Math.min(tender.detail.credits, minorToUnits(amount, tender.detail.perUnit, order.currency));
    if(credits < 1) return [null, { reference: null }];
    const [error, granted] = await sdk.grantCredits({
      userId, amount: credits, kind: 'refund', reason: 'order-refund',
      reference: { owner: 'kempo-commerce', ref: refundId }, idempotencyKey: `refund:${refundId}:credits`,
    });
    return error ? [error, null] : [null, { reference: granted.operationId ?? null, credits }];
  },
});

/* ---- store credit: money the store owes the customer, in the store's currency ---- */

registerTender({
  kind: 'store-credit',
  label: 'Store credit',
  priority: 20,
  available: async ({ userId, due }) => {
    if(!userId) return null;
    const sdk = await loadStoreCredit();
    if(!sdk) return null;
    const [error, balance] = await sdk.getBalance({ userId });
    if(error || !(balance.amount > 0)) return null;
    const held = balance.amount;
    const max = Math.min(held, due);
    return max > 0 ? { max, detail: { balance: held } } : null;
  },
  apply: async ({ order, tender, userId }) => {
    const sdk = await loadStoreCredit();
    if(!sdk) return [{ code: 409, msg: 'Store credit is not available right now' }, null];
    const [error, spent] = await sdk.spendCredit({
      userId, amount: tender.amount, partial: false, reason: 'order', reference: { owner: 'kempo-commerce', ref: order.id }, idempotencyKey: tender.idempotencyKey,
    });
    if(error) return [error, null];
    return [null, { reference: spent.entry?.id ?? null, detail: {} }];
  },
  reverse: async ({ tender, userId }) => {
    const sdk = await loadStoreCredit();
    if(!sdk) return [{ code: 409, msg: 'Store credit is not available right now' }, null];
    const [error] = await sdk.reverseSpend({ userId, idempotencyKey: tender.idempotencyKey });
    return error && error.code !== 404 ? [error, null] : [null, true];
  },
  refund: async ({ order, tender, amount, refundId, userId }) => {
    const sdk = await loadStoreCredit();
    if(!sdk) return [{ code: 409, msg: 'Store credit is not available right now' }, null];
    const [error, added] = await sdk.addCredit({
      userId, amount, reason: 'refund', reference: { owner: 'kempo-commerce', ref: refundId }, idempotencyKey: `refund:${refundId}:store-credit`,
    });
    return error ? [error, null] : [null, { reference: added.entry?.id ?? null }];
  },
});

/* ---- card: whatever is left, through kempo-payments ---- */

const loadPayments = () => import('kempo-payments/sdk');

registerTender({
  kind: 'card',
  label: 'Card',
  priority: 1000,
  available: async ({ due }) => due > 0 ? { max: due, detail: {} } : null,
  apply: async ({ order, tender, userId }) => {
    const payments = await loadPayments();
    const [error, created] = await payments.createPayment({
      amount: tender.amount, currency: order.currency, owner: 'kempo-commerce', reference: order.id,
      userId: userId || null, customerEmail: order.email, description: `Order ${order.number}`,
    });
    if(error) return [error, null];
    return [null, { reference: created.payment.id, detail: { clientSecret: created.clientSecret ?? null }, pending: true }];
  },
  /* A customer coming back to a payment that is still waiting needs the form's secret again. */
  resume: async ({ tender }) => {
    const payments = await loadPayments();
    const [error, found] = await payments.getClientSecret(tender.reference);
    return error ? [error, null] : [null, { id: tender.reference, clientSecret: found.clientSecret, connectedAccount: found.connectedAccount }];
  },
  reverse: async ({ tender }) => {
    const payments = await loadPayments();
    if(!tender.reference) return [null, true];
    const [lookupError, payment] = await payments.getPayment(tender.reference);
    if(lookupError) return lookupError.code === 404 ? [null, true] : [lookupError, null];
    if(payment.status === 'succeeded') return [{ code: 409, msg: 'The card payment already went through' }, null];
    if(['canceled', 'failed'].includes(payment.status)) return [null, true];
    const [error] = await payments.cancelPayment(payment.id);
    return error ? [error, null] : [null, true];
  },
  refund: async ({ tender, amount, refundId, reason, issuedBy }) => {
    const payments = await loadPayments();
    const [error, refund] = await payments.refundPayment(tender.reference, { amount, reason: reason || undefined, issuedBy: issuedBy || undefined, idempotencyKey: `refund:${refundId}:card` });
    return error ? [error, null] : [null, { reference: refund?.id ?? null }];
  },
});

/*
  Money taken some way commerce cannot see (cash, a transfer), recorded when an administrator marks an
  order paid. It is never offered at checkout and has nothing to apply or reverse; refunding it is
  something a person does by hand, and the refund says so.
*/
registerTender({
  kind: 'manual',
  label: 'Paid by hand',
  priority: 900,
  available: async () => null,
  apply: async () => [null, { reference: null, detail: {} }],
  reverse: async () => [null, true],
  refund: async () => [null, { reference: null, byHand: true }],
});

/*
  What this customer could use right now for this cart. `due` is what is still to pay; the `checkout:tenders`
  guard lets an extension offer, limit or remove ways to pay.
*/
export const offerTenders = async ({ cart, userId, due, currency }) => {
  const offers = [];
  for(const tender of listTenders()){
    const offer = await tender.available({ userId, cart, due, currency });
    if(offer && offer.max > 0) offers.push({ kind: tender.kind, label: tender.label, priority: tender.priority, max: Math.min(offer.max, due), detail: offer.detail ?? {} });
  }
  const refused = await guard(EVENTS.checkoutTenders, { cart, userId, tenders: offers, due });
  return refused ? [refused, null] : [null, offers.filter(offer => offer.max > 0)];
};

/*
  Splits what is due across the tenders the customer asked for, in priority order, with the card last
  taking the rest. `requested` is { kind: amount | true }. `true` (or 'max') means as much as possible.
  A specific amount that is no longer available (the balance moved since the quote) is a 409 saying so,
  rather than quietly charging a different mix; the customer reviews and confirms.
*/
export const allocate = ({ offers, requested = {}, due, currency }) => {
  const plan = [];
  let remaining = due;

  const offered = new Set(offers.map(offer => offer.kind));
  for(const [kind, asked] of Object.entries(requested ?? {})){
    if(!asked || asked === true || asked === 'max' || kind === 'card' || offered.has(kind)) continue;
    const definition = getTender(kind);
    if(!definition) return [{ code: 400, msg: `"${kind}" is not a way to pay here` }, null];
    return [{ code: 409, msg: `You can no longer use ${definition.label.toLowerCase()} on this order. Please review the total and try again.`, changed: kind }, null];
  }

  for(const offer of [...offers].sort((a, b) => a.priority - b.priority)){
    if(offer.kind === 'card') continue;
    const asked = requested[offer.kind];
    if(!asked) continue;
    const definition = getTender(offer.kind);

    const wantsMax = asked === true || asked === 'max';
    const wanted = wantsMax ? Infinity : (definition.toAmount ? definition.toAmount(asked, offer, currency) : Number(asked));
    if(!wantsMax && (!Number.isSafeInteger(wanted) || wanted < 0)) return [{ code: 400, msg: `That is not an amount of ${offer.label.toLowerCase()}` }, null];

    const amount = Math.min(wanted, offer.max, remaining);
    if(!wantsMax && amount < wanted) return [{ code: 409, msg: `The ${offer.label.toLowerCase()} you can use changed. Please review the total and try again.`, changed: offer.kind }, null];
    if(amount <= 0) continue;

    remaining -= amount;
    plan.push({ kind: offer.kind, amount, detail: definition.describe ? definition.describe({ amount, offer, currency }) : {} });
  }

  if(remaining > 0) plan.push({ kind: 'card', amount: remaining, detail: {} });
  return [null, plan];
};
