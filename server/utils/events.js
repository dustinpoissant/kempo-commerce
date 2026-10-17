/*
  Events this extension fires. Other extensions subscribe by declaring them in their own
  kempo-config.json `hooks`, e.g. { "kempo-commerce:order:paid": "./hooks/order-paid.js" }.

  **Guards** run before something happens, in kempo's bail mode. The payload carries a mutable
  `draft` (or a collection to add to); edit it in place to change what happens, and throw
  `{ code, msg }` to refuse, which reaches the caller exactly. **Notifications** run after the change
  is committed; a handler that throws is logged and stops nothing, and nothing a handler does can
  undo the change.

  Every payload carries `actor`: the extension that made the change through the SDK, or '' for a
  person. The totals hooks run in a fixed order (discounts, fees, tax), because handlers run in
  registration order and money arithmetic has to happen in a specific sequence.
*/
export const EVENTS = {
  cartBeforeAdd: 'kempo-commerce:cart:before_add',
  cartItemAdded: 'kempo-commerce:cart:item_added',
  cartBeforeUpdate: 'kempo-commerce:cart:before_update',
  cartItemUpdated: 'kempo-commerce:cart:item_updated',
  cartItemRemoved: 'kempo-commerce:cart:item_removed',
  cartCleared: 'kempo-commerce:cart:cleared',
  cartMerged: 'kempo-commerce:cart:merged',
  cartValidate: 'kempo-commerce:cart:validate',
  cartExpired: 'kempo-commerce:cart:expired',

  totalsDiscounts: 'kempo-commerce:totals:discounts',
  totalsFees: 'kempo-commerce:totals:fees',
  totalsTax: 'kempo-commerce:totals:tax',
  totalsComputed: 'kempo-commerce:totals:computed',

  checkoutFields: 'kempo-commerce:checkout:fields',
  checkoutValidate: 'kempo-commerce:checkout:validate',
  checkoutTenders: 'kempo-commerce:checkout:tenders',
  checkoutBeforePlace: 'kempo-commerce:checkout:before_place',
  checkoutAbandoned: 'kempo-commerce:checkout:abandoned',

  orderBeforeCreate: 'kempo-commerce:order:before_create',
  orderCreated: 'kempo-commerce:order:created',
  orderPaid: 'kempo-commerce:order:paid',
  orderLineFulfillment: 'kempo-commerce:order:line_fulfillment',
  orderFulfillmentChanged: 'kempo-commerce:order:fulfillment_changed',
  orderBeforeStatus: 'kempo-commerce:order:before_status',
  orderStatusChanged: 'kempo-commerce:order:status_changed',
  orderNoteAdded: 'kempo-commerce:order:note_added',
  orderEmailContext: 'kempo-commerce:order:email_context',
  orderFailed: 'kempo-commerce:order:failed',
  orderCancelled: 'kempo-commerce:order:cancelled',

  refundBeforeIssue: 'kempo-commerce:refund:before_issue',
  refundIssued: 'kempo-commerce:refund:issued',
  refundPartial: 'kempo-commerce:refund:partial',
};
