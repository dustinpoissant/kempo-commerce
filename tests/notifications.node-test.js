import { and, eq } from 'drizzle-orm';
import { notification, notificationRecipient } from 'kempo/server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { declareAccess, makeProduct, makeUser, key, purge, signedIn } from './helpers/shop.js';
import { installFakeCard, restoreCard, succeed } from './helpers/fakeCard.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';
import { completeOrder } from '../server/utils/checkout/complete.js';
import { onPaymentDisputed } from '../server/utils/checkout/payments.js';
import { setOrderStatus } from '../server/utils/orders/status.js';
import { checkLimits } from '../server/utils/checkout/abuse.js';
import { kempoCommerceAttempt } from '../server/db/schema.js';
import { setSetting } from 'kempo/server/sdk.js';

/*
  What kempo-commerce tells people in the bell. A customer with an account hears how their order stands (one notification
  per order, refreshed as it moves); a guest has no account and hears nothing here. The shop's staff get a notice for a new
  order and, for what costs money if it is missed (a dispute), a banner that must be acknowledged.
*/

const OWNER = 'kempo-commerce';
const BILLING = { name: 'Ann Customer', email: 'ann-notices@example.test', line1: '1 Test St' };
const state = {};

const ok = ([error, value]) => {
  if(error) throw new Error(`unexpected error: ${error.code} ${error.msg}`);
  return value;
};

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const purgeAll = async () => {
  await db.delete(notification).where(eq(notification.owner, OWNER));
  await purge();
};

export const beforeAll = async () => {
  await seedDatabase();
  await purgeAll();
  await declareAccess();
  installFakeCard();
  state.customer = await makeUser(undefined, { email: BILLING.email });
  state.staff = (await signedIn('kempo-commerce:manager')).userId;
};

export const afterAll = async () => {
  restoreCard();
  await purgeAll();
};

const placed = async ({ userId = null, paid = true } = {}) => {
  const item = await makeProduct({ name: 'Mug', price: 1250, quantity: 4 });
  const { cart } = ok(await resolveCart(userId ? { userId } : {}));
  ok(await addToCart({ cartId: cart.id, productId: item.id, quantity: 1 }));
  const { order, payment } = ok(await placeOrder({ cartId: cart.id, userId, checkoutKey: key().slice(0, 30), billing: BILLING }));
  if(paid){
    await succeed(payment.id);
    ok(await completeOrder(order.id));
  }
  return { order, payment };
};

const told = userId => db.select({ title: notification.title, message: notification.message, type: notification.type, subtype: notification.subtype, mustAcknowledge: notification.mustAcknowledge, dedupeKey: notification.dedupeKey, actions: notification.actions })
  .from(notification)
  .innerJoin(notificationRecipient, eq(notificationRecipient.notificationId, notification.id))
  .where(and(eq(notificationRecipient.userId, userId), eq(notification.owner, OWNER)));

export default {
  'a customer with an account is told in their bell when their order is paid, linking to it': async ({ pass }) => {
    const { order } = await placed({ userId: state.customer });

    const mine = (await told(state.customer)).filter(row => row.dedupeKey === `order:${order.id}:status`);
    expect(mine.length === 1, `one notification for the order, got ${mine.length}`);
    expect(mine[0].type === 'notice' && ['info', 'success'].includes(mine[0].subtype), `${mine[0].type}/${mine[0].subtype}`);
    expect(mine[0].actions[0].href === `/commerce/account/orders/${order.id}/`, JSON.stringify(mine[0].actions));
    pass();
  },

  'it is refreshed as the order moves on, not added to': async ({ pass }) => {
    const { order } = await placed({ userId: state.customer });
    const before = (await told(state.customer)).filter(row => row.dedupeKey === `order:${order.id}:status`);
    ok(await setOrderStatus(order.id, 'completed', { actor: 'staff' }));

    const after = (await told(state.customer)).filter(row => row.dedupeKey === `order:${order.id}:status`);
    expect(after.length === 1, `still one notification, got ${after.length}`);
    expect(after[0].title.startsWith('Your order is complete') && after[0].subtype === 'success', `${after[0].title} / ${after[0].subtype} (was ${before[0].title})`);
    pass();
  },

  'a guest has no account, so nobody is told on their behalf': async ({ pass }) => {
    await db.delete(notification).where(and(eq(notification.owner, OWNER), eq(notification.type, 'notice')));
    const { order } = await placed({ userId: null });
    const rows = await db.select().from(notification).where(and(eq(notification.owner, OWNER), eq(notification.dedupeKey, `order:${order.id}:status`)));
    expect(rows.length === 0, 'no customer notification for a guest order');
    pass();
  },

  'the shop\'s staff get a notice for a new order': async ({ pass }) => {
    const { order } = await placed({ userId: state.customer });
    const rows = (await told(state.staff)).filter(row => row.dedupeKey === `order:${order.id}:new`);
    expect(rows.length === 1, `one notice for the new order, got ${rows.length}`);
    expect(rows[0].type === 'notice' && rows[0].subtype === 'success' && !rows[0].mustAcknowledge, `${rows[0].type}/${rows[0].subtype}/${rows[0].mustAcknowledge}`);
    pass();
  },

  'a dispute is a banner that must be acknowledged, because it costs money if missed': async ({ pass }) => {
    const { order, payment } = await placed({ userId: state.customer });
    await onPaymentDisputed({ owner: OWNER, reference: order.id, id: payment.id }, true, 'fraudulent');

    const rows = (await told(state.staff)).filter(row => row.dedupeKey === `dispute:${payment.id}:true`);
    expect(rows.length === 1, `one notification, got ${rows.length}`);
    expect(rows[0].type === 'banner' && rows[0].subtype === 'error' && rows[0].mustAcknowledge === true, `${rows[0].type}/${rows[0].subtype}/${rows[0].mustAcknowledge}`);
    expect(rows[0].actions[0].href.startsWith('/admin/extension/kempo-commerce/order/?id='), JSON.stringify(rows[0].actions));
    pass();
  },

  'a dispute that was closed is only a notice': async ({ pass }) => {
    const { order, payment } = await placed({ userId: state.customer });
    await onPaymentDisputed({ owner: OWNER, reference: order.id, id: payment.id }, false, null);

    const rows = (await told(state.staff)).filter(row => row.dedupeKey === `dispute:${payment.id}:false`);
    expect(rows.length === 1 && rows[0].type === 'notice' && rows[0].subtype === 'info', JSON.stringify(rows));
    pass();
  },

  'refused checkout attempts raise a warning for the staff at the first refusal': async ({ pass }) => {
    await db.delete(kempoCommerceAttempt);
    await db.delete(notification).where(eq(notification.owner, OWNER));
    await setSetting('kempo-commerce', 'purchase_limit_global', 1, 'number', false, null);
    try {
      expect(!(await checkLimits({}))[0], 'the first attempt is allowed');
      const [error] = await checkLimits({});
      expect(error?.code === 429, `the second is refused: ${JSON.stringify(error)}`);
    } finally {
      await setSetting('kempo-commerce', 'purchase_limit_global', 0, 'number', false, null);
    }

    const rows = (await told(state.staff)).filter(row => row.title === 'Checkout attempts are being refused');
    expect(rows.length === 1, `one warning for the first refusal, got ${rows.length}`);
    expect(rows[0].type === 'notice' && rows[0].subtype === 'warning', `${rows[0].type}/${rows[0].subtype}`);
    pass();
  },
};
