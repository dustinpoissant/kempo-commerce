import db from 'kempo/server/db/index.js';
import { and, eq, sql } from 'drizzle-orm';
import { adjustQuantity, addLedgerEntry, displayMoney } from 'kempo-products/sdk';
import { kempoCommerceOrder, kempoCommerceOrderLine, kempoCommerceRefund, kempoCommerceTender } from '../../db/schema.js';
import newId from '../ids.js';
import { loadCredits, loadStoreCredit } from '../optional.js';
import { EVENTS, notify } from '../hooks.js';
import { addEvent } from '../orders/events.js';
import { assemble } from '../orders/read.js';
import { moveStatus } from '../orders/status.js';
import { formatOrderNumber } from '../orders/number.js';
import { escapeHtml, notifyAdmins, sendOrderEmail } from '../orders/emails.js';
import { readConfig } from '../config/settings.js';
import { getTender } from '../checkout/tenders.js';
import { reverseSale } from '../checkout/tax.js';
import { previewRefund } from './preview.js';

/*
  Issuing a refund. An administrator does this from the order's page; there is no automatic refund of
  a paid order, and (as in WooCommerce core) a customer cannot ask for one through the shop.

  1. **Preview** again, so the numbers are the server's and not the browser's, and the credits warning
     is current. If the customer already spent credits the refund takes back, the administrator must
     have chosen what to do (`credits: 'zero' | 'owe'`) or this is refused with `needsDecision`.
  2. **Reserve.** In one transaction the order's `refundedTotal` and each line's `refundedQuantity` are
     raised by conditional updates that cannot exceed what was paid, and the refund is written
     `issuing`. Two refunds at once cannot both take the last of the money.
  3. **Move the money**, one step at a time, recording each: take back the credits the products gave,
     return each tender, reverse the tax, put the quantity back. Every step has a key made from the refund,
     so running it again does what is left and nothing twice.
  4. **Finish**: the order becomes `refunded` when everything paid has gone back (a partial refund
     keeps its status), the customer is emailed, and `refund:issued` fires.

  If a step fails after an earlier one succeeded the refund is left **partial** with exactly what was
  done and what was not, the shop is told, and `finishRefund` carries on from there. It is never
  silently half-applied.
*/

const OWNER = 'kempo-commerce';

const stepFor = (id, label) => ({ id, label, status: 'pending' });

const planSteps = preview => [
  ...(preview.credits && preview.credits.wanted > 0 ? [{ ...stepFor('clawback', 'Take back the credits the products gave'), amount: preview.credits.given }] : []),
  ...preview.tenders.filter(tender => tender.amount > 0).map(tender => stepFor(`tender:${tender.tenderId}`, `Return ${tender.label.toLowerCase()}`)),
  stepFor('tax', 'Reverse the tax'),
  ...(Object.values(preview.lines).some(line => line.restock) ? [stepFor('restock', 'Put the quantity back')] : []),
];

const saveSteps = (refundId, steps) => db.update(kempoCommerceRefund).set({ steps, updatedAt: new Date() }).where(eq(kempoCommerceRefund.id, refundId));

/* One step. Returns [error, detail]; each is idempotent, so running a finished one again is harmless. */
const perform = async ({ step, refund, order, actor }) => {
  const record = (await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.id, refund.id)))[0];

  if(step.id === 'clawback'){
    const sdk = await loadCredits();
    if(!sdk) return [{ code: 409, msg: 'kempo-credits is not available to take the credits back' }, null];
    const [error, result] = await sdk.clawBackGrant({
      reference: { owner: 'kempo-commerce', ref: order.id }, amount: step.amount, ifShort: record.credits || 'zero',
      reason: 'order-refund', idempotencyKey: `refund:${refund.id}:clawback`, actorId: actor || null,
    });
    if(error && error.code !== 409) return [error, null];
    return [null, { taken: result?.taken ?? 0, shortfall: result?.shortfall ?? 0, unrecovered: result?.unrecovered ?? 0 }];
  }

  if(step.id.startsWith('tender:')){
    const tenderId = step.id.slice('tender:'.length);
    const entry = record.tenders.find(candidate => candidate.tenderId === tenderId);
    const [tender] = await db.select().from(kempoCommerceTender).where(eq(kempoCommerceTender.id, tenderId));
    const definition = getTender(tender.kind);
    if(!definition) return [{ code: 500, msg: `The "${tender.kind}" payment method is not available` }, null];

    let result;
    if(entry.viaStoreCredit){
      const sdk = await loadStoreCredit();
      if(!sdk) return [{ code: 409, msg: 'kempo-store-credit is not available to return the money as store credit' }, null];
      const [error, added] = await sdk.addCredit({
        userId: order.userId, amount: entry.amount, reason: 'refund', reference: { owner: OWNER, ref: refund.id },
        idempotencyKey: `refund:${refund.id}:card-as-store-credit`,
      });
      if(error) return [error, null];
      result = { reference: added.entry?.id ?? null, viaStoreCredit: true };
    } else {
      const [error, refunded] = await definition.refund({
        order, tender, amount: entry.amount, refundId: refund.id, userId: order.userId, reason: record.reason, issuedBy: actor || null,
      });
      if(error) return [error, null];
      result = refunded;
    }
    /* Absolute, from the figure noted before the step began, so running the step again cannot count it twice. */
    const total = Math.min(tender.amount, step.before + entry.amount);
    await db.update(kempoCommerceTender).set({ refundedAmount: total, status: total >= tender.amount ? 'refunded' : tender.status, updatedAt: new Date() }).where(eq(kempoCommerceTender.id, tenderId));
    return [null, result];
  }

  if(step.id === 'tax'){
    if(!order.taxTransactionId) return [null, { skipped: true }];
    const [error, reversal] = await reverseSale({ transactionId: order.taxTransactionId, reference: `refund:${refund.id}`, amount: record.amount });
    return error ? [error, null] : [null, { reversed: reversal?.taxAmount ?? null }];
  }

  if(step.id === 'restock'){
    const notes = [];
    const wholeOrder = Object.keys(record.lines).filter(key => key !== 'fees').length === order.lines.length
      && order.lines.every(line => record.lines[line.id]?.quantity === line.quantity && record.lines[line.id]?.restock);
    if(wholeOrder){
      /* Everything goes back as one entry that undoes the order's own, which also returns inventory's materials. Credits are handled above. */
      const [error] = await addLedgerEntry({
        ref: `order:${order.id}:refund`, undoes: `order:${order.id}`, reason: 'return', note: `Order ${order.id} was refunded`, actor: OWNER,
        lines: order.lines.map(line => ({ productId: line.productId, change: line.quantity })),
      });
      if(error) return [error, null];
      return [null, { restockedAll: true }];
    }
    for(const [lineId, entry] of Object.entries(record.lines)){
      if(!entry.restock) continue;
      const line = order.lines.find(candidate => candidate.id === lineId);
      const [error] = await adjustQuantity(line.productId, entry.quantity, { actor: OWNER, reason: 'refund' });
      if(error) notes.push(`${line.name}: ${error.msg}`);
    }
    return [null, notes.length ? { notes } : {}];
  }

  return [{ code: 500, msg: `Unknown refund step ${step.id}` }, null];
};

/* Runs every step that is not done, in order, stopping at the first failure. */
const run = async ({ refundId, actor }) => {
  const [refund] = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.id, refundId));
  const [orderRow] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, refund.orderId));
  const order = await assemble(orderRow);
  const steps = refund.steps.map(step => ({ ...step }));

  for(const step of steps){
    if(step.status === 'done') continue;
    if(step.id.startsWith('tender:') && step.before === undefined){
      const [tender] = await db.select().from(kempoCommerceTender).where(eq(kempoCommerceTender.id, step.id.slice('tender:'.length)));
      step.before = tender.refundedAmount;
      await saveSteps(refundId, steps);
    }
    const [error, detail] = await perform({ step, refund, order, actor });
    if(error){
      step.status = 'failed';
      step.error = error.msg;
      await saveSteps(refundId, steps);
      return { failed: step, steps };
    }
    step.status = 'done';
    step.detail = detail;
    delete step.error;
    await saveSteps(refundId, steps);
  }
  return { failed: null, steps };
};

const finish = async ({ refundId, actor }) => {
  const outcome = await run({ refundId, actor });
  const [refund] = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.id, refundId));
  const [orderRow] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, refund.orderId));
  const config = await readConfig();
  const label = formatOrderNumber(orderRow.number, config);

  if(outcome.failed){
    await db.update(kempoCommerceRefund).set({ status: 'partial', updatedAt: new Date() }).where(eq(kempoCommerceRefund.id, refundId));
    await addEvent(db, orderRow.id, 'refund_partial', { actor, data: { refundId, failed: outcome.failed.id, error: outcome.failed.error } });
    const full = await assemble(orderRow);
    await notify(EVENTS.refundPartial, { order: full, refund, done: outcome.steps.filter(step => step.status === 'done'), failed: outcome.failed });
    await notifyAdmins({
      title: `A refund on order ${label} was only partly issued`,
      message: `"${outcome.failed.label}" failed: ${outcome.failed.error}. Open the order to finish or correct it.`,
      level: 'error', orderId: orderRow.id, dedupeKey: `refund-partial:${refundId}`,
    });
    return [{ code: 502, msg: `The refund was only partly issued. "${outcome.failed.label}" failed: ${outcome.failed.error}`, partial: true, refundId }, { refund: { ...refund, status: 'partial' } }];
  }

  const [done] = await db.update(kempoCommerceRefund).set({ status: 'issued', updatedAt: new Date() }).where(eq(kempoCommerceRefund.id, refundId)).returning();
  const fully = orderRow.refundedTotal >= orderRow.paidTotal;
  if(fully && orderRow.status !== 'refunded') await moveStatus(orderRow.id, 'refunded', { actor, reason: refund.reason });

  const [fresh] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderRow.id));
  const full = await assemble(fresh);
  await addEvent(db, orderRow.id, 'refund', { actor, visible: true, data: { refundId, amount: refund.amount, reason: refund.reason } });
  if(!fully) await sendOrderEmail(full, 'order-partial-refund', `Part of your order was refunded (${label})`, { refundAmount: displayMoney(refund.amount, full.currency), refundReason: escapeHtml(refund.reason) });
  await notify(EVENTS.refundIssued, { order: full, refund: done, actor });
  return [null, { refund: done, order: full }];
};

/*
  Issues a refund. `lines` is { orderLineId: quantity } or `amount` a whole amount (not both);
  `credits` is the administrator's choice when the customer already spent credits the refund takes
  back. Returns `[null, { refund, order }]`.
*/
export const refundOrder = async (orderId, { lines = null, amount = null, includeFees = false, destination = 'original', restock = null, credits = null, reason = '', actor = '' } = {}) => {
  try {
    if(credits !== null && !['zero', 'owe'].includes(credits)) return [{ code: 400, msg: 'credits is zero or owe' }, null];
    const [previewError, preview] = await previewRefund({ orderId, lines, amount, includeFees, destination, restock, actor });
    if(previewError) return [previewError, null];
    if(preview.blocked) return [{ code: 409, msg: preview.blocked, blocked: true, preview }, null];
    if(preview.credits?.shortfall > 0 && !['zero', 'owe'].includes(credits)){
      return [{ code: 409, msg: `${preview.credits.shortfall} of the credits this refund takes back have already been spent. Choose whether to leave the customer at zero or owing the rest.`, needsDecision: true, preview }, null];
    }
    const text = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';

    const refundId = newId('ref');
    const now = new Date();
    const reserved = await db.transaction(async tx => {
      const [order] = await tx.update(kempoCommerceOrder)
        .set({ refundedTotal: sql`${kempoCommerceOrder.refundedTotal} + ${preview.amount}`, updatedAt: now })
        .where(and(eq(kempoCommerceOrder.id, orderId), sql`${kempoCommerceOrder.refundedTotal} + ${preview.amount} <= ${kempoCommerceOrder.paidTotal}`))
        .returning();
      if(!order) return null;
      for(const [lineId, entry] of Object.entries(preview.lines)){
        if(lineId === 'fees') continue;
        const [line] = await tx.update(kempoCommerceOrderLine)
          .set({ refundedQuantity: sql`${kempoCommerceOrderLine.refundedQuantity} + ${entry.quantity}` })
          .where(and(eq(kempoCommerceOrderLine.id, lineId), sql`${kempoCommerceOrderLine.refundedQuantity} + ${entry.quantity} <= ${kempoCommerceOrderLine.quantity}`))
          .returning();
        if(!line) throw new Error('over-refunded');
      }
      const [row] = await tx.insert(kempoCommerceRefund).values({
        id: refundId, orderId, amount: preview.amount, lines: preview.lines, reason: text, tenders: preview.tenders,
        restock: Object.values(preview.lines).some(line => line.restock), credits: preview.credits?.wanted > 0 ? credits : null,
        destination, status: 'issuing', steps: planSteps(preview), issuedBy: actor || '', createdAt: now, updatedAt: now,
      }).returning();
      return row;
    }).catch(error => {
      if(error.message === 'over-refunded') return null;
      throw error;
    });
    if(!reserved) return [{ code: 409, msg: 'Another refund took the money first. Reload the order and look again.' }, null];

    await addEvent(db, orderId, 'refund_started', { actor, data: { refundId, amount: preview.amount } });
    return finish({ refundId, actor });
  } catch(error) {
    console.error('[kempo-commerce] refundOrder failed:', error);
    return [{ code: 500, msg: 'Failed to refund the order' }, null];
  }
};

/* Carries on a refund that was left partial, from the step that failed. */
export const finishRefund = async (refundId, { actor = '' } = {}) => {
  try {
    const [refund] = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.id, refundId));
    if(!refund) return [{ code: 404, msg: 'Refund not found' }, null];
    if(refund.status === 'issued') return [null, { refund, duplicate: true }];
    return finish({ refundId, actor });
  } catch(error) {
    return [{ code: 500, msg: 'Failed to finish the refund' }, null];
  }
};

export const getRefund = async refundId => {
  const [refund] = await db.select().from(kempoCommerceRefund).where(eq(kempoCommerceRefund.id, refundId));
  return refund ? [null, refund] : [{ code: 404, msg: 'Refund not found' }, null];
};
