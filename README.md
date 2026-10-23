# kempo-commerce

Carts, orders, checkout and refunds for [kempo](https://github.com/dustinpoissant/kempo). It sells what
[kempo-products](https://github.com/dustinpoissant/kempo-products) lists, takes payment through
[kempo-payments](https://github.com/dustinpoissant/kempo-payments), and uses
[kempo-tax](https://github.com/dustinpoissant/kempo-tax),
[kempo-store-credit](https://github.com/dustinpoissant/kempo-store-credit) and
[kempo-credits](https://github.com/dustinpoissant/kempo-credits) when they are installed. The model is
WooCommerce's core: where this document does not say otherwise, it does what WooCommerce does.

It is the store and nothing else: the catalogue (products, options, prices, quantity, categories, search),
discounts and coupons, shipping, subscriptions and reviews are other extensions, and this one is built
so they can plug in. [PLAN.md](./PLAN.md) is the design, and the decisions behind it.

## Contents

1. [Install](#install)
2. [What it does](#what-it-does)
3. [Orders and their statuses](#orders-and-their-statuses)
4. [Guests and accounts](#guests-and-accounts)
5. [Paying: tenders](#paying-tenders)
6. [Refunds](#refunds)
7. [Emails](#emails)
8. [Building on it: the SDK](#building-on-it-the-sdk)
9. [Hooks](#hooks)
10. [Components, pages and addresses](#components-pages-and-addresses)
11. [HTTP API](#http-api)
12. [Permissions and groups](#permissions-and-groups)
13. [Settings](#settings)
14. [Abuse protection and concurrency](#abuse-protection-and-concurrency)
15. [Admin](#admin)
16. [Development and tests](#development-and-tests)

## Install

```bash
npm install kempo-commerce
```

Install it from the admin's **Extensions** page. It needs **kempo-products** and **kempo-payments**
installed and enabled first, and a payment processor set up under Payments. kempo-tax, kempo-store-credit
and kempo-credits are optional and found when they are installed and enabled.

Set the **site address** under Commerce Settings, so the links in emails work. Existing sites need
`npx drizzle-kit push` to add kempo's `scheduledJob` table: the expiry sweep needs it, and without it
unpaid orders are only expired when something else notices them.

Needs a kempo with scheduled jobs, extension email templates, address aliases and the
`user:email_verified` hook, and a kempo-products with quantity holds.

## What it does

- A **cart** for visitors (a random token in a cookie, stored hashed) and for signed-in customers,
  which survives signing in. Every read prices it again from the catalogue and reports what is wrong
  (a price changed, less quantity than asked for, a product no longer for sale) instead of fixing it
  silently. Nothing is reserved by a cart.
- A **checkout**, for guests and signed-in customers, that prices on the server, adds tax, uses store
  credit and credits, takes a card payment for the rest and creates an **order**.
- **Orders** with a status, a history of everything that happened, notes, and fulfilment per line.
- **Order history** for customers, who can cancel an order that is not yet paid.
- **Refunds**, issued by an administrator, with a warning about credits the customer already spent.
- **Emails** and administrator notifications, a **mini-cart**, and the pages and components for all
  of it.

The browser names a product and a quantity and never an amount. Every price and total comes from the
server, every write is idempotent, and every step that takes something records how to give it back.

## Orders and their statuses

WooCommerce's seven statuses:

| Status | Means |
|---|---|
| `pending_payment` | The order exists, its quantity is held and credit spent, payment has not completed. Expires after `pending_expiry_minutes`, then becomes `failed` and everything is given back |
| `processing` | Paid, with something still to fulfil |
| `completed` | Paid and every line is fulfilled or needs nothing. A credit pack goes straight here |
| `on_hold` | Paused by an administrator or an extension |
| `cancelled` | Cancelled before it was paid |
| `refunded` | Refunded in full. A **partial refund keeps the status**, as in WooCommerce |
| `failed` | Payment failed or expired. Everything it took was given back |

Extensions cannot add statuses (every screen and hook listener depends on the list); they can keep their
own sub-state in `order.data`. A status changes only through the SDK, which checks the move, writes the
event and fires the hooks. An order's number is sequential (`#1042`; the prefix, padding and first
number are settings), and its id, not its number, is what addresses and keys use.

Each order keeps **what the customer was shown** (`shown`: lines, prices, tax, total, the refund policy
text) because that answers a dispute and settings change.

## Guests and accounts

Guest checkout is **on by default**, as in WooCommerce. A guest is not a kempo user: the cart is a cookie,
the order holds the email and an `orderKey`, and the guest reaches their order at
`/commerce/order/<id>/received/?key=<orderKey>` (also emailed). A wrong key looks exactly like no
order.

The checkout can **create an account** for a guest, which is **required when the cart has credits for
sale** (a guest cannot be given credits): it is made with a password nobody knows and the customer gets
a link to set their own. A guest's earlier orders become theirs when their email is **verified**, never
on a typed address alone. Guests pay by card only: store credit and credits belong to an account.

## Paying: tenders

A **tender** is a way an order is paid. Credits, store credit and the card are all the same thing with
the same life (apply, reverse before the order is finished, refund after), so a failed payment's cleanup
and a refund are one loop each, and a gift card or wallet extension is a new kind of tender, not a change
here.

```javascript
import { registerTender } from 'kempo-commerce/sdk';

registerTender({
  kind: 'gift-card',
  label: 'Gift card',
  priority: 30,                                               // credits 10, store credit 20, card 1000
  available: async ({ userId, cart, due, currency }) => ({ max: 5000, detail: {} }),   // or null
  apply: async ({ order, tender, userId }) => [null, { reference }],
  reverse: async ({ order, tender, userId }) => [null, true],
  refund: async ({ order, tender, amount, refundId, userId }) => [null, { reference }],
});
```

Tenders are applied in `priority` order against what is still due and the card takes the rest. A
specific amount the customer chose that is no longer available (their balance moved) is refused with a
409 so they can look again, instead of quietly being charged a different mix.

**Placing an order** (`placeOrder`, idempotent on a `checkoutKey`) checks the limits, prices again and
refuses if the total is not the one the customer saw, creates the account if one was asked for, **takes
the quantity** (an entry in kempo-products' ledger, `order:<id>`; if there is not enough, no order exists at all), creates the
order, applies credits then store credit, and creates the card payment for the rest. A failure at any step
undoes the earlier ones in reverse and fails the order. When nothing is left for a card, the order is
complete straight away: **this works with no payment processor configured**, which is how a store
owner tests a checkout (give yourself store credit and buy something).

**Completing** happens from the processor's signed webhook (`payment:succeeded`), never the browser's
word; the browser asks the server to check, and the server asks the processor. It claims the order as paid
(only one run can, and not an order that already failed or was cancelled and had its quantity returned), grants any credits
the products give (once, under a key made from the order), marks tenders applied, records
the tax, decides each line's fulfilment, moves the status and fires `order:paid`. It is safe to run any
number of times at once. A payment that arrives after the order expired is **refunded in full
automatically** and the shop is told.

A customer who starts a new checkout from the same cart replaces their earlier unpaid one. There is no
advisory locking: every race is settled by conditional updates (the cart is claimed while an order is
placed, a status changes only from the status that was read, a refund can only take what is left).

## Refunds

Refunds are **issued by an administrator** from the order's page, as in WooCommerce core; there is no
refund request for a customer to file (one can be built as an extension on the `refund:*` hooks).

- By **lines and quantities** or by **amount**, never more than was paid and not yet returned. A line's
  share is exact: the last unit takes the rounding.
- Money goes back **tender by tender**, in proportion to what each still holds: card money to the card,
  store credit to store credit, credits as credits. An administrator can send the card part to **store
  credit** instead (accounts only).
- **Spent credits are never refunded as money.** If the products gave credits and the customer has
  already spent some, the screen says how many, links to their credits history, and makes the
  administrator choose: take what they hold and leave them at **zero**, or take all of it and leave them
  **owing** the rest. The choice is recorded on the refund and the order's history.
- **Restock** per refund (default from `restock_on_refund`). Refunding the whole order and restocking all
  of it adds one ledger entry that undoes the order's, which also returns materials to kempo-inventory.
- Tax is reversed in proportion.
- If a step fails after an earlier one succeeded the refund is left **partial** with exactly what was
  done and what was not, administrators are notified, and **Try the rest** carries on from there. It is
  never silently half-applied.

A refund made in the processor's own dashboard, or a chargeback, is recorded on the order and flagged;
nothing is changed automatically.

## Emails

Commerce supplies templates and data; **kempo logs and sends them** (`sendEmailFromTemplate`: kempo
keeps a log of every email, and an email extension such as kempo-resend or kempo-smtp sends it). WooCommerce's set: processing (received and paid), completed, on hold, failed,
cancelled, refunded, part refunded, a customer note, and the link to set a password for an account made
at checkout. A site rewords any of them with `templates/emails/kempo-commerce/<name>.page.html`, and they
use the site's email layout. Other extensions add to a template's data through
`kempo-commerce:order:email_context`. A failed send is recorded on the order and never fails it.
Administrators get kempo **notifications** (new order, refund left partial, a payment for an expired order,
a flood of refused checkouts), not email.

**Editing.** The **Emails** tab of Commerce Settings (`/admin/extension/kempo-commerce/settings/`) lists every template, including the packing slip. **Edit** opens one in a code editor; saving writes the site's copy to `templates/emails/kempo-commerce/` (used from the next email, kept through updates) and **Reset to default** removes it. **Preview** opens a template as it would be sent, in one tab that each preview replaces, using your most recent order (or a made-up one when there are none) and sample wording for a note, a refund and a password link; it shows the saved template, not what is being typed. `GET /commerce/api/emails/preview?template=` (`commerce:settings:manage`). The editor is kempo's `<k-email-templates owner="kempo-commerce" preview-url="/commerce/api/emails/preview">`.

**Styling.** Kempo runs every email template through `kempo-css/shake`, which keeps only the kempo-css rules the template uses and embeds them in the email, so the templates are written with kempo-css elements and classes (`<table>`, `<a class="btn primary">`, `.ta-center`, `.ta-right`, `.tc-muted`) and no inline styles. Do the same in a template you override or add.

**Packing slip.** The **Packing slip** button on the admin order page opens a page to print: the shop name, order number and date, where it is going, and the items to pack with their quantities and options (no prices, so it can go in a gift). It is an email template, `emails/packing-slip.page.html`, drawn by kempo's email engine and returned as HTML instead of being sent, so it is changed like any email: put your own at `templates/emails/kempo-commerce/packing-slip.page.html`, and it uses the site's email layout. It is drawn from the order each time (nothing is stored), so it always has the address as it is now. Its data is the email data plus `placedDate`, `shipTo` (lines of the address), `hasShipTo`, `packItems` (`name`, `options`, `hasOptions`, `quantity`) and `itemCount`; other extensions add to it through `kempo-commerce:order:email_context`, which gets `template: 'packing-slip'`. `GET /commerce/api/orders/:id/packing-slip` (`commerce:orders:view`).

**Emailing a customer.** **Email the customer** on the Customer tab opens a dialog with a subject and a message, sent in the `order-note` template. A sent email is a private line in the order's history ("Emailed the customer: subject", with who sent it); one that could not be sent is recorded as "Email not sent" with the reason.

## Building on it: the SDK

```javascript
import { getCart, addToCart, placeOrder, getOrder, setLineFulfillment, refundOrder, registerTender } from 'kempo-commerce/sdk';
```

Every function returns `[error, data]`, none throws, and none checks permissions: the routes decide who
may do what. Anything that changes an order takes an optional `{ actor }` (your extension's name), which
is written to the order's history.

| Function | Purpose |
|---|---|
| `resolveCart({ token, userId })`, `getCart({ cartId })` | Find or make the cart, and read it priced with its notices and totals |
| `addToCart`, `updateCartLine`, `removeCartLine`, `clearCart`, `mergeCarts`, `setCartData`, `listCarts` | Change a cart |
| `computeTotals`, `collectAdjustments` | The one totals function (the cart, the mini-cart, checkout and the order all use it) |
| `startCheckout({ cartId, userId, billing, tenders })` | The quote: totals, ways to pay and the split, fields, account rules |
| `placeOrder({ cartId, userId, checkoutKey, billing, data, tenders, account, expectedTotal, ip })` | Place the order (idempotent) |
| `completeOrder(id)`, `markPaid(id, { actor, note })` | Finish a paid order; record money taken another way |
| `failOrder(id, reason)`, `cancelUnpaidOrder(id, { actor })` | Undo an unpaid order |
| `getOrder(idOrNumber)`, `getOrderByKey(id, key)`, `listOrders({ userId, status, search, from, to })`, `forCustomer(order)` | Read orders |
| `setOrderStatus(id, status, { actor, note })` | Pause, resume, processing, completed |
| `setLineFulfillment(id, lineId, 'pending' \| 'done', { actor, data })` | What shipping and delivery call; the order completes when no line waits |
| `addOrderNote`, `getOrderEvents`, `linkGuestOrders`, `sendOrderEmail` | Notes, history, guest linking, mail |
| `previewRefund`, `refundOrder`, `finishRefund`, `getRefund` | Refunds |
| `registerTender`, `unregisterTender`, `listTenders`, `getTender` | Ways to pay |
| `readConfig`, `runSweep`, `EVENTS`, `orderStatuses` | Settings, the recovery sweep, the hook names, the statuses |

### What shipping (and similar) needs

| To... | Use |
|---|---|
| Collect a delivery address | `checkout:fields` and `checkout:validate`; kept in `order.data` |
| Offer methods and add the cost | `totals:fees`: a fee adjustment with `source` and `taxable` |
| Say which lines need sending | `order:line_fulfillment` |
| Mark things sent | `setLineFulfillment(order, line, 'done', { data: { shipmentId } })`, one call per shipment |
| Show tracking | the `commerce-account-order-panels` fragment (customer) and a tab on the admin order page (staff, see below) |
| Change a part of an order later | `setOrderData(orderId, key, value, { actor, summary })`: changes only `order.data[key]` and writes a private history entry |
| Add a line to the history | `addOrderEvent(orderId, type, { actor, visible, data: { summary } })` |
| React to a refund | `refund:issued`, and `refund:before_issue` to warn that it already shipped |

Nothing here stores a carrier, a tracking number or a rate.

### Tabs on the admin order page

The admin order page is a set of tabs: **Items**, **Payment**, the tabs other extensions add (kempo-shipping's **Shipping** comes next), **Customer** (billing details, and a form to email the customer) and **History**. An extension adds a tab by putting a `k-commerce-order-tab` in the `commerce-admin-order-tabs` location (and loading its component from `commerce-admin-order-scripts`, outside any template):

```html
<k-commerce-order-tab name="shipping" label="Shipping" position="300"><k-shipping-order></k-shipping-order></k-commerce-order-tab>
```

`position` sorts the tabs (Items 100, Payment 200, Customer 400, extensions 600 unless set, History 1000). The tab's component loads the order itself with `getOrder` from the `id` in the page address.

## Discounts

Commerce creates no discounts; extensions (kempo-discounts, kempo-coupons) push them through `totals:discounts`, and commerce
combines them so every extension follows one rule. A discount says what it is, `{ kind, value, stackable }`, with the line it is on:

- the ones that can be combined (`stackable`) all apply together: every **fixed** amount comes off the unit price first, then the **percents are added up** and taken off what is left (a $50 car with $10 off, then 25% and 10%, is $26);
- one that cannot be combined applies alone, and the line gets whichever saves more, that or the combination;
- the unit price never goes below the product's **minimum price** (kempo-products' `minimumPrice`), or zero without one; percents round down, and the rows add up to the whole;
- when the minimum price held a discount back, its rows carry `data.limited` and the cart shows the `price_floor_notice` setting.

The cart shows one row per kind of discount, adding up the lines. A discount stays against its line on the order, so tax is worked out on what the customer pays, and **a refund of a line returns what was paid for it**, not its full price. `resolveUnitDiscounts` and `resolveDiscountRows` are exported for an extension that wants the same answer for a storefront price.

## Hooks

Fired through kempo's `triggerHook`, named `kempo-commerce:<resource>:<event>`. **Guards** run before something
happens and may change the payload's `draft` or add to a collection; they refuse by throwing
`{ code, msg }`, which reaches the caller exactly. **Notes** run after the change is committed; a handler
that throws is logged and stops nothing. The totals hooks run in a fixed order (discounts, fees, tax).
Every payload carries `actor`: the extension that made the change, or `''` for a person.

| Event | Kind | Payload | Lets you |
|---|---|---|---|
| `kempo-commerce:cart:before_add` | guard | `{ cart, draft: { productId, quantity, selections, data }, userId, actor }` | change or refuse an add (a minimum, "one per customer", an age-gated product) |
| `kempo-commerce:cart:item_added` | note | `{ cart, line, actor }` | react |
| `kempo-commerce:cart:before_update` | guard | `{ cart, line, changes, actor }` | refuse or clamp a quantity change |
| `kempo-commerce:cart:item_updated` | note | `{ cart, line, previous, actor }` |  |
| `kempo-commerce:cart:item_removed` | note | `{ cart, line, actor }` |  |
| `kempo-commerce:cart:cleared` | note | `{ cart, actor }` |  |
| `kempo-commerce:cart:merged` | note | `{ from, into, userId }` | carry over your own cart data |
| `kempo-commerce:cart:validate` | guard | `{ cart, notices }` | **add notices** (set `blocking`) for a regional restriction or a mixed-cart rule |
| `kempo-commerce:cart:expired` | note | `{ cart }` | abandoned-cart emails |
| `kempo-commerce:totals:discounts` | note | `{ cart or order, lines, adjustments, currency }` | push `{ type: 'discount', code, label, lineId, taxable?, source, data: { kind: 'fixed' | 'percent', value, stackable } }` and **leave out `amount`**: commerce works out every row's amount per line, together (see Discounts). A row that already has an `amount` and no `kind` is used as it is |
| `kempo-commerce:totals:fees` | note | same, plus `checkout` (`{ billing, data }`) at checkout only | push `{ type: 'fee', ... }`: **shipping lands here**. Read `checkout.data` for what the customer entered; the cart and mini-cart do not get `checkout` |
| `kempo-commerce:totals:tax` | note | `{ cart or order, taxable, address, tax }` | replace `tax` (kempo-tax has already filled it in) |
| `kempo-commerce:totals:computed` | note | `{ cart or order, totals }` | read the result |
| `kempo-commerce:checkout:fields` | guard | `{ cart, fields }` | **add fields to the checkout form** (a delivery address, a gift message, a VAT number): `{ key, label, type, required, hint }` |
| `kempo-commerce:checkout:validate` | guard | `{ cart, billing, data, errors }` | push `{ field, msg }` to `errors`, or throw `{ code, msg }` |
| `kempo-commerce:checkout:tenders` | guard | `{ cart, userId, tenders, due }` | offer, limit or remove ways to pay |
| `kempo-commerce:checkout:before_place` | guard | `{ cart, draft }` | last chance to refuse or change the order draft (`draft.data`, `draft.plan`) |
| `kempo-commerce:checkout:abandoned` | note | `{ cart, order? }` | reserved |
| `kempo-commerce:order:before_create` | guard | `{ draft }` | reserved |
| `kempo-commerce:order:created` | note | `{ order, actor }` |  |
| `kempo-commerce:order:paid` | note | `{ order, tenders, actor }` | **the moment to do the work**: fulfil, license, grant |
| `kempo-commerce:order:line_fulfillment` | guard | `{ order, line, fulfillment: { value, data } }` | decide whether a line needs fulfilling: set `fulfillment.value` to `none`, `pending` or `done` |
| `kempo-commerce:order:fulfillment_changed` | note | `{ order, line, previous, actor }` |  |
| `kempo-commerce:order:before_status` | guard | `{ order, from, to, actor }` | refuse a transition |
| `kempo-commerce:order:status_changed` | note | `{ order, from, to, actor }` | everything else |
| `kempo-commerce:order:note_added` | note | `{ order, note }` |  |
| `kempo-commerce:order:email_context` | guard | `{ order, template, context }` | add to or alter the data of a customer email (a tracking number, a download link) |
| `kempo-commerce:order:failed` | note | `{ order, reason }` |  |
| `kempo-commerce:order:cancelled` | note | `{ order, actor, reason }` |  |
| `kempo-commerce:refund:before_issue` | guard | `{ order, refund, preview }` | **add warnings** (`preview.warnings.push(text)`) or **block** (throw `{ code, msg }`) a refund: a fraud signal, a parcel already shipped. Runs for the preview too |
| `kempo-commerce:refund:issued` | note | `{ order, refund, actor }` | **put things back**: licences, shipments, entitlements |
| `kempo-commerce:refund:partial` | note | `{ order, refund, done, failed }` | alert: a refund was only partly issued |

Hooks this extension listens to: `payment:succeeded`, `payment:failed`, `payment:canceled`,
`payment:refunded` and `payment:disputed` (kempo-payments) and `user:email_verified` (kempo).

## Components, pages and addresses

| Element | Module | |
|---|---|---|
| `<k-commerce-add-to-cart>` | `/commerce/components/AddToCart.js` | Quantity and the button; registered with kempo-products so every product card and page shows one. Disables with the reason |
| `<k-commerce-cart-button>` | `CartButton.js` | The cart icon with a count, for the inside of a link to the cart page (`<a href="/cart/">`). A plain click opens the mini-cart; Ctrl, Cmd and middle clicks, and a page with no mini-cart, follow the link. On its own it draws its own link |
| `<k-commerce-mini-cart>` | `MiniCart.js` | A `k-aside` cart; `open()`, `close()`, `toggle()`, `refresh()`; slots `before-lines`, `after-lines`, `footer`; fires `mini-cart-opened` and `mini-cart-closed` |
| `<k-commerce-cart-qty>`, `<k-commerce-add-qty>` | `CartQty.js`, `AddQty.js` | The quantity pickers: one bordered control with a "-" button, a number you can type into (so 100 is not 99 clicks) and a "+" button, a whole number from 1 with no maximum, firing `change` (`detail.value`). In the cart the "-" turns into the remove-from-cart icon at 1 and fires `qty-remove` (typing 0 does too); the add-to-cart one just disables it at 1 |
| `<k-commerce-cart>` | `Cart.js` | The cart page's body; slots `before` and `after` |
| `<k-commerce-checkout>` | `Checkout.js` | The checkout page. **Light DOM**, because Stripe's fields do not mount inside a shadow root |
| `<k-commerce-orders>`, `<k-commerce-order>` | `Orders.js`, `Order.js` | Order history, and one order (`received` waits for the payment to be confirmed) |

Events (bubbling, composed): `cart-changed`, `cart-line-added`, `mini-cart-opened`, `mini-cart-closed`. Methods
cause actions; events only say something happened. The browser client is `/commerce/sdk.js`.

**The cart button is a menu item.** On kempo's **Menus** page (Admin → Content → Menus), click **Add item** on the
place that is your navigation and choose **Cart** under kempo-commerce. It is placed, ordered, hidden and removed
like any other link, and it leaves the site if this extension is disabled. It is a real link, `<a href="/cart/"><k-commerce-cart-button></k-commerce-cart-button></a>`,
so a nav styles it exactly like its other links (padding, theme link colour, hover) and it goes to the cart page
even before any script has loaded. A site with no menu places that link itself.

By default (`mini_cart_inject`) a script on every public page puts the mini-cart on the page. A site that wants to
place the mini-cart itself turns that off and uses the element.

**"Add to cart" on products** is injected into kempo-products' product cards and product page by
`public/product-actions.global.html`, which fills that extension's `products-card-actions` and `products-detail-actions`
locations with `<k-commerce-add-to-cart>` and loads its script (`products-scripts`) on those pages only. The element
finds its card with `closest('k-products-card')` or its page with `closest('k-products-detail')`. A page of your own that
embeds a `<k-products-list>` includes `<fragment name="products-card-template" />` once to get the button on its cards.

| Page | Address | Short address |
|---|---|---|
| Cart | `/commerce/cart/` | `/cart/` |
| Checkout | `/commerce/checkout/` | `/checkout/` |
| Order received | `/commerce/order/<id>/received/` | |
| Order history | `/commerce/account/orders/` | `/account/orders/` |
| One order | `/commerce/account/orders/<id>/` | `/account/orders/<id>/` |

The short addresses are kempo `aliases`: a page the site has of its own at that address always wins.
Fragments other extensions can fill: `commerce-cart-before`, `commerce-cart-after`,
`commerce-order-received-extra`, `commerce-account-order-panels`, `commerce-account-order-actions`,
`commerce-admin-order-panels` (under the Items tab), `commerce-admin-order-actions`, `commerce-admin-order-tabs` and `commerce-admin-order-scripts`.

## HTTP API

Under `/commerce/api`. `/my/` routes use the session only.

| Route | Who |
|---|---|
| `GET /cart`, `POST /cart/lines`, `PATCH /cart/lines/:id`, `DELETE /cart/lines/:id`, `DELETE /cart` | anyone (the cart cookie) |
| `GET /config` | anyone: what a page needs to render |
| `GET /checkout`, `POST /checkout/validate`, `POST /checkout/place` | anyone with a cart (`commerce:checkout` when signed in). `GET /checkout` also returns `prefill` for a signed-in customer: the name and email of the account, and the phone and address of their last order, which the checkout form starts with |
| `POST /checkout/orders/:id/confirm` | the order's owner, or a guest with its key: asks the processor |
| `GET /my/orders`, `GET /my/orders/:id`, `POST /my/orders/:id/cancel` | signed in, their own |
| `GET /orders/:id/guest?key=`, `POST /orders/:id/guest/cancel` | a guest with the key |
| `GET /orders`, `GET /orders/:id`, `GET /orders/:id/events`, `GET /orders/:id/packing-slip` (a page to print), `GET /carts`, `GET /summary` | `commerce:orders:view` |
| `POST /orders/:id/contact` (`{ subject, body }`: emails the customer and notes it in the history), `PATCH /orders/:id/status`, `POST /orders/:id/notes`, `PATCH /orders/:id/lines/:lineId`, `POST /orders/:id/cancel`, `POST /orders/:id/mark-paid` | `commerce:orders:manage` |
| `POST /refunds/preview`, `POST /orders/:id/refund`, `POST /refunds/:id/finish` | `commerce:refunds:issue` (and `payments:refund` for card money) |
| `GET /settings`, `PUT /settings` | `commerce:settings:manage` |

There is **no route that spends store credit or credits**: checkout does, on the server, inside `placeOrder`.

## Permissions and groups

| Permission | Lets you |
|---|---|
| `commerce:orders:view` | See orders, their history, and open and abandoned carts |
| `commerce:orders:manage` | Change an order's status, add notes, mark lines fulfilled and cancel orders |
| `commerce:refunds:issue` | Refund orders. Returning card money also needs payments:refund |
| `commerce:settings:manage` | Change the commerce settings |
| `commerce:checkout` | Check out while signed in. Held by every user from the first install, so a site can narrow it |

Groups: `kempo-commerce:support` (see orders and carts), `kempo-commerce:manager` (also manage orders and
refund) and `kempo-commerce:administrator` (everything). `commerce:checkout` is given to `system:Users` on
the first install only, so a site can narrow it and a reinstall will not hand it back. A guest is not a
user and needs no permission; `guest_checkout` governs guests.

## Settings

| Setting | Default | |
|---|---|---|
| `site_url` | `http://localhost:3000` | The address of this site, used for the links in emails, such as http://localhost:3000 |
| `guest_checkout` | `true` | Allow people to check out without an account. A cart with credits for sale in it always needs one |
| `allow_account_creation` | `true` | Offer to create an account on the checkout form. Always offered, and required, when the cart has credits for sale in it |
| `cart_expiry_days` | `30` | Days without a change before an open cart counts as abandoned |
| `cart_purge_days` | `90` | Days after a cart was abandoned before it is deleted |
| `max_lines_per_cart` | `100` | The most different lines one cart can have |
| `max_quantity_per_line` | `99` | The most of one product a customer can put on one line |
| `pending_expiry_minutes` | `60` | How long an order waiting for its payment holds its quantity and any credit spent on it, before it fails and everything is given back |
| `order_number_prefix` | `#` | Shown before every order number, such as # or INV- |
| `order_number_padding` | `0` | Pad order numbers with zeros to at least this many digits. 0 does not pad |
| `order_number_start` | `1000` | The number of the first order. Changing it later only affects orders placed after |
| `order_number_random` | `false` | Give each order a random 8-digit number instead of 1001, 1002 and so on, so nobody can tell how many orders the shop has had or guess another order's number. The prefix still applies; the padding and first number do not |
| `restock_on_refund` | `true` | Whether refunded products go back into quantity by default. It can be changed for each refund |
| `refund_policy` | `(blank)` | Shown to the customer at checkout, and kept with the order as what they agreed to |
| `mini_cart_side` | `right` | Which side of the page the mini-cart opens from: left or right |
| `mini_cart_open_on_add` | `false` | Open the mini-cart when something is added to the cart. Off by default: the "Added to your cart" toast confirms an add, and the cart is one click away |
| `mini_cart_inject` | `true` | Put the mini-cart on every public page. Turn off to place <k-commerce-mini-cart> yourself. The cart button is not placed for you: add the **Cart** item to a menu |
| `price_floor_notice` | A discount on this order was limited by the minimum price of a product. | Shown in the cart under the totals when a product's minimum price (kempo-products) held a discount back |
| `add_to_cart_toast_action` | `mini-cart` | The **View cart** button on the confirmation shown after adding to the cart: `mini-cart` opens the mini-cart (the cart page when the page has none), `cart-page` goes to the cart page, `none` shows no button |
| `mini_cart_hide_on_cart_pages` | `true` | Do not show the mini-cart on the cart page itself, which shows the same thing. It stays available on the checkout page, so an item can be changed or added without leaving |
| `purchase_limit_per_user` | `10` | Checkout attempts one account can make in an hour. 0 turns the limit off |
| `purchase_limit_per_ip` | `20` | Checkout attempts one address can make in an hour. 0 turns the limit off |
| `purchase_limit_global` | `500` | Checkout attempts the whole site accepts in an hour. 0 turns the limit off |
| `failed_payment_limit` | `3` | Declined payments from one account or address, within the cool-down, before further attempts are refused. 0 turns it off |
| `failed_payment_cooldown_minutes` | `60` | How long declines are counted for, and how long attempts are refused once the limit is reached |
| `trust_proxy` | `false` | Take the visitor's address from X-Forwarded-For. Turn on only when the site is behind a proxy you run: with none, the header is whatever the visitor sent |

## Abuse protection and concurrency

Selling cheap things to strangers invites card testing, and guest checkout removes "signed-in buyers only" as a
defence, so: **rate limits** per account, per address and site-wide per hour; a **decline cool-down**
(after N declines from one account or address, further attempts are refused until it passes, and the payment
that hit the limit is cancelled at the processor); a log of every refused attempt and a notification
as the hour's count reaches 1, 10, 100. `trust_proxy` takes the address from `X-Forwarded-For`, only behind a
proxy you run. Declines are counted from `payment:failed`.

Placing an order, completing it, refunding it and every status change are conditional updates, so two
tabs, a redelivered webhook, the sweep and an administrator can all act at once and each thing happens
once. A recovery sweep runs every minute (kempo's scheduler): it fails unpaid orders that ran out of time
(asking the processor first), finishes paid ones that never completed, records tax that was missed,
abandons and eventually deletes old carts, and releases expired holds.

## Admin

Under **Commerce** in the admin: **Orders** (search by number, name or email; filter by status and date),
the **order** page (everything and everything that happened; mark lines sent, notes private or shown to the
customer, pause, cancel, record a payment taken another way, refund), the **refund** page, **Carts** (open
and abandoned, read-only), and **Commerce Settings**, last in the Commerce group. A dashboard widget shows orders and
revenue today and this week.

## The checkout page, and adding to it

One page and one button. Down the left is an accordion, one panel open at a time: **Contact** (name, email, an account when one is wanted, and the extra fields extensions ask for), **Billing address** (country, address, and the tax it sets), **Store credit and credits** (when the customer has either), and **Payment** (the card for whatever is left, shown only when something is left to pay). On the right: the order, the refund policy, anything an extension puts under the summary, and **Place order**. Pressing it makes the order, makes the card payment and charges the card in the same step; a declined card leaves the order saved and the form in front of the customer to try again. The card fields are `<k-pay-form deferred>` from kempo-payments (needs `kempo-payments >=0.3.0`).

Another extension (a shipping address, a coupon box, a sales banner) adds to the page with `registerCheckoutSection`:

```javascript
import { registerCheckoutSection } from '/commerce/components/checkoutSections.js';

const TAG = 'k-shipping-address';
customElements.define(TAG, ShippingAddress);
registerCheckoutSection(TAG, { title: 'Shipping address', priority: 300 });
```

| Option | Meaning |
|---|---|
| `title` | The panel's heading. Required for a panel |
| `priority` | Where the panel goes, highest first. Contact is 500, billing 400, credits 200 and payment 100, so 300 lands between billing and credits |
| `id` | Names the panel, default the tag. `contact`, `billing`, `credits` and `payment` are reserved |
| `where` | `panel` (default) for an accordion panel, or `summary` for an element under the order summary, above the button |

The element is handed `checkout`, the page: `checkout.quote` (the server's cart, totals, tenders and plan),
`checkout.form` (the contact and billing so far), `checkout.reprice()` (ask the server for the totals again,
after something changed that they depend on), and `checkout.setData(key, value)` (a value sent with the
order as `data`, which the `checkout:validate` guard receives). What a section does to the price goes
through the cart's adjustments on the server, not through the browser.

**Country and state** are pickers, filled from `server/data/regions.json` (ISO 3166-1 countries and the first level of ISO 3166-2, from the MIT-licensed [iso3166-2-db](https://www.npmjs.com/package/iso3166-2-db)). To rebuild it: `npm pack iso3166-2-db`, unpack `i18n/en.json`, and run `node scripts/build-regions.js path/to/en.json`. The state is stored as its code (`VT`); a country with no states listed takes free text. `GET /commerce/api/regions` serves the lists, and the server refuses a country or state that is not on them.

**What tax asks of the address.** With kempo-tax on, the country is required, plus a state or province for the United States and Canada and a postal code for the United States (`needsFor` in `server/utils/checkout/tax.js`: add a country there when its tax turns out to depend on more). The page marks those required, the tax is not asked for until they are filled in, and **Place order** stays disabled until every required field, and the card, is complete.

**The account page.** The customer's **Order history** (`/account/orders/`, with each order a click away) is linked from their account page. That works because the account page has two places an extension can add to, `account-details` (lines such as a balance) and `account-links` (buttons), which kempo's starter account page has and any site's copy of it can be given with `<location name="account-links" />`.

**Leaving the checkout** is never blocked: there is a **Back to cart** button, the whole site navigation stays, and the side cart opens there so an item can be changed or added without leaving (the checkout follows it).

## Where an extension goes in the admin menu

The menu is ordered by each entry's `priority` (higher first), and a group sits where its first entry does, so
the four commerce groups are bands of priority numbers. An extension joins a group by naming it and picks a
number in its band:

| Group | Priorities | In order |
|---|---|---|
| Commerce | 95-99 | Orders 99, Carts 98, Shipping 97 (kempo-shipping), Tax 96, Commerce Settings 95 |
| Products | 85-89 | Products 89, Category 88, Inventory 87, Connect Products to Inventory 86, Product Settings 85 |
| Payments | 74-79 | Payments 79, Credits 78, Store Credits 77, Payouts 76, Disputes 75 (kempo-payments), Transaction History 74 |
| Marketing | 66-69 | Sales and Discounts 69 (kempo-discounts), Coupons 68 (kempo-coupons), Affiliates 67 (kempo-affiliates), Promotional Credit Links 66 |

An entry sets `group="Payments"` and, on at least one entry of a group, `group-icon="credit_card"` for the
menu's icon (kempo's own groups get theirs from the aside).

## Development and tests

```bash
npm install
npm run link:local        # links the sibling checkouts (kempo, kempo-products, kempo-payments, ...) into node_modules
npm test                  # the unit tier: an in-memory Postgres (PGlite), nothing else needed
docker compose up -d && npx drizzle-kit push --force   # the integration tier's database (port 5453)
DATABASE_URL=postgres://kempo:kempo@localhost:5453/kempo_commerce_test npm run test:integration
```

To look at it in a browser, install it in kempo-demo (the one site every extension is tried on).

The suites cover the cart, checkout (the zero-total path, credits, store credit, a card, expiry, a late
payment, concurrency), tax, refunds (the credits decisions, a refund that fails halfway), the HTTP layer and
the permission contract for every audience, emails, the lifecycle and the extension points from the outside.
The card in the unit tier is a stand-in for contacting Stripe and nothing else; `stripe.node-test.js` runs the
real thing and **says it was skipped** unless Stripe test-mode keys are set.
