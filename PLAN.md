# kempo-commerce — PLAN

> Status: **built (see section 25), not yet committed or published.** Milestones 0 to 10 are implemented
> and tested. This document is the design; section 25 lists where the build differs from it and what is
> still to do. The README describes how it works now.

> **The yardstick is WooCommerce core.** Where this plan and WooCommerce's core behaviour differ, the
> default is to do what WooCommerce does. Section 23 records each decision made that way. Beyond Woo
> core, this plan adds only what kempo's own extensions require (tenders, the credits warning on
> refunds) and what guest checkout makes necessary (card-testing limits).
>
> **Out of scope:** discounts, coupons, sales and promotions (a later extension, plugged into the
> `totals:*` hooks); shipping; categories (a catalogue concern, owned entirely by kempo-products and
> its extensions; commerce neither stores nor requires them).

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
23. [Decisions, and what is left to verify](#23-decisions-and-what-is-left-to-verify)
24. [Conventions an agent must follow](#24-conventions-an-agent-must-follow)

---

## 1. What it is, and is not

**Is:** the part of selling that no other extension does.

- A **cart** that works for visitors and signed-in customers, and survives signing in.
- A **checkout**, for guests and signed-in customers, that prices the cart on the server, applies tax,
  store credit and credits, takes payment, and creates an **order**.
- **Orders**, with a status, a history of everything that happened to them, and notes.
- **Order history** for customers, who can cancel an order that is not yet paid. Guests reach their
  order through a signed link.
- **Refunds** issued by administrators from the order page, including the warning about credits that
  were already spent (section 10). Like WooCommerce, customers do not file refund requests.
- **Emails** through kempo's existing email system (section 9).
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
| Coupons, discounts, sales, promotions | kempo-coupons (later; plugs into the checkout hooks). **Nothing is built here.** |
| Subscriptions, digital delivery, reviews, wishlists | their own later extensions |
| Categories, tags, types, filtering | The catalogue (kempo-products and its extensions). Commerce has no knowledge of them. |
| Sending email, rendering templates | kempo core (`sendEmailFromTemplate`). Commerce only supplies templates and data. |

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
| **Optional at runtime** | kempo-tax, kempo-store-credit, kempo-credits, kempo-media (pictures) |

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
| `holdQuantity({ ref, lines, expiresInSeconds })` | Takes the stock (all or nothing, like `recordPurchase`) and records a **hold**. Nothing is granted and no purchase is recorded. |
| `commitHold(ref, { userId })` | Turns a hold into a recorded purchase: fires `purchase:recorded`, grants credits. Idempotent. |
| `releaseHold(ref)` | Returns the stock. Idempotent. Also what an expired hold does. |

A hold is a row, so a crash can be cleaned up by a sweep (`expireHolds`). `recordPurchase` stays as
it is for callers that do not need two phases (the admin's "record a sale made elsewhere").

`holdQuantity`, `commitHold` and `recordPurchase` must accept a **null `userId`** (a guest's purchase);
a product that grants credits cannot be bought by a guest, which is enforced by commerce (section 8.5)
and not here. Milestone 0 starts by checking what they do with null today.

Until this exists, commerce must not be built past the cart.

**kempo-inventory already has it.** Items there now have `quantity` (available) and `held`, with
`holdQuantity`, `releaseQuantity` and `consumeHeld` (all or nothing across several items, each a movement).
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
| `kempoCommerceOrder` | An order | `id`, `number` (human, sequential), `userId` (**null for a guest**), `email`, `orderKey` (random; the guest's access link), `status`, `currency`, `subtotal`, `feeTotal`, `taxTotal`, `total`, `paidTotal`, `refundedTotal`, `billing` (address), `shown` (what the customer was shown before paying), `data`, `cartId`, `checkoutKey`, `placedAt`, `paidAt`, `completedAt`, `cancelledAt` |
| `kempoCommerceOrderLine` | A line as sold | `orderId`, `productId`, `slug`, `name`, `selections`, `unitPrice`, `quantity`, `lineTotal`, `tax`, `fulfillment` (`none`, `pending`, `done`), `refundedQuantity`, `creditsGranted`, `data` |
| `kempoCommerceOrderAdjustment` | A fee, tax or (from a later extension) discount on an order | `orderId`, `lineId` (null for the whole order), `type` (`discount`, `fee`, `tax`), `code`, `label`, `amount` (signed), `source` (extension name), `data`. Commerce itself creates only `tax`; `fee` comes from shipping and similar, `discount` from the future coupons extension. |
| `kempoCommerceTender` | One way an order was (or is being) paid | `orderId`, `kind` (`card`, `store-credit`, `credits`, an extension's), `amount`, `status` (`pending`, `applied`, `reversed`, `refunded`), `reference` (payment id, entry id), `idempotencyKey`, `data` |
| `kempoCommerceEvent` | One thing that happened to an order | `orderId`, `type`, `actor` (user id or extension), `data`, `createdAt` — append-only |
| `kempoCommerceNote` | A note on an order | `orderId`, `authorId`, `body`, `visibleToCustomer`, `createdAt` |
| `kempoCommerceRefund` | A refund that was issued | `orderId`, `amount`, `lines` (line id → quantity), `reason`, `tenders` (how it was returned), `restock`, `credits` (`owe`/`zero`/none), `issuedBy`, `createdAt` |
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
                   cancelled    on_hold       refunded   (only when refunded in full)
```

These are WooCommerce's seven statuses. A **partial refund does not change the status**; it shows as
refund rows on the order and in `refundedTotal`, exactly as in WooCommerce.

| Status | Means |
|---|---|
| `pending_payment` | The order exists, stock is held, payment has not completed. Expires (setting), then becomes `failed` and everything is released. |
| `processing` | Paid, with something still to fulfil. |
| `completed` | Paid and every line is fulfilled or needs no fulfilment. A credit pack goes `pending_payment` → `completed`. |
| `on_hold` | An administrator, or an extension, has paused it. |
| `failed` | Payment failed or expired. Spends reversed, stock released. Terminal. |
| `cancelled` | Cancelled before it was paid, by the customer or an administrator. Terminal. |
| `refunded` | Refunded in full. Terminal. The order keeps its line fulfilment states. |

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
 discounts       = Σ adjustments of type discount                      (always 0 until a coupons extension exists)
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
   | 3 | `holdQuantity` for every line (section 4.1) | `releaseHold` |
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

A sweep runs every minute. **kempo has no scheduler today** (no recurring-job mechanism was found in
the core; only the realtime hub keeps timers), so milestone 0 either finds how extensions run
recurring work or adds that to kempo. The same mechanism runs the cart-expiry sweep:

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

### 8.5 Guests and accounts

Modelled on WooCommerce: a guest is **not a kempo user**. kempo needs no anonymous-login support for
this. The cart is a cookie token, and the order carries the email and an `orderKey`.

- **Guest checkout** is on by default (`guest_checkout`), as in WooCommerce. The checkout form asks for
  an email; when `allow_account_creation` is on there is a "Create an account" checkbox, and the
  account is created with a set-password email (needs kempo to create a user without a password; if it
  cannot, that is a small upstream addition).
- **Guests pay by card only.** Store credit and credits belong to an account, so those tenders are not
  offered to a guest.
- **A cart needs an account when it contains a product that grants credits** (a credit pack), because
  a guest cannot receive them. The checkout says why and offers sign-in or registration.
- **Order access.** A guest reaches their order through `/commerce/order/<id>/received/?key=<orderKey>`,
  shown after placing and sent in the confirmation email. The key is compared in constant time.
- **Linking.** When someone registers or signs in with an email that has guest orders, those orders
  are attached to the account **only once the email is verified**, as WooCommerce does.
- **Abuse protection** cannot lean on "signed-in only" any more: the per-IP limit and the decline
  cool-down (section 19) carry it.

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
session's user. A guest's order is reached only by its `orderKey` (section 8.5).

**Fulfilment.** Each line has `fulfillment`: `none`, `pending` or `done`. Commerce changes it only
through `setLineFulfillment`, called by whatever fulfils (shipping, digital delivery, an
administrator ticking a box). The order becomes `completed` when no line is `pending`. Commerce
itself does nothing physical.

**Emails and notifications.** Commerce uses the email system kempo already has:
`sendEmailFromTemplate({ to, subject, template, data })` from `kempo/sdk` (Resend today, other
providers later; commerce never names a provider). Commerce adds **templates and data, nothing else**.
The set is WooCommerce's: new order (to the administrator), order received / on-hold, processing,
completed, refunded (full or partial), failed, and a customer note. Administrators also get kempo
notifications for new orders and refunds left partially issued.

Each email is sent from the matching hook (section 14), with `order:email_context` letting other
extensions add to the data. A failed send is logged and recorded as an order event; it never fails
the order.

**Gap to fix upstream:** `sendEmailFromTemplate` finds a template only in the consumer's
`templates/emails` or kempo's own `app-templates/emails`, so an extension has no place to ship its
templates. Milestone 10 needs a small kempo change, for example extensions registering a template
directory that is searched between the two, backwards-compatible and with tests.

## 10. Cancellation and refunds

### 10.1 Principles

- **Refunds are issued by an administrator.** There is no automatic refund path for a paid
  order.
- **Spent credits are never refunded as money**, bought or earned.
- A refund goes back **to where the money came from, tender by tender**: card money to the card
  (kempo-payments), store credit to store credit (`addCredit`), credits to credits
  (`reverseSpend`). An administrator may choose to refund card money **to store credit** instead.
- A refund is for lines and quantities, or an amount, never more than was paid and not yet returned.

### 10.2 What a customer can do

WooCommerce's behaviour: a customer can **cancel an order that has not been paid** (`pending_payment`,
or `failed`), from their order page, immediately and without approval. Tenders are reversed and the
hold is released. There is **no refund or cancellation request** for a paid order: WooCommerce core has
none, and neither does this extension. The customer contacts the store, and an administrator issues the
refund from the order page. (A request workflow, if wanted later, is its own extension on the
`refund:*` hooks and `refundOrder`.)

### 10.3 What an administrator does

On the order page, **Refund** opens its own page (`.../refund/?order=`), as in WooCommerce: choose lines
and quantities or enter an amount, add a reason, and choose what happens. Issuing it runs this, in order:

1. **Preview.** Compute the refund: per line, the amount (unit price × quantity, plus its tax), and per
   tender how it will be returned. Show it, with a **restock** checkbox per line (default from a
   setting) and a destination choice for the card portion (card, or store credit).
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
   the refund, events, tender statuses, the order's `refundedTotal`, and the status (`refunded` only
   when the whole order has been refunded; otherwise unchanged).
4. **Email.** The customer gets the refund email.

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
`/checkout/`, `/account/orders/`) are provided the way WooCommerce provides `/cart`, `/checkout` and
`/my-account`: a route-mapping setting in kempo-server that maps a short address to the extension page
(an upstream change; section 23). The catalogue's own address (`/products/`) is kempo-products' business.

| Page | Route | What it is |
|---|---|---|
| **Product details** | `/products/<slug>/` (kempo-products' own page) | Not duplicated. Commerce fills the page's `actions` slot with **quantity, the options' validity, add to cart and a buy-now button**, shows stock/availability messages, and the credits lines products already shows. Related-products and reviews are fragments other extensions can fill. |
| **Cart** | `/commerce/cart/` | Lines with picture, name, selections, unit price, quantity stepper, remove, line total; notices; fee rows (when an extension adds any); subtotal; **proceed to checkout**; continue shopping (a link to the catalogue's own list page). Empty state. |
| **Checkout** | `/commerce/checkout/` | One page, in sections: contact and billing, extension fields, store credit and credits (when available), order review with the refund policy, payment. Shows a stable summary on the side. Handles the zero-total path. |
| **Order received** | `/commerce/order/<id>/received/` | The "thank you" page; a guest reaches it with `?key=<orderKey>`. After placing: status, what was paid, what happens next, credits granted. Polls until the payment is confirmed. |
| **Order history** | `/commerce/account/orders/` | Signed-in only. A list of the customer's orders with number, date, status, total, and a link. Paginated. |
| **Order details** | `/commerce/account/orders/<id>/` | Lines, adjustments, tax, tenders, status, the visible history and notes, and and the **action**: cancel (only while unpaid). |

**Add to cart** lives on the catalogue's pages, not on pages of commerce: kempo-products' list and detail
pages expose `products-list-extra` and the `actions` slot (section 4.2), and commerce fills them. Commerce has no
shop, category or search page and no knowledge of categories, tags or types.

**All pages** are server-checked, work without JavaScript for reading (cart contents, order list),
meet accessibility basics (labelled controls, announced updates with `aria-live`, focus management when
the mini-cart opens), and use only kempo-css utility classes.

## 12. The mini-cart

`<k-commerce-mini-cart>` — a cart that opens from the side without leaving the page.

```html
<script type="module" src="/commerce/components/MiniCart.js"></script>
<k-commerce-mini-cart></k-commerce-mini-cart>                   <!-- left, the default -->
<k-commerce-mini-cart side="right"></k-commerce-mini-cart>      <!-- right -->
```

- It is a **`k-aside`** (`side="right"` by default, `"left"` by attribute or the `mini_cart_side`
  setting; `main="overlay"`, `overlay-close`, `esc-close`). kempo-ui's aside already provides the
  panel, the overlay, focus capture, the `state` property (`offscreen` / `expanded`) and the
  `hide()`, `expand()` and `toggle()` methods; the mini-cart wraps it and does not reimplement any.
- It is opened by a **trigger**, `<k-commerce-cart-button>`: an icon button with an item-count badge, to
  put in a header. Any element can instead call `miniCart.open()`.
- **Contents:** lines (picture, name, selections, quantity stepper, remove, line total), notices,
  subtotal, **View cart** and **Checkout** buttons, and an empty state with a link to the shop. A
  loading state on every change; it shows the server's result, never an optimistic guess.
- **Opens on add** when `mini_cart_open_on_add` is on (off by default), so adding an item shows the cart.
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

All under the Admin → Commerce group (Orders, Carts), each its own page so the back button works; hints in labels; no inline
detail views.

| Screen | Route | For |
|---|---|---|
| **Orders** | `/admin/extension/kempo-commerce/` | List with search (number, name, email), status and date filters, totals, bulk status change. Opening one goes to its page. |
| **Order** | `.../order/?id=` | Everything on the order: lines, adjustments, tax, tenders, customer, history, notes, refunds; actions (change status, add note, **refund**, mark lines fulfilled, resend email). Extensions add panels through a fragment. |
| **Refund** | `.../refund/?order=` | Issue a refund (WooCommerce's refund screen): lines and quantities or an amount, a reason, destinations, restock, and the credits decision. |
| **Carts** | `.../carts/` | Open and abandoned carts (read-only), with their lines and when they were touched. |
| **Settings** | `.../settings/` | The settings in section 18, grouped, validated, with explanations, in the Settings nav group (the same pattern as Product Settings). |
| **Dashboard widget** | — | Orders and revenue today and this week, orders waiting (processing, on hold), with links. |

Admin notifications: a new order, a payment that arrived for an expired order, a
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
| `refund:before_issue` | guard | `{ order, refund, preview }` | **add warnings or blocks** the administrator must see (a fraud signal, a held shipment), or refuse |
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
| `cancelUnpaidOrder(id, { actor })` | What the customer's Cancel button and an administrator both call. |

### Refunds

| Function | Does |
|---|---|
| `previewRefund({ orderId, lines \| amount, restock, destination })` | The amounts per tender, per line, and **the credits warning** (`credits: [{ productId, given, held, shortfall, userId, historyUrl }]`). Changes nothing. |
| `refundOrder(orderId, { lines \| amount, destination, restock, credits, note, actor })` | Issues the refund. Refuses (409, `needsDecision: true`) if there is a credits shortfall and no `credits` decision. |

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
`getOrderByKey(id, key)` (a guest), `cancelOrder`. An error carries what the
route sent with it (`notices`, `balance` and `needed` on a refused tender, `retryAfter`).

| Element | Module | |
|---|---|---|
| `<k-commerce-add-to-cart>` | `components/AddToCart.js` | Quantity and the button; reads options from the page's `<k-products-detail>` via its `selection-change` event; disables with the reason; fires `cart-changed`. |
| `<k-commerce-cart-button>` | `components/CartButton.js` | The header trigger with the count badge; opens the mini-cart. |
| `<k-commerce-mini-cart>` | `components/MiniCart.js` | Section 12. |
| `<k-commerce-cart>` | `components/Cart.js` | The cart page's body. |
| `<k-commerce-checkout>` | `components/Checkout.js` | The checkout page's body. **Light DOM**, because kempo-payments' Stripe fields do not mount inside a shadow root, so nothing above it may be one either. |
| `<k-commerce-orders>`, `<k-commerce-order>` | `components/Orders.js`, `Order.js` | Order history and an order's page. |

**Events** (bubbling, composed): `cart-changed` `{ cart }`, `cart-line-added` `{ line }`,
`mini-cart-opened`, `mini-cart-closed`, `checkout-step` `{ step }`, `order-placed` `{ order }`,
`order-paid` `{ order }`. Following the project's rule: **methods
cause actions, events only say something happened.**

## 17. HTTP API

Under `/commerce/api`. `/my/` routes use the session only. Carts also accept the visitor cookie.

| Route | Who |
|---|---|
| `GET /cart`, `POST /cart/lines`, `PATCH /cart/lines/:id`, `DELETE /cart/lines/:id`, `DELETE /cart` | anyone (cart cookie) |
| `POST /cart/merge` | signed in (called on sign-in) |
| `GET /checkout`, `POST /checkout/validate`, `POST /checkout/place` | anyone with a cart (a guest needs an email; section 8.5) |
| `POST /checkout/orders/:id/confirm` | the order's owner, or a guest with its `orderKey` — asks the processor |
| `GET /my/orders`, `GET /my/orders/:id` | signed in |
| `GET /orders/:id/guest?key=` | a guest with the `orderKey` |
| `POST /my/orders/:id/cancel` | signed in, own, unpaid (a guest with the key may cancel too) |
| `GET /orders`, `GET /orders/:id`, `GET /orders/:id/events` | `commerce:orders:view` |
| `PATCH /orders/:id/status`, `POST /orders/:id/notes`, `PATCH /orders/:id/lines/:lineId` | `commerce:orders:manage` |
| `POST /refunds/preview` | `commerce:refunds:issue` |
| `POST /orders/:id/refund` | `commerce:refunds:issue` (and kempo-payments' `payments:refund` for card money) |
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
| `guest_checkout` | **on** | Allow checking out without an account (WooCommerce's default; section 8.5). |
| `allow_account_creation` | on | Offer "Create an account" on the checkout form. |
| `order_number_prefix`, `order_number_padding`, `order_number_start` | `#`, 0, 1000 | |
| `restock_on_refund` | on | The default for the restock checkbox. |
| `refund_policy` | text | Shown at checkout and stored with the order. |
| `address_aliases` | on | Map `/cart/`, `/checkout/`, `/account/orders/` to the extension pages. |
| `mini_cart_side` | `right` | `left` or `right`. |
| `mini_cart_open_on_add` / `mini_cart_inject` | off / on | |
| `mini_cart_hide_on_cart_pages` | on | |
| `purchase_limit_per_user`, `_per_ip`, `_global` | 10 / 20 / 500 | Checkout attempts per hour (section 19). |
| `failed_payment_limit`, `failed_payment_cooldown_minutes` | 3 / 60 | |
| `trust_proxy` | off | Take the address from `X-Forwarded-For`; only behind your own proxy. |

### Permissions

| Permission | Lets you |
|---|---|
| `commerce:orders:view` | See orders, carts, history |
| `commerce:orders:manage` | Change status, add notes, mark fulfilment |
| `commerce:refunds:issue` | Issue refunds (also needs `payments:refund` for card money) |
| `commerce:settings:manage` | Change settings |
| `commerce:checkout` | Check out. Held by `system:Users` from the first install, like a purchase permission, so a site can narrow it. |

Groups: `kempo-commerce:support` (view orders), `kempo-commerce:manager` (+ manage),
`kempo-commerce:administrator` (everything).

## 19. Abuse protection, security and concurrency

### Card testing

Selling cheap things to strangers invites *card testing*. Before a payment reaches the processor:

- **Rate limits** per account, per IP address and site-wide over the last hour (the settings above).
- **A decline cool-down.** After N declines from one account or address within a window, further
  attempts are refused until it passes, and **the payment that hit the limit is cancelled at the
  processor** so no more cards can be tried against it from the browser. One decline and a retry is a
  customer and works.
- **Guests are allowed** (section 8.5), so the limits below are the whole defence: a guest is limited
  by address and by email as well as site-wide.
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
| React to a refund | `refund:issued` (cancel a label, hold a parcel) and `refund:before_issue` (warn that it already shipped) |
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
- **Totals:** fees via test hooks, inclusive and exclusive tax, rounding per line,
  currency change.
- **Checkout:** the full happy path with a card (Stripe test mode when keys are present; skipped with a
  message otherwise), **a zero-total path with store credit and no processor**, credits applied,
  declines and the cool-down, every failure mode in 8.4 with the process "dying" after each step.
- **Concurrency:** the last item bought by many at once; the same checkout key placed in parallel;
  webhook twice; two tabs.
- **Orders:** every allowed and refused status transition, events written, customer visibility.
- **Refunds:** preview numbers; the credits warning and both decisions; partial; to store credit;
  restock; a step failing mid-refund leaves `partially issued` and is completable; a full refund sets `refunded`, a partial one leaves the status.
- **Guests:** checkout as a guest, access by `orderKey` (and a wrong key refused), a credits pack refused to a guest, linking on verified email, no store credit offered.
- **Emails:** each template renders and is sent through `sendEmailFromTemplate`; a failed send is an event and never fails the order.
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
| 7 | **Refunds**: the refund page, preview, the credits warning, issue and partial states, the refunded email | |
| 8 | **Add to cart** on the catalogue's list and detail pages (`products-list-extra`, `actions` slot); address aliases (upstream route mapping) | |
| 9 | **Mini-cart** and cart button, injection | |
| 10 | The remaining **hooks, fragments** and the fixture-extension test; README with the full hook table; dashboard widget; **emails** (templates, plus the upstream template-directory change in section 9) | kempo core email | |

## 23. Decisions, and what is left to verify

Each decision is "do what WooCommerce does" unless noted.

| Question | Decision |
|---|---|
| Guest checkout | **On by default**, optional account creation, access to an order by `orderKey`, orders linked to an account on verified email (section 8.5). Guests are not kempo users and kempo needs no anonymous login. |
| Account needed anyway | A cart containing a product that grants credits; any use of store credit or credits. |
| Customer cancel / refund requests | **None**, as in WooCommerce core. A customer cancels an unpaid order; an administrator issues refunds. A request workflow can be a later extension on the `refund:*` hooks. |
| Order statuses | WooCommerce's seven. No `partially_refunded`. |
| Refunds | An admin screen: lines or an amount, reason, restock, back to the original tenders. Beyond Woo, because kempo needs it: the credits warning, and an admin-only option to send card money to store credit. |
| Stock hold | One setting, `pending_expiry_minutes`, default 60. A cart holds nothing. |
| Stock deducted | At payment (`commitHold`), so kempo-products-inventory deducts materials then. |
| Currency | One per site. |
| Tender order | Credits, then store credit, then card. (Woo has no equivalent; wallet and gift-card plugins apply before the gateway.) |
| Categories, tags, types, shop and category pages | **Not commerce's concern.** Commerce has no shop page, no category page and no taxonomy interface. |
| Discounts, coupons, sales | **Not built.** The `totals:discounts` hook and the adjustment table stay as the seam for a later extension, which will also own how refunds split a discount. |
| Order numbers | Sequential, `#1042` (Woo uses the post id). |
| URLs | Short aliases (`/cart/`, `/checkout/`, `/account/orders/`) through a kempo-server route-mapping setting. |
| Email | kempo core's `sendEmailFromTemplate` (Resend today; other providers later). Commerce supplies templates and data only. |

### Still to verify or build upstream (milestone 0 and 10)

1. **kempo-products stock holds** (4.1), and that `recordPurchase`/`commitHold` accept a null `userId`.
2. **A scheduler.** None found in kempo core; the expiry and recovery sweeps need one (section 8.3).
3. **Extension email templates.** `sendEmailFromTemplate` does not search an extension's directory (section 9).
4. **Account creation without a password** plus a set-password email, for "Create an account" at checkout (section 8.5).
5. **Route aliases** in kempo-server (section 11).

## 24. Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of kempo-credits (the most recent extension):

- `server/utils/**` is HTTP-agnostic and returns `[error, data]` tuples; it never throws.
- Routes are `public/api/**/[METHOD].js`; public scope `commerce`; admin pages under `admin/`.
- Custom elements are prefixed `k-commerce-`. Icons are `<k-icon>`. No custom CSS beyond what kempo-css
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

## 25. As built

Everything in sections 5 to 22 was built, with these differences and additions. The README is the
reference for how it works now.

**Upstream work that was needed, all done and tested (uncommitted):**

- **kempo-products**: stock holds (`holdQuantity`, `commitHold`, `releaseHold`, `expireHolds`, `getHold`,
  `getHolds`, `getHeldQuantities`, a `kempoProductHold` table, three hold events), `reversePurchase` takes
  `takeBackCredits: false`, and `registerProductAction` (a way for an extension to put a control on every
  product card and product page; section 4.2's "slots already exist" was wrong, because nothing could fill them).
- **kempo-products-inventory**: holds reserve materials in kempo-inventory's held stock, and a purchase
  that came from a hold does not take its materials twice.
- **kempo (core)**: a scheduler (`jobs` in kempo-config.json, a `scheduledJob` table with a lease, started by the
  middleware; sites need `drizzle-kit push`), `aliases` (short addresses that never replace a site's own page),
  extension email templates (`owner/name`, overridable by the site) and `renderEmailTemplate`, the
  `user:email_verified` hook, `requestPasswordReset({ subject, template })`, and the cart, remove and
  open-in-new icons. Email itself already existed (`sendEmailFromTemplate`, Resend), which this plan first
  wrongly said it did not.

**Design differences:**

- **No advisory locks.** Every race is settled by a conditional update: the cart is claimed (`checkout`
  status) while an order is placed, a status moves only from the status that was read, a refund reserves
  money and line quantities in one transaction that cannot exceed what was paid. PGlite serialises
  transactions, so the concurrency suites also run on a real Postgres (the integration tier).
- **The stock is held before the order is created**, so a refused hold leaves no order at all.
- **A new checkout from the same cart replaces the earlier unpaid order.**
- **No customer refund or cancellation requests, no `partially_refunded` status, no shop or category pages,
  no discounts, no categories** (sections 10, 11 and 23 above are updated to say so). The `totals:discounts` hook
  and the adjustment table remain as the seam for a coupons extension.
- **Credits are refunded as a new grant** (so a partial refund works), store credit through `addCredit`, and the
  card through kempo-payments. Refunding the whole order and restocking all of it reverses the purchase
  (without taking credits back twice).
- **Refund amount by free amount** takes back credits in proportion to the money returned.
- The `address_aliases` setting of section 18 was dropped: an alias simply never replaces a page the site has.
- The mini-cart's placement is a script that puts the button in the site's `nav` (beside the account link), not
  a template location, because kempo's default template has none for it.
- Fragments for `commerce-checkout-sections` and `commerce-checkout-summary-extra` were not built: the checkout is
  a light-DOM component, and `checkout:fields` covers what they were for.

**Not verified, and why:**

- **A real Stripe payment.** `stripe.node-test.js` does it in test mode and reports itself skipped without
  `STRIPE_TEST_SECRET_KEY`. In the other suites the card is a stand-in for contacting Stripe only (payments
  are real rows read through kempo-payments' own SDK).
- **Tax in a browser.** Tax is covered by `tax.node-test.js` (exclusive and inclusive prices, the sale
  recorded when paid, a refund reversing its share); it is not looked at in a browser yet.
- **Mobile layouts and Safari/Firefox.** Everything was looked at in Chrome at desktop width.

**Still to do:** commit and publish (nothing is committed in any repository), `npm run build` in kempo so
`dist/` carries the three new icons from `src/` (they were also copied into `dist/` so a running site shows them),
a kempo-products release carrying the holds before commerce's `kempo-products >= 0.1.8` peer is true, and kempo
releases carrying the scheduler and the rest before commerce's `kempo >= 4.6.3` peer is true.
