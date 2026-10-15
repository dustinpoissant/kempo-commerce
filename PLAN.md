# kempo-commerce — PLAN

> Status: **not built.** This is the complete design for the extension that turns a kempo-products
> catalog into a store: cart, checkout, orders, order history, cancellation and refund requests, and
> the public pages and components for all of it. It is the brief for whoever builds it, and the
> place to add notes when a decision or a gap turns up in another extension.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name is owned by the same
> person, and the goal is to keep improving all of them. If the work here needs a change in one of
> them — and section 4 names the first — make it in that repository, with tests, README and
> CHANGELOG, backwards-compatible where others depend on it, and in dependency order when publishing.
> Never commit a `file:` specifier.

Contents

1. [What it is, and is not](#1-what-it-is-and-is-not)
2. [Principles](#2-principles)
3. [Dependencies](#3-dependencies)
4. [Required upstream changes](#4-required-upstream-changes)
5. [Concepts and data model](#5-concepts-and-data-model)
6. [The cart](#6-the-cart)
7. [Pricing and totals](#7-pricing-and-totals)
8. [Checkout](#8-checkout)
9. [Orders](#9-orders)
10. [Cancellation and refunds](#10-cancellation-and-refunds)
11. [Public pages](#11-public-pages)
12. [The mini-cart](#12-the-mini-cart)
13. [Admin](#13-admin)
14. [Hooks](#14-hooks)
15. [The server SDK](#15-the-server-sdk)
16. [The browser SDK, components and events](#16-the-browser-sdk-components-and-events)
17. [HTTP API](#17-http-api)
18. [Settings, permissions and groups](#18-settings-permissions-and-groups)
19. [Abuse protection, security and concurrency](#19-abuse-protection-security-and-concurrency)
20. [What kempo-shipping needs from this](#20-what-kempo-shipping-needs-from-this)
21. [Testing](#21-testing)
22. [Build order](#22-build-order)
23. [Open questions](#23-open-questions)
24. [Conventions an agent must follow](#24-conventions-an-agent-must-follow)

---

## 1. What it is, and is not

**Is:** the part of selling that no other extension does.

- A **cart** that works for visitors and signed-in customers, and survives signing in.
- A **checkout** that prices the cart on the server, applies tax, store credit and credits, takes
  payment, and creates an **order**.
- **Orders**, with a status, a history of everything that happened to them, and notes.
- **Order history** for customers, and a way to **request a cancellation or a refund**.
- **Refund approval** for administrators, including the warning about credits that were already
  spent (section 10).
- The **public pages** and **components** for all of it, including a mini-cart in a `k-aside`.
- **Hooks and an SDK** thick enough that shipping, coupons, subscriptions, digital delivery,
  reviews and anything else can be built as separate extensions on top.

**Is not:**

| Not here | Where it is |
|---|---|
| The catalog: products, options, prices, stock, images, types and fields | kempo-products |
| Moving money: payment intents, webhooks, refunds at the processor | kempo-payments |
| Tax rules and tax records | kempo-tax |
| The in-app currency (game coins, points) | kempo-credits |
| A money balance a customer holds | kempo-store-credit |
| **Shipping**: addresses to ship to, methods, rates, labels, **tracking** | **kempo-shipping** (later; section 20) |
| Coupons and discounts | kempo-coupons (later; plugs into the checkout hooks) |
| Subscriptions, digital delivery, reviews, wishlists | their own later extensions |
| Product categories as a taxonomy | kempo-product-categories (see section 11, open question 1) |

The target is parity with WooCommerce's core, built as small extensions around it.

## 2. Principles

1. **The server prices everything.** A browser names a product and a quantity, never an amount.
   Every price comes from kempo-products' `getPrice`, every total from this extension.
2. **Money is an integer** in the currency's smallest unit, everywhere, always. One currency per
   site: kempo-products' `currency` setting.
3. **Every write is idempotent.** An order's id is the root of every idempotency key used on its
   behalf (payment, store credit, credits, stock, tax), so a retried request or a redelivered webhook
   does each thing once.
4. **Everything that is spent can be unspent.** Each step of a checkout that takes something records
   how to give it back, and a failure undoes the steps already taken, in reverse.
5. **Optional extensions are optional.** kempo-tax, kempo-store-credit and kempo-credits are looked
   up at run time with `getExtension` and imported on demand; installed-but-disabled counts as
   absent. A store without them works.
6. **Nothing is hidden from the audit.** Every change to an order — by a customer, an administrator or
   another extension — is an event on its history with who did it.
7. **Extension points are designed in from day one**, not retrofitted: hooks (server logic),
   locations and fragments (markup), and an SDK. Section 14 is the contract.
8. **Pages are pages.** A detail view has its own address so the back button works; hints go in the
   label; spacing uses `mb` classes (section 24).

## 3. Dependencies

| | Extensions |
|---|---|
| **Hard** (`dependencies` in kempo-config.json) | kempo-products, kempo-payments |
| **Optional at runtime** | kempo-tax, kempo-store-credit, kempo-credits, kempo-media (pictures), kempo-product-categories |

Peer ranges to set when building: kempo-payments ≥ 0.1.10 (declines are reported, and
`payment:refunding` exists), kempo-products ≥ the release carrying the stock holds in section 4.

## 4. Required upstream changes

### 4.1 kempo-products: stock holds (required before checkout can be correct)

**The problem.** `recordPurchase` does three things at once: takes stock, records the purchase, and
grants any credits the products give. A checkout needs to *hold* stock while it waits for a payment
and only *commit* the purchase once the money has arrived. Without that there are two bad options:

- record at order creation → credit packs hand out credits before they are paid for; or
- record after payment → two customers can pay for the last item, and one of them has paid for
  something that no longer exists.

**The change.** Add a two-phase API to kempo-products, idempotent on a `ref`:

| Function | Does |
|---|---|
| `holdStock({ ref, lines, expiresInSeconds })` | Takes the stock (all or nothing, like `recordPurchase`) and records a **hold**. Nothing is granted and no purchase is recorded. |
| `commitHold(ref, { userId })` | Turns a hold into a recorded purchase: fires `purchase:recorded`, grants credits. Idempotent. |
| `releaseHold(ref)` | Returns the stock. Idempotent. Also what an expired hold does. |

A hold is a row, so a crash can be cleaned up by a sweep (`expireHolds`). `recordPurchase` stays as
it is for callers that do not need two phases (the admin's "record a sale made elsewhere").

Until this exists, commerce must not be built past the cart.

**kempo-inventory already has it.** Items there now have `quantity` (available) and `held`, with
`holdStock`, `releaseStock` and `consumeHeld` (all or nothing across several items, each a movement).
When kempo-products gains holds, the kempo-products-inventory connector should mirror them: holding
a product holds its materials, committing consumes them, releasing gives them back — so what is
reserved for an unpaid order is reserved all the way down.

### 4.2 kempo-products: a place for add-to-cart

The detail page already has `<slot name="actions">` and the `products-detail-extra` fragment, and the
list has `products-list-extra`. Commerce uses those and needs nothing new — but this is a contract:
those slot and fragment names are now load-bearing and must not be renamed.

### 4.3 kempo-products: a "needs fulfillment" signal

Commerce must know per line whether anything has to be sent or delivered. Options are a product
field, or deriving it: a `creditsOnly` product has nothing to fulfil; anything else does. Start with
that derivation, and let extensions override it per line through the `order:line_fulfillment` hook
(section 14), so digital delivery and shipping can decide for themselves.

## 5. Concepts and data model

All tables are prefixed `kempoCommerce`. Money columns are integers in the smallest unit. Every id is
a prefixed random string. Indexes are created by hand in `install.js`, as are any later-added
columns (`IF NOT EXISTS`), because kempo's installer makes columns and primary keys only.

| Table | One row is | Notable columns |
|---|---|---|
| `kempoCommerceCart` | A cart | `id`, `token` (hash; the cookie), `userId` (null for a visitor), `currency`, `status` (`open`, `converted`, `abandoned`, `merged`), `data` (extension data), `updatedAt`, `expiresAt` |
| `kempoCommerceCartLine` | A line in a cart | `cartId`, `productId`, `quantity`, `selections` (option → choice), `data` (extension data), `addedAt` |
| `kempoCommerceOrder` | An order | `id`, `number` (human, sequential), `userId`, `email`, `status`, `currency`, `subtotal`, `discountTotal`, `feeTotal`, `taxTotal`, `total`, `paidTotal`, `refundedTotal`, `billing` (address), `shown` (what the customer was shown before paying), `data`, `cartId`, `checkoutKey`, `placedAt`, `paidAt`, `completedAt`, `cancelledAt` |
| `kempoCommerceOrderLine` | A line as sold | `orderId`, `productId`, `slug`, `name`, `selections`, `unitPrice`, `quantity`, `lineTotal`, `tax`, `fulfillment` (`none`, `pending`, `done`), `refundedQuantity`, `creditsGranted`, `data` |
| `kempoCommerceOrderAdjustment` | A discount, fee or tax on an order | `orderId`, `lineId` (null for the whole order), `type` (`discount`, `fee`, `tax`), `code`, `label`, `amount` (signed), `source` (extension name), `data` |
| `kempoCommerceTender` | One way an order was (or is being) paid | `orderId`, `kind` (`card`, `store-credit`, `credits`, an extension's), `amount`, `status` (`pending`, `applied`, `reversed`, `refunded`), `reference` (payment id, entry id), `idempotencyKey`, `data` |
| `kempoCommerceEvent` | One thing that happened to an order | `orderId`, `type`, `actor` (user id or extension), `data`, `createdAt` — append-only |
| `kempoCommerceNote` | A note on an order | `orderId`, `authorId`, `body`, `visibleToCustomer`, `createdAt` |
| `kempoCommerceRequest` | A customer's cancellation or refund request | `orderId`, `kind` (`cancel`, `refund`), `status` (`requested`, `approved`, `declined`, `completed`, `withdrawn`), `reason`, `message`, `lines` (line id → quantity), `decidedBy`, `decisionNote`, `createdAt`, `decidedAt` |
| `kempoCommerceRefund` | A refund that was issued | `orderId`, `requestId`, `amount`, `lines`, `tenders` (how it was returned), `restock`, `credits` (`owe`/`zero`/none), `issuedBy`, `createdAt` |
| `kempoCommerceCounter` | The order number counter | one row, locked to increment |

**Why a Tender.** Card, store credit and credits are all "a way the order was paid", with the same
lifecycle: apply, maybe reverse before the order is finished, maybe refund after. Treating them as
one thing means refunds and failed-payment cleanup are one loop instead of three special cases, and
a later extension (a gift card, a wallet) is a new tender kind and not a change to commerce.

### Order status

```
                       ┌──────────────► failed
 (cart) ─► pending_payment ─► processing ─► completed
                       │            │            │
                       ▼            ▼            ▼
                   cancelled    on_hold    partially_refunded ─► refunded
                                               ▲
                       cancelled ◄─────────────┘  (a cancellation of a paid order is a refund)
```

| Status | Means |
|---|---|
| `pending_payment` | The order exists, stock is held, payment has not completed. Expires (setting), then becomes `failed` and everything is released. |
| `processing` | Paid, with something still to fulfil. |
| `completed` | Paid and every line is fulfilled or needs no fulfilment. A credit pack goes `pending_payment` → `completed`. |
| `on_hold` | An administrator, or an extension, has paused it. |
| `failed` | Payment failed or expired. Spends reversed, stock released. Terminal. |
| `cancelled` | Cancelled before it was paid or fulfilled, with nothing to refund or after a full refund. Terminal. |
| `partially_refunded`, `refunded` | Money has gone back. Orthogonal to fulfilment: the order keeps its line fulfilment states. |

Transitions are made only through the SDK (`setOrderStatus` and the functions that wrap it), which
checks the move is allowed, writes the event, and fires the hooks. Extensions can add their own
*sub-state* in `order.data`; they cannot add statuses, because every screen, report and hook
listener depends on this list.

## 6. The cart

**Identity.** A visitor gets a cart immediately, held by a random token in a cookie (stored hashed). A
signed-in customer has one open cart, `userId` set. Signing in **merges** the visitor's cart into the
customer's: same product and same selections add their quantities (capped by stock), others are kept.
The merge is idempotent and fires `cart:merged`.

**Lines.** A line is a product, a quantity, and the option selections (`{ optionKey: choiceKey }`).
Adding the same product with the same selections increases the quantity. Extensions attach their own
data to a line (`data`), and two lines with different `data` are different lines — which is how a
gift message, an engraving or a subscription term can differ per line.

**Validation, on every read.** A cart is never trusted: each time it is read it is re-priced and
re-checked against the catalog, and anything wrong is reported as a **notice** on the cart rather
than silently fixed:

| Notice | When | What is done |
|---|---|---|
| `unavailable` | the product is no longer published, or sold | the line stays, marked, and blocks checkout |
| `out_of_stock` | quantity exceeds stock | quantity is reduced to stock (a notice says so), or the line is marked if stock is 0 |
| `price_changed` | the unit price differs from when it was added | the new price is used and the customer is told what it was |
| `option_unavailable` | the chosen choice is out of stock or gone | the line is marked and blocks checkout |
| `quantity_limit` | over the per-line or per-cart limit | clamped, with a notice |

**Lifecycle.** `open` → `converted` (an order was placed; the cart is emptied or replaced) →
nothing. An untouched cart past `cart_expiry_days` becomes `abandoned` and is purged by a sweep after
`cart_purge_days`. `abandoned` carts are listed for administrators (and are what a later
"abandoned cart" extension would email about).

**No stock is reserved by a cart.** Only a checkout holds stock (section 4.1), and only briefly.

**Limits** (settings): max lines per cart, max quantity per line, whether a product may appear more
than once with different selections.

## 7. Pricing and totals

Totals are computed by one function, `computeTotals(cart or order)`, used by the cart, the mini-cart,
the checkout and the order, so what is shown is always what is charged.

```
 line total      = getPrice(...).unit × quantity                      (kempo-products)
 subtotal        = Σ line totals
 discounts       = Σ adjustments of type discount                      (negative; coupons, promos)
 fees            = Σ adjustments of type fee                           (shipping, handling, gift wrap)
 taxable amount  = per line: line total − its discounts (+ fees if taxed)
 tax             = kempo-tax's calculateTax over the taxable lines     (or none)
 total           = subtotal + discounts + fees + tax
 ── tenders, in order ──
 credits         = per product that accepts them, up to getPrice().credits.maxCredits
 store credit    = up to what is still due
 card            = what is left
```

**Adjustments.** Discounts and fees are contributed by other extensions through hooks (section 14)
as `{ type, code, label, amount, lineId?, taxable?, source }`. Commerce does not know what a coupon or
a shipping rate is; it knows how to sum, display, tax and refund an adjustment. Each adjustment is
stored on the order, so a refund can reverse the right part of it.

**Inclusive and exclusive tax.** kempo-tax's `prices_include_tax` setting decides; commerce shows
whichever the store uses and never adds tax twice.

**Rounding.** Per line, never per order, so a refund of one line is exactly that line's amount.
Credits round up and money rounds down (kempo-products' rule), so rounding never gives a discount.

**Currency.** The cart and order carry the currency they were priced in. If the site's currency is
changed while a cart is open, the cart is re-priced; an order is never re-priced. Store credit in
another currency is not applied.

## 8. Checkout

### 8.1 Steps

1. **Start.** `startCheckout(cart)` re-validates the cart (section 6). Blocking notices stop it. It
   returns a **quote**: the totals, the tenders available to this customer and how much each could
   take, and the fields extensions want collected.
2. **Collect.** The customer fills in billing details (name, email, address — the address kempo-tax
   needs) and whatever fields extensions added through `checkout:fields`. Each field is validated by
   its owner through `checkout:validate`.
3. **Review.** The page shows lines, adjustments, tax, total and **the refund policy**, and lets the
   customer choose how much store credit and credits to use (up to their limits).
4. **Place the order.** `placeOrder({ checkoutKey, ... })` — **idempotent on `checkoutKey`**, which
   the page makes once per checkout. In one logical operation, under the cart's lock:

   | # | Does | Undone by |
   |---|---|---|
   | 1 | Re-prices and re-validates; refuses if anything changed since the quote (the customer is shown the change and confirms) | — |
   | 2 | Creates the order, `pending_payment`, with `shown` = exactly what was displayed, and an event | cancel it |
   | 3 | `holdStock` for every line (section 4.1) | `releaseHold` |
   | 4 | Applies **credits** (`spendCredits`, key `order:<id>:credits`) | `reverseSpend` |
   | 5 | Applies **store credit** (`spendCredit` partial, key `order:<id>:store-credit`) | `reverseSpend` |
   | 6 | Creates the **payment** for what is left (kempo-payments, `owner: 'kempo-commerce'`, `reference: <order id>`) — or none, if nothing is left | cancel the payment |
   | 7 | Returns the order and, if there is a payment, its client secret | — |

   If step *n* fails, steps *n−1…1* are undone in reverse and the order becomes `failed`. Each undo is
   itself idempotent and is recorded as a Tender status and an event, so a crash halfway is finished by
   the recovery sweep (8.3), not left half done.
5. **Pay.** The customer completes the card form (kempo-payments' component). The **browser's word
   is never believed**: the page asks the server to check, and the server asks the processor.
6. **Finish.** On kempo-payments' `payment:succeeded` — from the signed webhook, or from asking the
   processor — `completeOrder(orderId)` runs, idempotently: `commitHold` (stock committed, credits
   granted), record the tax transaction, mark tenders applied, status `processing` (or `completed`
   if nothing needs fulfilling), fire `order:paid`, empty the cart.

### 8.2 A total of zero

If store credit and credits cover the whole total, step 6 creates no payment and step 4 of the page
skips the card form. `completeOrder` runs straight away. **This path must work with no payment
processor configured**, because it is how a store owner tests a checkout: add store credit to your
own account and buy something.

### 8.3 Recovery and expiry

A sweep (a scheduled job; kempo's own mechanism, checked when building) runs every minute:

- `pending_payment` orders older than `pending_expiry_minutes` → `failed`: cancel the payment, reverse
  tenders in reverse order, release the hold.
- Orders whose tenders are half-applied (a crash between steps) → finished or undone, whichever the
  order's state says.
- Expired holds → released (also done by kempo-products).

### 8.4 Failure modes the tests must cover

Payment declined; payment succeeds after the order expired (refund it automatically and tell the
customer); webhook delivered twice; webhook arrives before the browser returns; two tabs checking
out the same cart; the last item bought by two customers at once; the process dying after each
numbered step; a price changing between quote and place; the customer's store credit being spent
elsewhere in between.

## 9. Orders

**Number.** Sequential, human-friendly, from `kempoCommerceCounter` taken under a lock, shown as
`#1042`; the format (prefix, padding) is a setting. The id, not the number, is what URLs and
idempotency keys use.

**What the customer was shown** (`shown`) is stored on the order at placement — lines, prices, tax,
total, tenders and the refund policy text — because that is what answers a dispute, and because
settings change.

**History.** `kempoCommerceEvent` is append-only. Every status change, tender change, note,
request, refund and extension action is an event with an actor. The admin and the customer pages
render it; the customer sees only events marked customer-visible.

**Notes.** Administrators add notes to an order, private or visible to the customer.

**Customer access.** An order belongs to its `userId`; the customer routes only ever use the
session's user. A visitor who checked out as a guest (if enabled; open question 3) gets a signed
link in their confirmation email.

**Fulfilment.** Each line has `fulfillment`: `none`, `pending` or `done`. Commerce changes it only
through `setLineFulfillment`, called by whatever fulfils (shipping, digital delivery, an
administrator ticking a box). The order becomes `completed` when no line is `pending`. Commerce
itself does nothing physical.

**Emails and notifications.** Customer emails (order received, paid, request received, request
decided, refund issued) use kempo's email sending when it is configured; administrators get kempo
notifications for new orders and new requests. Both are driven from the hooks in section 14 and
templated through `email:context` so other extensions can add to them. (Verify kempo's email SDK
when building; if there is none, this is a gap to fill upstream.)

## 10. Cancellation and refunds

### 10.1 Principles

- **Refunds are approved by an administrator.** There is no automatic refund path for a paid
  order.
- **Spent credits are never refunded as money**, bought or earned.
- A refund goes back **to where the money came from, tender by tender**: card money to the card
  (kempo-payments), store credit to store credit (`addCredit`), credits to credits
  (`reverseSpend`). An administrator may choose to refund card money **to store credit** instead.
- A refund is for lines and quantities, or an amount, never more than was paid and not yet returned.

### 10.2 What a customer can do

| Situation | Customer action | Result |
|---|---|---|
| Order is `pending_payment` | **Cancel** | Immediate, no approval: nothing was paid. Tenders reversed, hold released. |
| Paid, nothing fulfilled yet | **Request cancellation** | A request, `kind: cancel`, for the whole order or chosen lines. |
| Fulfilled, within `refund_window_days` | **Request a refund** | A request, `kind: refund`, for chosen lines and quantities, with a reason and message. |
| Outside the window, or a product marked non-refundable | — | The page says so and why; no request is possible (an administrator can still refund from the admin). |

The request form asks for lines and quantities, a reason from a configurable list, and a free
message. The customer can **withdraw** a request until it is decided. They see its status on the
order page and are told by email when it is decided.

### 10.3 What an administrator does

The **Requests** queue lists open requests with the order, the customer, the lines, the reason and the
age. Opening one is its own page. Approving it runs this, in order:

1. **Preview.** Compute the refund: per line, the amount (unit price × quantity, less its share of
   discounts, plus its tax), and per tender how it will be returned. Show it, with a **restock**
   checkbox per line (default from a setting) and a destination choice for the card portion (card, or
   store credit).
2. **Credits warning.** For every product in the refund that **gave credits**, call kempo-credits'
   `previewClawBack({ reference: { owner: 'kempo-products', ref: <purchase ref> }, amount })`.
   If `shortfall > 0` for any of them the administrator **must decide before continuing**:

   > **Alex has already spent 200 of the 500 credits this purchase gave.**
   > Take back the 300 they hold and leave them at zero — or take all 500 and leave them owing 200?
   > [ View their credits history ]   ( ) Leave them at zero   ( ) Leave them owing   [ Cancel ]

   The history link opens the customer's credits account page in a new tab — the point is that the
   administrator can see whether this is someone buying an in-game item, spending the bonus credits
   on another, and asking for the first to be refunded, and can then refuse, ban the account, or
   remove the second item. The choice is passed on as `ifShort: 'zero' | 'owe'`, and is recorded on
   the refund and the order's history with who made it. With no shortfall there is no question.
3. **Issue.** Under the order's lock, idempotent on the refund id:
   claw back credits the products gave → return credits that were spent on the order
   (`reverseSpend`/refund) → return store credit (`addCredit`) → refund the card portion at the
   processor (kempo-payments; its own `payment:refunding` guard may refuse) → reverse the tax
   (kempo-tax) → return stock if `restock` (kempo-products `reversePurchase` for the lines) → write
   the refund, events, tender statuses, the order's `refundedTotal` and status.
4. **Decline.** An administrator can decline with a note the customer sees.

If a step fails after an earlier one succeeded, the refund is left **`partially issued`** with exactly
what was done and what was not, and an administrator finishes or corrects it from the order page; it
is never silently half-applied.

### 10.4 Refunds made outside commerce

A refund made in Stripe's dashboard, or a chargeback, reaches commerce through kempo-payments'
`payment:refunded` and `payment:disputed`. Commerce records them on the order as events and tenders,
marks the order, and notifies administrators; it does not take any action a person has not approved
(a dispute might be won). Credits are not clawed back automatically.

### 10.5 What "reverse" in kempo-products becomes

kempo-products' admin **Reverse** button on a recorded purchase takes credits back and leaves the
buyer owing the rest without asking. For a purchase that belongs to an order, that screen should
**link to the order** and not offer the button; the order's refund is the path.

## 11. Public pages

Extension pages live under the public scope (`/commerce/…`). Nicer top-level aliases (`/cart/`,
`/shop/`) are a kempo-server route-mapping concern and are listed in the open questions.

| Page | Route | What it is |
|---|---|---|
| **Shop** | `/commerce/shop/` | The product list with the categories as a sidebar (collapses on mobile), search, sort and the filters kempo-products offers. Uses `<k-prod-list>` underneath and adds add-to-cart to each card through `products-list-extra`. |
| **Category** | `/commerce/category/<slug>/` | The same list, scoped to one category, with its description and breadcrumb. |
| **Product details** | `/products/<slug>/` (kempo-products' own page) | Not duplicated. Commerce fills the page's `actions` slot with **quantity, the options' validity, add to cart and a buy-now button**, shows stock/availability messages, and the credits lines products already shows. Related-products and reviews are fragments other extensions can fill. |
| **Cart** | `/commerce/cart/` | Lines with picture, name, selections, unit price, quantity stepper, remove, line total; notices; discount and fee rows; subtotal; **proceed to checkout**; continue shopping. Empty state. |
| **Checkout** | `/commerce/checkout/` | One page, in sections: contact and billing, extension fields, store credit and credits (when available), order review with the refund policy, payment. Shows a stable summary on the side. Handles the zero-total path. |
| **Order received** | `/commerce/order/<id>/received/` | After placing: status, what was paid, what happens next, credits granted. Polls until the payment is confirmed. |
| **Order history** | `/commerce/account/orders/` | Signed-in only. A list of the customer's orders with number, date, status, total, and a link. Paginated. |
| **Order details** | `/commerce/account/orders/<id>/` | Lines, adjustments, tax, tenders, status, the visible history and notes, and the **actions**: cancel (if unpaid), **request cancellation**, **request refund**, withdraw a request. |
| **Request cancellation / refund** | `/commerce/account/orders/<id>/request/` | The form from section 10.2, on a page of its own. |

**Categories.** Commerce does not own a taxonomy (open question 1). It reads categories from an
interface — `getCategories()`, `getProductCategories(productId)`, `getCategoryTree()` — implemented by
kempo-product-categories when installed. With none installed the shop page falls back to product
**types** and **tags** as the sidebar, so the shop works on day one.

**All pages** are server-checked, work without JavaScript for reading (cart contents, order list),
meet accessibility basics (labelled controls, announced updates with `aria-live`, focus management when
the mini-cart opens), and use only kempo-css utility classes.

## 12. The mini-cart

`<k-com-mini-cart>` — a cart that opens from the side without leaving the page.

```html
<script type="module" src="/commerce/components/MiniCart.js"></script>
<k-com-mini-cart></k-com-mini-cart>                   <!-- left, the default -->
<k-com-mini-cart side="right"></k-com-mini-cart>      <!-- right -->
```

- It is a **`k-aside`** (`side="left"` by default, `"right"` by attribute or the `mini_cart_side`
  setting; `main="overlay"`, `overlay-close`, `esc-close`). kempo-ui's aside already provides the
  panel, the overlay, focus capture, the `state` property (`offscreen` / `expanded`) and the
  `hide()`, `expand()` and `toggle()` methods; the mini-cart wraps it and does not reimplement any.
- It is opened by a **trigger**, `<k-com-cart-button>`: an icon button with an item-count badge, to
  put in a header. Any element can instead call `miniCart.open()`.
- **Contents:** lines (picture, name, selections, quantity stepper, remove, line total), notices,
  subtotal, **View cart** and **Checkout** buttons, and an empty state with a link to the shop. A
  loading state on every change; it shows the server's result, never an optimistic guess.
- **Opens on add** when `mini_cart_open_on_add` is on (default), so adding an item shows the cart.
- **Stays current:** it listens for `cart-changed` (fired by the add-to-cart button, the cart page
  and anything else that changes the cart, and across tabs through `BroadcastChannel`), and refreshes
  itself. It never polls.
- **Placement without editing a template:** commerce pushes the mini-cart and the trigger onto every
  public page through kempo's extension content injection (the global content and locations
  mechanism), and a site can turn that off (`mini_cart_inject`) and place the elements itself.
- **Slots and fragments** for other extensions: `mini-cart-before-lines`, `mini-cart-after-lines`
  (a coupon box, a free-shipping progress bar), and `mini-cart-footer`.
- **Methods:** `open()`, `close()`, `toggle()`, `refresh()`. **Events:** `mini-cart-opened`,
  `mini-cart-closed`.
- It is a shadow component, so it uses `ShadowComponent` and kempo-css automatically. It is hidden on
  the cart and checkout pages themselves (setting).

## 13. Admin

All under Admin → Commerce, each its own page so the back button works; hints in labels; no inline
detail views.

| Screen | Route | For |
|---|---|---|
| **Orders** | `/admin/extension/kempo-commerce/` | List with search (number, name, email), status and date filters, totals, bulk status change. Opening one goes to its page. |
| **Order** | `.../order/?id=` | Everything on the order: lines, adjustments, tax, tenders, customer, history, notes, requests, refunds; actions (change status, add note, **refund**, mark lines fulfilled, resend email). Extensions add panels through a fragment. |
| **Refund requests** | `.../requests/` | The queue from section 10.3, oldest first. Opening one is its own page with the preview and the credits decision. |
| **Refund** | `.../refund/?order=` | Issue a refund without a customer request: lines or amount, destinations, restock, credits decision. |
| **Carts** | `.../carts/` | Open and abandoned carts (read-only), with their lines and when they were touched. |
| **Settings** | `.../settings/` | The settings in section 18, grouped, validated, with explanations, in the Settings nav group (the same pattern as Product Settings). |
| **Dashboard widget** | — | Orders and revenue today and this week, orders waiting, **refund requests waiting**, with links. |

Admin notifications: a new order, a new request, a payment that arrived for an expired order, a
refund left partially issued.

## 14. Hooks

Fired through kempo's `triggerHook`. **Guards** run in *bail* mode before something happens: they may
mutate the payload's `draft` (or add to a collection), and throw `{ code, msg }` to refuse, which
reaches the caller exactly. **Notifications** run after commit; a handler that throws is logged and
stops nothing, and nothing a handler does can undo the change. Names are `kempo-commerce:<resource>:<event>`,
following kempo-products. Every payload carries `actor` (the extension that made the change through
the SDK, or `''` for a person).

### Cart

| Hook | Kind | Payload | Lets you |
|---|---|---|---|
| `cart:before_add` | guard | `{ cart, draft: { productId, quantity, selections, data }, userId, actor }` | change or refuse an add (min/max quantity, "one per customer", age-gated products) |
| `cart:item_added` | note | `{ cart, line }` | react |
| `cart:before_update` | guard | `{ cart, line, changes }` | refuse or clamp a quantity change |
| `cart:item_updated` | note | `{ cart, line, previous }` | |
| `cart:item_removed` | note | `{ cart, line }` | |
| `cart:cleared` | note | `{ cart }` | |
| `cart:merged` | note | `{ from, into, userId }` | carry over your own cart data |
| `cart:validate` | guard | `{ cart, notices }` | **add notices** and mark lines blocked (a regional restriction, a mixed-cart rule) |
| `cart:expired` | note | `{ cart }` | abandoned-cart emails |

### Totals and checkout

These are the checkout sequence as hooks. They run in a **fixed order**, because handler order is
registration order and money math has to happen in a specific sequence.

| Hook | Kind | Payload | Lets you |
|---|---|---|---|
| `totals:discounts` | guard | `{ cart \| order, lines, adjustments, currency }` | push `{ type: 'discount', code, label, amount, lineId?, taxable? }` |
| `totals:fees` | guard | same | push fees — **shipping lands here** |
| `totals:tax` | guard | `{ …, taxable, address }` | replace or add to tax (kempo-tax registers itself here) |
| `totals:computed` | note | `{ cart \| order, totals }` | read the result |
| `checkout:fields` | guard | `{ cart, fields }` | **add fields to the checkout form** (a delivery address, a gift message, a VAT number) |
| `checkout:validate` | guard | `{ cart, billing, data, errors }` | add field errors; refuse |
| `checkout:tenders` | guard | `{ cart, user, tenders }` | offer or remove ways to pay and their limits |
| `checkout:before_place` | guard | `{ cart, draft }` | last chance to refuse or alter the order draft |
| `checkout:abandoned` | note | `{ cart, order? }` | |

### Orders

| Hook | Kind | Payload | Lets you |
|---|---|---|---|
| `order:before_create` | guard | `{ draft }` | add `data`, refuse |
| `order:created` | note | `{ order }` | |
| `order:paid` | note | `{ order, tenders }` | **the moment to do the work**: fulfil, license, grant |
| `order:line_fulfillment` | guard | `{ order, line, fulfillment }` | decide whether a line needs fulfilling and how |
| `order:fulfillment_changed` | note | `{ order, line, previous }` | |
| `order:status_changed` | note | `{ order, from, to, actor }` | everything else |
| `order:before_status` | guard | `{ order, from, to }` | refuse a transition |
| `order:note_added` | note | `{ order, note }` | |
| `order:email_context` | guard | `{ order, template, context }` | add to or alter a customer email |
| `order:failed` | note | `{ order, reason }` | |

### Cancellation and refunds

| Hook | Kind | Payload | Lets you |
|---|---|---|---|
| `request:before_create` | guard | `{ order, draft }` | refuse a request (non-refundable item, outside a custom window) |
| `request:created` | note | `{ order, request }` | |
| `request:withdrawn` | note | `{ order, request }` | |
| `refund:before_approve` | guard | `{ order, request?, preview }` | **add warnings or blocks** the administrator must see (a fraud signal, a held shipment) |
| `refund:approved` | note | `{ order, request?, refund }` | |
| `request:declined` | note | `{ order, request, note }` | |
| `refund:before_issue` | guard | `{ order, refund }` | last refusal |
| `refund:issued` | note | `{ order, refund }` | **put things back**: licences, shipments, entitlements |
| `refund:partial` | note | `{ order, refund, done, failed }` | alert |
| `order:cancelled` | note | `{ order, actor, reason }` | |

### Locations and fragments (markup)

Following kempo-products: fragments are pull (one overridable winner), locations are push (many
contributors), and a page cannot define one that is not declared.

| Name | Where | For |
|---|---|---|
| `commerce-cart-before`, `commerce-cart-after` | cart page | a coupon box, upsells |
| `commerce-cart-line-extra` | each cart line | a gift message input, a note |
| `commerce-checkout-sections` | checkout form, between sections | extension fields not driven by `checkout:fields` |
| `commerce-checkout-summary-extra` | checkout side summary | a trust badge, a delivery estimate |
| `commerce-order-received-extra` | order received page | next steps, download links |
| `commerce-account-order-actions` | customer order page | extra buttons (reorder, invoice) |
| `commerce-account-order-panels` | customer order page | tracking, downloads — **shipping tracking shows here** |
| `commerce-admin-order-panels` | admin order page | a shipment panel, a fraud score |
| `commerce-admin-order-actions` | admin order page | extra buttons |
| `mini-cart-before-lines`, `mini-cart-after-lines`, `mini-cart-footer` | mini-cart | free-shipping bar, coupon |

## 15. The server SDK

`kempo-commerce/sdk`. Every function returns `[error, data]` with `error = { code, msg }`, and none
throws. These are data operations with **no permission checks of their own**: the routes decide who
may do what. Everything that changes state takes an optional `{ actor }` (the extension's name) and
writes it to the order's history.

### Cart

| Function | Does |
|---|---|
| `getCart({ cartId \| token \| userId })`, `getOrCreateCart(...)` | The cart with its lines, notices and totals, re-validated. |
| `addToCart({ cartId, productId, quantity, selections, data })` | Adds (or increases) a line, runs `cart:before_add`. |
| `updateCartLine`, `removeCartLine`, `clearCart` | |
| `mergeCarts({ from, into })` | What sign-in does. |
| `computeTotals(cartOrOrder)` | The one totals function (section 7). |
| `setCartData(cartId, patch)` | Extension data on the cart. |

### Checkout

| Function | Does |
|---|---|
| `startCheckout({ cartId, userId })` | Validates and returns the quote: totals, tenders and limits, fields. |
| `placeOrder({ cartId, userId, checkoutKey, billing, data, tenders })` | Section 8.1, idempotent. Returns `{ order, payment? }`. |
| `completeOrder(orderId, { actor })` | Section 8.1 step 6. Idempotent. Called by the webhook path; also callable by an extension that took payment its own way. |
| `failOrder(orderId, reason)` | Undo and mark failed. |
| `registerTender(definition)` | Add a way to pay (below). |

### Orders

| Function | Does |
|---|---|
| `getOrder(id \| number)`, `listOrders({ userId?, status?, search?, from?, to?, limit?, offset? })` | |
| `setOrderStatus(id, status, { actor, note })` | The only way a status changes; checks `order:before_status`. |
| `setLineFulfillment(id, lineId, 'pending' \| 'done', { actor, data })` | What shipping and digital delivery call. |
| `addOrderNote(id, { body, visibleToCustomer, authorId })` | |
| `setOrderData(id, patch)`, `addOrderAdjustment(...)` | Extension data on an order. |
| `getOrderEvents(id, { customerVisibleOnly })` | |
| `cancelUnpaidOrder(id, { actor })` | |

### Requests and refunds

| Function | Does |
|---|---|
| `requestCancellation({ orderId, userId, lines, reason, message })`, `requestRefund(...)`, `withdrawRequest(id)` | Customer side. |
| `listRequests({ status?, orderId?, ... })`, `getRequest(id)` | |
| `previewRefund({ orderId, lines \| amount, restock, destination })` | The amounts per tender, per line, and **the credits warning** (`credits: [{ productId, given, held, shortfall, userId, historyUrl }]`). Changes nothing. |
| `approveRequest(id, { refund, credits: 'zero' \| 'owe', actor })` | Issues the refund and completes the request. Refuses (409, `needsDecision: true`) if there is a credits shortfall and no decision. |
| `declineRequest(id, { note, actor })` | |
| `refundOrder(orderId, { lines \| amount, destination, restock, credits, note, actor })` | An administrator-initiated refund. Same rules. |

### Tenders

A tender is a way an order is paid. Built in: `card` (kempo-payments), `store-credit`, `credits`.

```js
registerTender({
  kind: 'gift-card',
  label: 'Gift card',
  available: async ({ user, cart }) => ({ max: 5000, detail: { balance: 5000 } }),  // or null
  apply: async ({ order, amount, idempotencyKey }) => ({ reference }),
  reverse: async ({ order, tender }) => {},                  // before the order is finished
  refund: async ({ order, tender, amount, idempotencyKey }) => ({ reference }),
});
```

Commerce orders tenders by a `priority` they declare, applies them in that order against what is
still due, undoes them in reverse, and refunds each to itself. Cards are always last.

### Reading what other extensions need

`getCommerceConfig()` (currency, settings), `orderStatuses`, `EVENTS`, `isCheckoutAvailable()`.

## 16. The browser SDK, components and events

`/commerce/sdk.js` returns the same `[error, data]` tuples: `getCart`, `addToCart`, `updateLine`,
`removeLine`, `startCheckout`, `placeOrder`, `confirmPayment(orderId)`, `getMyOrders`, `getMyOrder`,
`requestCancellation`, `requestRefund`, `withdrawRequest`, `cancelOrder`. An error carries what the
route sent with it (`notices`, `balance` and `needed` on a refused tender, `retryAfter`).

| Element | Module | |
|---|---|---|
| `<k-com-add-to-cart>` | `components/AddToCart.js` | Quantity and the button; reads options from the page's `<k-prod-detail>` via its `selection-change` event; disables with the reason; fires `cart-changed`. |
| `<k-com-cart-button>` | `components/CartButton.js` | The header trigger with the count badge; opens the mini-cart. |
| `<k-com-mini-cart>` | `components/MiniCart.js` | Section 12. |
| `<k-com-cart>` | `components/Cart.js` | The cart page's body. |
| `<k-com-checkout>` | `components/Checkout.js` | The checkout page's body. **Light DOM**, because kempo-payments' Stripe fields do not mount inside a shadow root, so nothing above it may be one either. |
| `<k-com-orders>`, `<k-com-order>` | `components/Orders.js`, `Order.js` | Order history and an order's page. |
| `<k-com-request>` | `components/Request.js` | The cancellation / refund request form. |

**Events** (bubbling, composed): `cart-changed` `{ cart }`, `cart-line-added` `{ line }`,
`mini-cart-opened`, `mini-cart-closed`, `checkout-step` `{ step }`, `order-placed` `{ order }`,
`order-paid` `{ order }`, `request-submitted` `{ request }`. Following the project's rule: **methods
cause actions, events only say something happened.**

## 17. HTTP API

Under `/commerce/api`. `/my/` routes use the session only. Carts also accept the visitor cookie.

| Route | Who |
|---|---|
| `GET /cart`, `POST /cart/lines`, `PATCH /cart/lines/:id`, `DELETE /cart/lines/:id`, `DELETE /cart` | anyone (cart cookie) |
| `POST /cart/merge` | signed in (called on sign-in) |
| `GET /checkout`, `POST /checkout/validate`, `POST /checkout/place` | signed in |
| `POST /checkout/orders/:id/confirm` | signed in, own order — asks the processor |
| `GET /my/orders`, `GET /my/orders/:id` | signed in |
| `POST /my/orders/:id/cancel` | signed in, own, unpaid |
| `POST /my/orders/:id/requests`, `DELETE /my/requests/:id` | signed in, own |
| `GET /orders`, `GET /orders/:id`, `GET /orders/:id/events` | `commerce:orders:view` |
| `PATCH /orders/:id/status`, `POST /orders/:id/notes`, `PATCH /orders/:id/lines/:lineId` | `commerce:orders:manage` |
| `GET /requests`, `GET /requests/:id` | `commerce:requests:view` |
| `POST /refunds/preview` | `commerce:refunds:approve` |
| `POST /requests/:id/approve`, `POST /requests/:id/decline`, `POST /orders/:id/refund` | `commerce:refunds:approve` (and kempo-payments' `payments:refund` for card money) |
| `GET /carts` | `commerce:orders:view` |
| `GET /settings`, `PUT /settings` | `commerce:settings:manage` |

There is **no route that spends store credit or credits**: the checkout does, server-side, as part
of `placeOrder`.

## 18. Settings, permissions and groups

### Settings

| Setting | Default | |
|---|---|---|
| `cart_expiry_days` / `cart_purge_days` | 30 / 90 | When an untouched cart is abandoned, and purged. |
| `max_lines_per_cart`, `max_quantity_per_line` | 100 / 99 | |
| `pending_expiry_minutes` | 60 | How long an unpaid order holds stock and spends. |
| `guest_checkout` | off | Allow checking out without an account (open question 3). |
| `order_number_prefix`, `order_number_padding`, `order_number_start` | `#`, 0, 1000 | |
| `refund_window_days` | 30 | How long after completion a refund can be requested. 0 disables requests. |
| `allow_cancel_requests` | on | |
| `refund_reasons` | a list | What the request form offers. |
| `restock_on_refund` | on | The default for the restock checkbox. |
| `refund_policy` | text | Shown at checkout and stored with the order. |
| `mini_cart_side` | `left` | `left` or `right`. |
| `mini_cart_open_on_add` / `mini_cart_inject` | on / on | |
| `mini_cart_hide_on_cart_pages` | on | |
| `purchase_limit_per_user`, `_per_ip`, `_global` | 10 / 20 / 500 | Checkout attempts per hour (section 19). |
| `failed_payment_limit`, `failed_payment_cooldown_minutes` | 3 / 60 | |
| `trust_proxy` | off | Take the address from `X-Forwarded-For`; only behind your own proxy. |
| `shop_page_size` | follows kempo-products | |

### Permissions

| Permission | Lets you |
|---|---|
| `commerce:orders:view` | See orders, carts, history |
| `commerce:orders:manage` | Change status, add notes, mark fulfilment |
| `commerce:requests:view` | See refund and cancellation requests |
| `commerce:refunds:approve` | Approve or decline requests, issue refunds (also needs `payments:refund` for card money) |
| `commerce:settings:manage` | Change settings |
| `commerce:checkout` | Check out. Held by `system:Users` from the first install, like a purchase permission, so a site can narrow it. |

Groups: `kempo-commerce:support` (view orders and requests), `kempo-commerce:manager` (+ manage),
`kempo-commerce:administrator` (everything).

## 19. Abuse protection, security and concurrency

### Card testing

Selling cheap things to strangers invites *card testing*. Before a payment reaches the processor:

- **Rate limits** per account, per IP address and site-wide over the last hour (the settings above).
- **A decline cool-down.** After N declines from one account or address within a window, further
  attempts are refused until it passes, and **the payment that hit the limit is cancelled at the
  processor** so no more cards can be tried against it from the browser. One decline and a retry is a
  customer and works.
- **Signed-in buyers only** in v1.
- **A log of every refused attempt**, and a notification as the hour's count reaches 1, 10, 100…
- `trust_proxy`, because behind a proxy every buyer shares one address. Never when there is no
  proxy: the header is then whatever the client sent.
- Declines are counted from `payment:failed`, which needs kempo-payments ≥ 0.1.10.

### Security

- Prices, totals, stock and permissions are decided on the server. A request that names an amount is
  refused.
- A user can only ever reach their own cart and orders; the id always comes from the session.
- Idempotency keys are derived from the order id (`order:<id>:<step>`), unique per user at the ledger.
- The browser is never believed that a payment succeeded.
- Customer-visible text a staff member writes (notes, decision notes) is escaped on display.
- No card data touches the site: only kempo-payments' processor-hosted fields.

### Concurrency

- **Per-cart advisory lock** around add, update and place, so two tabs cannot place one cart twice
  and `checkoutKey` makes the second one return the first's order.
- **Per-order advisory lock** around every status change, tender change and refund.
- **Per-customer lock** in kempo-credits and kempo-store-credit for the spends, which already exist.
- **Stock** is taken atomically by kempo-products' conditional update (section 4.1).
- The order counter is incremented under its own lock.
- Locks are taken in a fixed order (cart, order, then the customer ledgers) so two operations cannot
  deadlock each other.

## 20. What kempo-shipping needs from this

Shipping is deliberately not here. This is what it will build on, so these must exist and be stable:

| Shipping needs to… | Through |
|---|---|
| Collect a delivery address | `checkout:fields` (adds fields, with validation in `checkout:validate`), stored in `order.data.shipping` |
| Offer methods and rates, and add the cost | `totals:fees` — a fee adjustment, `source: 'kempo-shipping'`, `taxable` as the method says |
| Know which lines need sending | `order:line_fulfillment` (it sets `pending` for physical products, `none` for credit packs and downloads) and the line's product |
| Mark things sent | `setLineFulfillment(order, line, 'done', { data: { shipmentId } })`, one call per shipment, so partial shipments work |
| Show tracking to the customer | `commerce-account-order-panels` fragment — **tracking is entirely its own** |
| Show a shipment panel to staff | `commerce-admin-order-panels` |
| React to a refund | `refund:issued` (cancel a label, hold a parcel) and `refund:before_approve` (warn that it already shipped) |
| Email the customer | `order:email_context` |
| Weight, dimensions | product fields in kempo-products; commerce passes the line's `productId` and `selections` |

Nothing in this extension stores a carrier, a tracking number or a rate.

## 21. Testing

Following the repository pattern: a **unit tier** on PGlite (`npm test`), an **integration tier** on
a real Postgres including a **Playwright browser suite** that builds a throwaway kempo site,
installs kempo-products, kempo-payments, kempo-credits, kempo-store-credit and this through kempo's
install route, and drives Chromium. Mutation-check the concurrency tests by removing the lock and the
guard.

- **Cart:** add/update/remove, merge on sign-in, each notice, limits, expiry sweep.
- **Totals:** discounts and fees via test hooks, inclusive and exclusive tax, rounding per line,
  currency change.
- **Checkout:** the full happy path with a card (Stripe test mode when keys are present; skipped with a
  message otherwise), **a zero-total path with store credit and no processor**, credits applied,
  declines and the cool-down, every failure mode in 8.4 with the process "dying" after each step.
- **Concurrency:** the last item bought by many at once; the same checkout key placed in parallel;
  webhook twice; two tabs.
- **Orders:** every allowed and refused status transition, events written, customer visibility.
- **Refunds:** preview numbers; the credits warning and both decisions; partial; to store credit;
  restock; a step failing mid-refund leaves `partially issued` and is completable; declined; withdrawn.
- **Pages:** every public page and admin page, the permission contract for every audience (visitor,
  customer, support, manager, administrator), the back button on every detail page, no console errors.
- **Mini-cart:** left and right, open on add, updates from another component, across tabs, keyboard
  and focus.
- **Declarations:** every permission checked is declared and enforced; every hook documented in the
  README; every setting declared and read; every index created; no HTTP code in `server/utils`.
- **Extensibility:** a fixture extension that adds a fee, a field, a tender and a panel, proving the
  contract in sections 14 and 15 from the outside.

## 22. Build order

Each milestone is releasable and tested on its own.

| # | Milestone | Needs |
|---|---|---|
| 0 | **kempo-products stock holds** (4.1) | upstream |
| 1 | Schema, settings, permissions; **carts** (server, SDK, API) with merge and notices; totals without tax | |
| 2 | **Orders** and the status machine, events, notes; the admin Orders list and Order page | |
| 3 | **Checkout with tenders**: store credit and credits, the **zero-total path**; the cart and checkout pages. *This is the first milestone a store owner can test end to end with no processor.* | kempo-store-credit |
| 4 | **Card payments** through kempo-payments: payment, webhook finish, expiry and recovery sweep; abuse limits | kempo-payments |
| 5 | **Tax** with kempo-tax, inclusive and exclusive | kempo-tax |
| 6 | **Order history** and the customer order page | |
| 7 | **Cancellation and refund requests**, the queue, the approval page, the credits warning, issue and partial states | |
| 8 | **Storefront**: shop, category, add-to-cart on product pages; category source interface | kempo-product-categories (optional) |
| 9 | **Mini-cart** and cart button, injection | |
| 10 | The remaining **hooks, fragments** and the fixture-extension test; README with the full hook table; dashboard widget; emails | |

## 23. Open questions

1. **Where do categories live?** kempo-products has types and tags, and the roadmap has
   kempo-product-categories as a separate optional extension. This plan has commerce read categories
   through an interface and fall back to types and tags. Confirm, or fold a simple category table
   into commerce.
2. **URLs.** Pages are under `/commerce/…` by kempo's public-scope rule. Do you want top-level aliases
   (`/shop/`, `/cart/`, `/checkout/`, `/account/orders/`) through a route-mapping setting?
3. **Guest checkout.** V1 requires an account (credits, store credit and abuse protection all assume
   one). WooCommerce allows guests. A setting that creates an account silently, or a signed order
   link, are the two ways to add it — which?
4. **Who owns the stock-holds change** and what is a hold's default lifetime? (Proposal: 15 minutes
   for card, `pending_expiry_minutes` for the order.)
5. **Order of credits and store credit.** The proposal is credits first, then store credit, then the
   card, because store credit is money and should not be "left over". Confirm.
6. **Partial refunds of discounts.** A coupon that took 10% off the order: a refund of one line
   returns that line's share of the discount (proposed). A fixed amount off the order is split
   proportionally by line total. Confirm.
7. **Refund to a different tender than was paid** (card money to store credit): allowed for
   administrators only, as proposed? Any limits?
8. **Email.** Does kempo have an email-sending SDK to build on, or does commerce need one added
   upstream first?
9. **Currency per order vs per site.** One currency per site is assumed. Multi-currency is out of scope
   unless wanted.
10. **Inventory deduction timing for kempo-products-inventory** (materials): it reacts to
    `purchase:recorded`, which now fires at `commitHold` — after payment. Confirm that is the right
    moment.

## 24. Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of kempo-credits (the most recent extension):

- `server/utils/**` is HTTP-agnostic and returns `[error, data]` tuples; it never throws.
- Routes are `public/api/**/[METHOD].js`; public scope `commerce`; admin pages under `admin/`.
- Custom elements are prefixed `k-com-`. Icons are `<k-icon>`. No custom CSS beyond what kempo-css
  utility classes cannot do. Edit `src/`, never `dist/`.
- A field's hint goes in a muted `<small>` **inside its label, above the input**; use `mb` classes so
  fields are not cramped; every detail view is a page of its own, so the address changes and the back
  button works; hints and notes written for the user, not the developer.
- Declare every setting in kempo-config.json and write them with their declared type and
  description. Idempotency indexes are created by hand in `install.js`; later-added columns too, with
  `IF NOT EXISTS`.
- Optional extensions are found with `getExtension` and imported on demand; never imported
  statically.
- Tests: `kempo-test`, PGlite for the unit tier, real Postgres and Playwright for the integration
  tier, mutation-checked concurrency tests, Stripe test mode only. No mocking.
- Update `README.md` and `CHANGELOG.md` with every behaviour change; document every hook.
- **Never** start, stop or restart a dev server the user owns; never commit a `file:` specifier.
