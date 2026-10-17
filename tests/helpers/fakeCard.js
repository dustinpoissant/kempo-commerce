import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { kempoPayment } from '../../node_modules/kempo-payments/server/db/schema.js';
import { registerTender, getTender } from '../../server/utils/checkout/tenders.js';
import { db } from './db.js';

/*
  A stand-in for the card tender, so the checkout can be driven end to end without a payment processor.

  It stands in for exactly one thing: contacting Stripe. Payments are still real rows in
  kempo-payments' own table, read back through its own SDK by the code under test, and a payment
  "succeeds" by the row changing the way the processor's webhook would change it. What really talks to
  Stripe is tested in stripe.node-test.js, which needs test-mode keys and says so when it has none.
*/

let original = null;

/* Flip to make the next card refunds fail, the way a processor refusing a refund would. */
export const behaviour = { refundsFail: false };

export const installFakeCard = () => {
  original ??= getTender('card');
  registerTender({
    kind: 'card',
    label: 'Card',
    priority: 1000,
    available: async ({ due }) => due > 0 ? { max: due, detail: {} } : null,
    apply: async ({ order, tender, userId }) => {
      const id = `pay_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date();
      await db.insert(kempoPayment).values({
        id, provider: 'fake', providerRef: `pi_${id}`, livemode: false, status: 'requires_payment_method', captureMethod: 'automatic',
        amount: tender.amount, currency: order.currency, owner: 'kempo-commerce', reference: order.id, userId: userId || null,
        customerEmail: order.email, createdAt: now, updatedAt: now,
      });
      return [null, { reference: id, detail: { clientSecret: 'cs_test_secret' }, pending: true }];
    },
    resume: async ({ tender }) => [null, { id: tender.reference, clientSecret: 'cs_test_secret' }],
    reverse: async ({ tender }) => {
      const [payment] = await db.select().from(kempoPayment).where(eq(kempoPayment.id, tender.reference));
      if(!payment) return [null, true];
      if(payment.status === 'succeeded') return [{ code: 409, msg: 'The card payment already went through' }, null];
      await db.update(kempoPayment).set({ status: 'canceled', updatedAt: new Date() }).where(eq(kempoPayment.id, payment.id));
      return [null, true];
    },
    refund: async ({ tender, amount }) => {
      if(behaviour.refundsFail) return [{ code: 502, msg: 'The processor refused the refund' }, null];
      const [payment] = await db.select().from(kempoPayment).where(eq(kempoPayment.id, tender.reference));
      await db.update(kempoPayment).set({ amountRefunded: payment.amountRefunded + amount, updatedAt: new Date() }).where(eq(kempoPayment.id, payment.id));
      return [null, { reference: `re_${crypto.randomBytes(6).toString('hex')}` }];
    },
  });
};

export const restoreCard = () => {
  if(original) registerTender(original);
  original = null;
};

/* The processor says the payment succeeded: the row changes the way its webhook would change it. */
export const succeed = async paymentId => {
  const [payment] = await db.select().from(kempoPayment).where(eq(kempoPayment.id, paymentId));
  await db.update(kempoPayment).set({ status: 'succeeded', amountCaptured: payment.amount, updatedAt: new Date() }).where(eq(kempoPayment.id, paymentId));
  return { ...payment, status: 'succeeded', amountCaptured: payment.amount };
};

export const paymentOf = async paymentId => (await db.select().from(kempoPayment).where(eq(kempoPayment.id, paymentId)))[0];
