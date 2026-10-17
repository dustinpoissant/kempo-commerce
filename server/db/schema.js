import { pgTable, text, integer, boolean, timestamp, jsonb, bigserial, uniqueIndex, index } from 'drizzle-orm/pg-core';

/*
  Money is an integer in the currency's smallest unit, everywhere, always: there is no float in this
  file and nothing that reads from it should produce one. One currency per site, kempo-products'
  `currency` setting, copied onto a cart and an order so an order is never re-priced.

  Ids carry a prefix saying what they are (`cart_`, `ord_`, `ol_`, `tdr_`, ...), so one pasted into a
  support ticket or a log line can be read without looking it up.

  The indexes declared here are created by hand in install.js as well: kempo's installer makes
  columns and primary keys from a Drizzle schema and nothing else, and several of them are what make
  a retried request do each thing once. A static test checks the two lists agree.
*/

/*
  A cart. A visitor's is held by a random token in a cookie, stored hashed; a signed-in customer has
  one open cart with `userId` set. `status`: open | converted | abandoned | merged. `data` is for
  extensions.
*/
export const kempoCommerceCart = pgTable('kempoCommerceCart', {
  id: text('id').primaryKey(),
  token: text('token'),
  userId: text('userId'),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('open'),
  data: jsonb('data').notNull().default({}),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
  expiresAt: timestamp('expiresAt'),
}, table => [
  uniqueIndex('kempoCommerceCart_token_idx').on(table.token),
  index('kempoCommerceCart_user_idx').on(table.userId),
  index('kempoCommerceCart_status_idx').on(table.status, table.updatedAt),
]);

/*
  A line in a cart. `lineKey` is the product, its option selections and its extension data in a
  canonical form: the same key is the same line, so adding it again raises the quantity, and a gift
  message or an engraving makes a different line. `unitPrice` is what it cost when it was last priced,
  which is how a price change is noticed.
*/
export const kempoCommerceCartLine = pgTable('kempoCommerceCartLine', {
  id: text('id').primaryKey(),
  cartId: text('cartId').notNull(),
  productId: text('productId').notNull(),
  quantity: integer('quantity').notNull(),
  selections: jsonb('selections').notNull().default({}),
  data: jsonb('data').notNull().default({}),
  lineKey: text('lineKey').notNull(),
  unitPrice: integer('unitPrice'),
  addedAt: timestamp('addedAt').notNull(),
}, table => [
  uniqueIndex('kempoCommerceCartLine_key_idx').on(table.cartId, table.lineKey),
]);

/*
  An order. `userId` is null for a guest, who reaches it with `orderKey`. `shown` is exactly what the
  customer was shown before paying: it is what answers a dispute, and settings change.

  status: pending_payment | processing | completed | on_hold | cancelled | refunded | failed
*/
export const kempoCommerceOrder = pgTable('kempoCommerceOrder', {
  id: text('id').primaryKey(),
  number: integer('number').notNull(),
  userId: text('userId'),
  email: text('email').notNull(),
  orderKey: text('orderKey').notNull(),
  status: text('status').notNull(),
  currency: text('currency').notNull(),
  subtotal: integer('subtotal').notNull().default(0),
  feeTotal: integer('feeTotal').notNull().default(0),
  discountTotal: integer('discountTotal').notNull().default(0),
  taxTotal: integer('taxTotal').notNull().default(0),
  total: integer('total').notNull().default(0),
  paidTotal: integer('paidTotal').notNull().default(0),
  refundedTotal: integer('refundedTotal').notNull().default(0),
  pricesIncludeTax: boolean('pricesIncludeTax').notNull().default(false),
  billing: jsonb('billing').notNull().default({}),
  shown: jsonb('shown').notNull().default({}),
  data: jsonb('data').notNull().default({}),
  cartId: text('cartId'),
  checkoutKey: text('checkoutKey'),
  taxCalculationId: text('taxCalculationId'),
  taxTransactionId: text('taxTransactionId'),
  ip: text('ip'),
  placedAt: timestamp('placedAt').notNull(),
  paidAt: timestamp('paidAt'),
  completedAt: timestamp('completedAt'),
  cancelledAt: timestamp('cancelledAt'),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => [
  uniqueIndex('kempoCommerceOrder_number_idx').on(table.number),
  uniqueIndex('kempoCommerceOrder_key_idx').on(table.orderKey),
  uniqueIndex('kempoCommerceOrder_checkout_idx').on(table.checkoutKey),
  index('kempoCommerceOrder_user_idx').on(table.userId, table.placedAt),
  index('kempoCommerceOrder_email_idx').on(table.email),
  index('kempoCommerceOrder_status_idx').on(table.status, table.placedAt),
]);

/*
  A line as sold. `fulfillment`: none | pending | done. `creditsGranted` is what each unit gave, copied
  from the purchase so a later change to the product cannot change what a refund takes back.
*/
export const kempoCommerceOrderLine = pgTable('kempoCommerceOrderLine', {
  id: text('id').primaryKey(),
  orderId: text('orderId').notNull(),
  position: integer('position').notNull().default(0),
  productId: text('productId').notNull(),
  slug: text('slug').notNull().default(''),
  name: text('name').notNull(),
  selections: jsonb('selections').notNull().default({}),
  optionLines: jsonb('optionLines').notNull().default([]),
  unitPrice: integer('unitPrice').notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: integer('lineTotal').notNull(),
  tax: integer('tax').notNull().default(0),
  fulfillment: text('fulfillment').notNull().default('none'),
  refundedQuantity: integer('refundedQuantity').notNull().default(0),
  creditsGranted: integer('creditsGranted').notNull().default(0),
  creditsOnly: boolean('creditsOnly').notNull().default(false),
  data: jsonb('data').notNull().default({}),
}, table => [
  index('kempoCommerceOrderLine_order_idx').on(table.orderId),
]);

/*
  A fee, a tax or (from a later extension) a discount on an order, signed. `lineId` is null for the
  whole order. Commerce itself writes only tax; fees come from shipping and similar.
*/
export const kempoCommerceOrderAdjustment = pgTable('kempoCommerceOrderAdjustment', {
  id: text('id').primaryKey(),
  orderId: text('orderId').notNull(),
  lineId: text('lineId'),
  type: text('type').notNull(),
  code: text('code').notNull().default(''),
  label: text('label').notNull(),
  amount: integer('amount').notNull(),
  taxable: boolean('taxable').notNull().default(false),
  source: text('source').notNull().default(''),
  data: jsonb('data').notNull().default({}),
}, table => [
  index('kempoCommerceOrderAdjustment_order_idx').on(table.orderId),
]);

/*
  One way an order was (or is being) paid. Card, store credit and credits are all "a tender" with the
  same life: apply, maybe reverse before the order is finished, maybe refund after. `amount` is money
  in the order's currency (for credits, the money they cover); `detail` is the tender's own figures,
  such as how many credits that was.

  status: pending | applied | reversed | refunded
*/
export const kempoCommerceTender = pgTable('kempoCommerceTender', {
  id: text('id').primaryKey(),
  orderId: text('orderId').notNull(),
  kind: text('kind').notNull(),
  amount: integer('amount').notNull(),
  refundedAmount: integer('refundedAmount').notNull().default(0),
  status: text('status').notNull().default('pending'),
  reference: text('reference'),
  idempotencyKey: text('idempotencyKey').notNull(),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => [
  uniqueIndex('kempoCommerceTender_key_idx').on(table.idempotencyKey),
  index('kempoCommerceTender_order_idx').on(table.orderId),
]);

/*
  Everything that happened to an order, append-only. `actor` is a user id, an extension's name, or
  `customer`/`system`. Only events with `visible` set are shown to the customer.
*/
export const kempoCommerceEvent = pgTable('kempoCommerceEvent', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderId: text('orderId').notNull(),
  type: text('type').notNull(),
  actor: text('actor').notNull().default('system'),
  visible: boolean('visible').notNull().default(false),
  data: jsonb('data').notNull().default({}),
  createdAt: timestamp('createdAt').notNull(),
}, table => [
  index('kempoCommerceEvent_order_idx').on(table.orderId, table.id),
]);

export const kempoCommerceNote = pgTable('kempoCommerceNote', {
  id: text('id').primaryKey(),
  orderId: text('orderId').notNull(),
  authorId: text('authorId'),
  body: text('body').notNull(),
  visibleToCustomer: boolean('visibleToCustomer').notNull().default(false),
  createdAt: timestamp('createdAt').notNull(),
}, table => [
  index('kempoCommerceNote_order_idx').on(table.orderId),
]);

/*
  A refund that was issued. `lines` is { orderLineId: quantity }, `tenders` how each tender was paid
  back, `credits` the administrator's choice when the customer had already spent credits the refund
  takes back ('zero' | 'owe' | null). status: issued | partial. `steps` records what was done and what
  was not, so a refund left partial can be finished from where it stopped.
*/
export const kempoCommerceRefund = pgTable('kempoCommerceRefund', {
  id: text('id').primaryKey(),
  orderId: text('orderId').notNull(),
  amount: integer('amount').notNull(),
  lines: jsonb('lines').notNull().default({}),
  reason: text('reason').notNull().default(''),
  tenders: jsonb('tenders').notNull().default([]),
  restock: boolean('restock').notNull().default(false),
  credits: text('credits'),
  destination: text('destination').notNull().default('original'),
  status: text('status').notNull().default('issued'),
  steps: jsonb('steps').notNull().default([]),
  issuedBy: text('issuedBy').notNull().default(''),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => [
  index('kempoCommerceRefund_order_idx').on(table.orderId),
]);

/* The order number counter: one row, incremented under its own lock. */
export const kempoCommerceCounter = pgTable('kempoCommerceCounter', {
  id: text('id').primaryKey(),
  value: integer('value').notNull(),
});

/*
  A checkout attempt or a declined payment, kept for the rate limits and the decline cool-down and
  as the log of refused attempts. `kind`: attempt | decline | refused.
*/
export const kempoCommerceAttempt = pgTable('kempoCommerceAttempt', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  userId: text('userId'),
  ip: text('ip'),
  email: text('email'),
  reason: text('reason'),
  createdAt: timestamp('createdAt').notNull(),
}, table => [
  index('kempoCommerceAttempt_time_idx').on(table.createdAt),
  index('kempoCommerceAttempt_user_idx').on(table.userId, table.createdAt),
  index('kempoCommerceAttempt_ip_idx').on(table.ip, table.createdAt),
]);
