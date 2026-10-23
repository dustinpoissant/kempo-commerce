import db from 'kempo/server/db/index.js';
import { getUserById } from 'kempo/server/sdk.js';
import { and, eq, ne } from 'drizzle-orm';
import {
  kempoCommerceOrder, kempoCommerceOrderLine, kempoCommerceOrderAdjustment, kempoCommerceTender, kempoCommerceCart,
} from '../../db/schema.js';
import newId, { secret } from '../ids.js';
import { readConfig } from '../config/settings.js';
import { EVENTS, guard, notify } from '../hooks.js';
import { addEvent } from '../orders/events.js';
import { takeOrderNumber } from '../orders/number.js';
import { assemble } from '../orders/read.js';
import { cleanBilling } from './billing.js';
import { createCheckoutAccount } from './account.js';
import { checkLimits } from './abuse.js';
import { startCheckout, accountRules } from './quote.js';
import { getTender } from './tenders.js';
import { completeOrder } from './complete.js';
import { takeStock, returnStock } from './stock.js';
import { unwindOrder, cancelUnpaidOrder, setTenderStatus } from './unwind.js';

/*
  Placing the order: the one operation that turns a cart into an order, takes what it can take, and
  starts the card payment for the rest.

  **Idempotent on `checkoutKey`**, which the checkout page makes once per checkout: placing the same
  key twice (a double click, a reload, a second tab) returns the first order and, if it is still
  waiting for a card, a fresh client secret for it, and takes nothing twice.

  What it does, in order, and how each is undone if a later one fails:

    1. limits      refuses a flood of attempts, or declines past the cool-down
    2. price       prices the cart again; refuses if the total is not the one the customer saw
    3. account     creates the account the customer asked for (or must have)
    4. quantity    takes the quantity of every line from the ledger, all or nothing        -> give it back
    5. order       creates the order, pending payment, with what was shown, and its tenders
    6. tenders     credits, then store credit, each under a key derived from the order -> reverse them
    7. card        creates the payment for what is left                                -> cancel it
    8. complete    if nothing is left to pay by card, the order is complete now

  A failure at 4 to 7 undoes the steps already taken, in reverse, and the order becomes `failed`.
  Money is only ever taken for an order that exists, under keys that name it, so a crash halfway is
  finished by the recovery sweep and not left half done.

  A customer who starts a new checkout from the same cart replaces their earlier unpaid one.
*/

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

const clientSecretFor = async (order, tender) => {
  try {
    const definition = getTender(tender.kind);
    if(!definition?.resume) return null;
    const [error, found] = await definition.resume({ order, tender });
    return error ? null : found;
  } catch {
    return null;
  }
};

/* The order a checkout key already made, as placeOrder returns it. */
const resume = async (orderRow, cartId, userId) => {
  if(orderRow.cartId !== cartId) return [{ code: 409, msg: 'That checkout key belongs to a different cart' }, null];
  if(orderRow.userId && userId && orderRow.userId !== userId) return [{ code: 409, msg: 'That checkout key belongs to someone else' }, null];
  const order = await assemble(orderRow);
  const card = order.tenders.find(tender => tender.kind === 'card' && tender.status === 'pending');
  return [null, { order, payment: card && order.status === 'pending_payment' ? await clientSecretFor(order, card) : null, duplicate: true }];
};

const snapshot = ({ cart, totals, adjustments, plan, config }) => ({
  currency: cart.currency,
  lines: cart.lines.map(line => ({ name: line.name, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal, selections: line.selections })),
  adjustments: adjustments.map(({ type, label, amount }) => ({ type, label, amount })),
  totals,
  tenders: plan.map(({ kind, amount }) => ({ kind, amount })),
  refundPolicy: config.refundPolicy,
  shownAt: new Date().toISOString(),
});

export const placeOrder = async ({ cartId, userId = null, checkoutKey, billing, data = {}, tenders = {}, account = null, expectedTotal = null, ip = null } = {}) => {
  if(!cartId) return [{ code: 400, msg: 'cartId is required' }, null];
  if(typeof checkoutKey !== 'string' || !KEY.test(checkoutKey)) return [{ code: 400, msg: 'A checkout key of 8 to 100 letters, numbers, dashes and underscores is required' }, null];
  if(data === null || typeof data !== 'object' || Array.isArray(data)) return [{ code: 400, msg: 'Checkout data must be an object' }, null];

  try {
    const [earlier] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.checkoutKey, checkoutKey));
    if(earlier) return resume(earlier, cartId, userId);

    const [limitError] = await checkLimits({ userId, ip, email: typeof billing?.email === 'string' ? billing.email : null });
    if(limitError) return [limitError, null];

    /* Only one placement of a cart at a time: two tabs placing at once, the second is told to try again. */
    const [claimed] = await db.update(kempoCommerceCart).set({ status: 'checkout', updatedAt: new Date() })
      .where(and(eq(kempoCommerceCart.id, cartId), eq(kempoCommerceCart.status, 'open'))).returning();
    if(!claimed){
      const [raced] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.checkoutKey, checkoutKey));
      if(raced) return resume(raced, cartId, userId);
      return [{ code: 409, msg: 'This cart is being checked out somewhere else, or is no longer open. Please reload.' }, null];
    }

    let result;
    try {
      result = await placeClaimed({ cartId, userId, checkoutKey, billing, data, tenders, account, expectedTotal, ip, claimed });
    } finally {
      await db.update(kempoCommerceCart).set({ status: 'open' }).where(and(eq(kempoCommerceCart.id, cartId), eq(kempoCommerceCart.status, 'checkout')));
    }
    return result;
  } catch(error) {
    console.error('[kempo-commerce] placeOrder failed:', error);
    return [{ code: 500, msg: 'Failed to place the order' }, null];
  }
};

const placeClaimed = async ({ cartId, userId, checkoutKey, billing, data, tenders, account, expectedTotal, ip, claimed }) => {
  const config = await readConfig();

  /* The signed-in customer's own details fill in the email. */
  let accountEmail = null;
  if(userId){
    const [, found] = await getUserById(userId);
    accountEmail = found?.email ?? null;
  }
  const [billingError, cleanBill] = await cleanBilling({ billing, accountEmail });
  if(billingError) return [billingError, null];

  const [quoteError, quote] = await startCheckout({ cartId, userId, billing: cleanBill, data, tenders });
  if(quoteError) return [quoteError, null];
  const { cart, totals, plan, tax } = quote;

  /* A guest, an account to be made, and the rules about when one is required. */
  const rules = accountRules({ cart, userId, config });
  const wantsAccount = !userId && account?.create === true;
  if(rules.required && !wantsAccount) return [{ code: 400, msg: rules.reason === 'credits' ? 'An account is needed to buy credits. Create one below, or sign in.' : 'Please sign in or create an account to check out', account: rules }, null];
  if(wantsAccount && !rules.canCreate) return [{ code: 400, msg: 'Accounts cannot be created at checkout on this site' }, null];

  const errors = [];
  const refusedValidation = await guard(EVENTS.checkoutValidate, { cart, billing: cleanBill, data, errors });
  if(refusedValidation) return [refusedValidation, null];
  if(errors.length) return [{ code: 400, msg: errors[0].msg || 'Please check the form', errors }, null];

  if(expectedTotal !== null && expectedTotal !== undefined && Number(expectedTotal) !== totals.total){
    return [{ code: 409, msg: 'The total changed since you last looked. Please review it and try again.', changed: true, totals }, null];
  }

  const draft = { cart, billing: cleanBill, data: { ...data }, totals, plan: plan.map(entry => ({ ...entry })), userId };
  const refused = await guard(EVENTS.checkoutBeforePlace, { cart, draft });
  if(refused) return [refused, null];

  let buyerId = userId;
  if(wantsAccount){
    const [accountError, made] = await createCheckoutAccount({ name: cleanBill.name, email: cleanBill.email });
    if(accountError) return [accountError, null];
    buyerId = made.userId;
  }

  /* An earlier unpaid checkout from this cart is replaced by this one. */
  const stale = await db.select().from(kempoCommerceOrder).where(and(eq(kempoCommerceOrder.cartId, cartId), eq(kempoCommerceOrder.status, 'pending_payment'), ne(kempoCommerceOrder.checkoutKey, checkoutKey)));
  for(const old of stale) await cancelUnpaidOrder(old.id, { actor: 'system', reason: 'Replaced by a new checkout' });

  const orderId = newId('ord');

  /* The quantity first: if there is not enough, no order exists at all. */
  const [stockError] = await takeStock({ orderId, lines: cart.lines, userId: buyerId || '' });
  if(stockError) return [stockError, null];

  const now = new Date();
  let order;
  try {
    order = await db.transaction(async tx => {
      const number = await takeOrderNumber(tx, config);
      const [row] = await tx.insert(kempoCommerceOrder).values({
        id: orderId, number, userId: buyerId || null, email: cleanBill.email, orderKey: secret(), status: 'pending_payment', currency: cart.currency,
        subtotal: totals.subtotal, feeTotal: totals.feeTotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal ?? 0, total: totals.total,
        pricesIncludeTax: totals.pricesIncludeTax, billing: cleanBill, shown: snapshot({ cart, totals, adjustments: cart.adjustments, plan, config }),
        data: draft.data, cartId, checkoutKey, taxCalculationId: tax?.calculationId ?? null, ip, placedAt: now, updatedAt: now,
      }).returning();

      /* The order's lines have their own ids, so a discount on a cart line is kept against the matching order line. */
      const lineIds = new Map(cart.lines.map(line => [line.id, newId('ol')]));
      await tx.insert(kempoCommerceOrderLine).values(cart.lines.map((line, position) => ({
        id: lineIds.get(line.id), orderId, position, productId: line.productId, slug: line.slug, name: line.name, selections: line.selections,
        optionLines: line.optionLines, unitPrice: line.unitPrice, quantity: line.quantity, lineTotal: line.lineTotal,
        tax: tax?.perLine?.[line.id] ?? 0, fulfillment: 'none', creditsGranted: line.creditsGranted ?? 0, creditsOnly: Boolean(line.creditsOnly), productType: line.productType ?? 'physical', data: line.data,
      })));

      const adjustments = [
        ...cart.adjustments.map(adjustment => ({ id: newId('adj'), orderId, lineId: lineIds.get(adjustment.lineId) ?? null, type: adjustment.type, code: adjustment.code, label: adjustment.label, amount: adjustment.amount, taxable: adjustment.taxable, source: adjustment.source, data: adjustment.data })),
        ...(totals.taxTotal ? [{ id: newId('adj'), orderId, lineId: null, type: 'tax', code: '', label: 'Tax', amount: totals.taxTotal, taxable: false, source: 'kempo-tax', data: {} }] : []),
      ];
      if(adjustments.length) await tx.insert(kempoCommerceOrderAdjustment).values(adjustments);

      if(draft.plan.length){
        await tx.insert(kempoCommerceTender).values(draft.plan.map(entry => ({
          id: newId('tdr'), orderId, kind: entry.kind, amount: entry.amount, status: 'pending', reference: null,
          idempotencyKey: `order:${orderId}:${entry.kind}`, detail: entry.detail ?? {}, createdAt: now, updatedAt: now,
        })));
      }
      await addEvent(tx, orderId, 'placed', { actor: buyerId || 'customer', visible: true, data: { total: totals.total } });
      return row;
    });
  } catch(error) {
    await returnStock(orderId, cart.lines);
    if((error?.code || error?.cause?.code) === '23505'){
      const [raced] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.checkoutKey, checkoutKey));
      if(raced) return resume(raced, cartId, userId);
    }
    throw error;
  }

  const undo = async error => {
    await unwindOrder(orderId, { to: 'failed', reason: error.msg });
    return [error, null];
  };

  let full = await assemble(order);
  await notify(EVENTS.orderCreated, { order: full, actor: '' });

  /* Credits, then store credit: each under a key made from the order, so a retry spends once. */
  const rows = [...full.tenders].sort((a, b) => (getTender(a.kind)?.priority ?? 0) - (getTender(b.kind)?.priority ?? 0));
  let payment = null;
  for(const tender of rows){
    const definition = getTender(tender.kind);
    if(!definition) return undo({ code: 500, msg: `The "${tender.kind}" payment method is not available` });

    const [applyError, applied] = await definition.apply({ order: full, tender, userId: buyerId });
    if(applyError) return undo(applyError);

    if(applied.pending){
      await db.update(kempoCommerceTender).set({ reference: applied.reference, detail: { ...tender.detail, ...applied.detail, clientSecret: undefined }, updatedAt: new Date() }).where(eq(kempoCommerceTender.id, tender.id));
      payment = { id: applied.reference, clientSecret: applied.detail?.clientSecret ?? null };
    } else {
      await setTenderStatus(tender.id, 'pending', 'applied', { reference: applied.reference, detail: { ...tender.detail, ...applied.detail } });
      await addEvent(db, orderId, 'tender_applied', { data: { kind: tender.kind, amount: tender.amount } });
    }
  }

  /* Nothing left for a card: the order is paid for now. */
  if(!payment){
    const [completeError, completed] = await completeOrder(orderId, { actor: 'system' });
    if(completeError) return completeError.expired ? undo(completeError) : [completeError, null];
    return [null, { order: completed.order, payment: null }];
  }

  full = await assemble((await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId)))[0]);
  return [null, { order: full, payment }];
};
