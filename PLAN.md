# kempo-commerce — PLAN

> Status: **not built.** This file is the brief and the running list of notes other extensions have
> left for it. Add to it whenever a decision or a gap turns up elsewhere that belongs here.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name is owned by the same
> person, and the goal is to keep improving all of them. If the work here needs a change in one of
> them, make it in that repository, with tests, README and CHANGELOG, backwards-compatible where
> others depend on it, and in dependency order when publishing. Never commit a `file:` specifier.

## What it is

The part of selling that none of the other extensions do: a **cart**, an **order**, a **checkout**
that turns one into the other and takes payment, and the screens to see and **refund** orders. The
target is parity with WooCommerce's core, built as small extensions around it.

It is deliberately not:

- the catalog — kempo-products (products, options, prices, stock, `recordPurchase`);
- the money movement — kempo-payments (Stripe payment intents, webhooks, refunds at the processor);
- tax rules — kempo-tax; the in-app currency — kempo-credits; the money balance a customer holds —
  kempo-store-credit.

## Dependencies

| | |
|---|---|
| **Hard** (`dependencies` in kempo-config.json) | kempo-products, kempo-payments |
| **Optional at runtime** (checked with `getExtension`, imported on demand, never statically) | kempo-tax, kempo-store-credit, kempo-credits |

An optional extension that is installed but disabled counts as absent.

## What already exists and is waiting for this

These are things that were built, or decided, elsewhere on the understanding that commerce would use
them. They are the first things to wire up.

### kempo-products
- `recordPurchase({ ref, lines, userId })` is **idempotent on `ref`**, takes stock all or nothing,
  and fires `kempo-products:purchase:recorded`. Use the **order id as `ref`** and always pass
  `userId`, or the credits a product gives are not granted (a purchase for nobody gives nothing).
- `reversePurchase(ref)` puts stock back and takes back the credits it gave. It has an admin
  **Reverse** button on the Purchases screen today. That button takes what it can and leaves the user
  *owing* the rest, without asking. **When commerce has refunds, that screen's reversal should defer
  to the refund approval below.**
- `getPrice(productId, selections)` is the only price a checkout may trust. It also returns
  `credits: { percent, perUnit, maxCredits, coveredMinor, remainingMinor }` for a product that
  accepts credits.
- A product has `creditsGranted`, `creditsOnly` (a credit pack: buying it gives credits and nothing
  else) and `creditPercent` (0 = credits cannot pay for it, 100 = entirely). `credits_per_unit` is
  how many credits equal one whole unit of the currency; credits round up, money rounds down.
- Product settings are at `/admin/extension/kempo-products/settings/`.

### kempo-credits (the in-app currency)
- **Spending is the checkout's job.** There is deliberately no route that spends credits.
  `spendCredits({ userId, amount, reason, reference, idempotencyKey })` is all or nothing (402);
  key it on the order. Undo a failed payment with `reverseSpend` under the same key.
- A **credit-only product** is how people buy credits; the grant happens in kempo-products'
  `recordPurchase`, so commerce does nothing extra beyond recording the purchase.
- Credits are **never refunded as money**, bought or not.

### kempo-store-credit (the money balance)
- `spendCredit({ userId, amount, partial: true, ... })` applies what is held up to the total and
  returns `shortfall` — what is left to charge the card. Undo with `reverseSpend` under the same key.
- `addCredit` is how a **refund to store credit** is made, keyed on the refund id.
- It follows kempo-products' currency. A balance in a currency the store no longer uses is kept but
  cannot be spent; the checkout must not try to.
- It is for testing too: an administrator can add credit to their own account and check out
  without a payment processor. A checkout whose total is covered by store credit must therefore
  work **with no payment intent at all**.

### kempo-payments
- `payment:refunding` is a guard hook (fires before a refund is sent to the processor, bail mode) and
  `payment:failed` fires on every decline. Both ship in kempo-payments 0.1.10.
- Webhooks are signed and are the only thing that should mark an order paid — never the browser.

## Checkout, in order

The sequence is fixed and each step is its own hook so extensions can take part, because money math
has to happen in a specific order and handlers run in registration order:

1. Price every line from `getPrice` (never from the browser).
2. Discounts (coupons — a later extension).
3. Tax — kempo-tax's `calculateTax` with the product's tax class and the buyer's address. **A tax
   failure stops the checkout**; charging no tax silently is worse than not charging.
4. Shipping (a later extension).
5. The order total.
6. Credits applied to products that accept them (each product's `maxCredits`; the buyer chooses how
   much, up to it). The credit amount reduces the money due by the product's `remainingMinor` logic.
7. Store credit applied last, up to what is still due (`partial: true`).
8. Charge the rest through kempo-payments. If nothing is left, there is no payment.
9. Create the order and `recordPurchase` it, under the same id.

**Open:** whether credits come before store credit or after, and how promo codes interact with
credits. Store credit last is the proposal because it is money and cannot be "left over".

**Every step that spends must be undone if a later one fails**, in reverse order, each under its own
idempotency key derived from the order id, so a retried checkout cannot spend twice or leave a
spend behind.

## Refunds

- Refunds are **approved by an administrator**, not automatic.
- Spent credits are **never refunded as money**. A product that gave credits and was refunded has
  those credits taken back — see the approval below.
- A refund can go back to the card (kempo-payments) or to **store credit** (`addCredit`).
- Partial refunds are worked out against what the buyer actually paid, line by line, so they never add
  up to more than the order took; tax is reversed with kempo-tax.

### The approval screen must warn about credits that are already spent

This is the case: someone buys an in-game item that comes with 500 credits, spends them on a second
item, then asks for a refund of the first. Taking the credits back leaves them with fewer than they
were given. The administrator who approves it should see that and decide, because it may be a scam
that deserves a ban or the second item removed.

- Before approving, call kempo-credits' **`previewClawBack({ reference })`** for the purchase's grant
  (`{ owner: 'kempo-products', ref: <purchase ref> }`). It returns `{ held, takeable, shortfall, ... }`
  without changing anything.
- If `shortfall > 0`, **stop and ask**: "They were given 500 credits and have already spent 200.
  Take back the 300 they hold and leave them at zero, or take all 500 and leave them owing 200?"
  plus a link to the buyer's credits history (`/admin/extension/kempo-credits/account/?user=<id>`)
  so the administrator can see what they spent it on.
- Then call `clawBackGrant({ reference, ifShort: 'zero' | 'owe' })`. `'owe'` leaves the balance
  negative, blocks spending until later credits cover it or an administrator writes it off, and
  notifies everyone who can see credits. `'zero'` takes what is held, leaves nobody owing and closes
  the grant.
- Nothing is silent either way: the choice and who made it belong on the order's history.

## Abuse protection

Carried over from the deleted kempo-credit-packs, because selling anything cheap to strangers invites
*card testing* — running stolen card numbers through a small checkout to see which work. Before a
payment reaches the processor:

- **Rate limits** per account, per IP address and site-wide, counted over the last hour, with
  defaults well above what a real buyer does (the packs used 10 / 20 / 500).
- **A decline cool-down.** After N declines (default 3) from one account or address within a window,
  further attempts are refused until it passes, and **the payment that hit the limit is cancelled at
  the processor** so no more cards can be tried against it from the browser. One decline and a retry
  is a customer and works.
- **Signed-in buyers only**, for an amount the server priced.
- **A log of every refused attempt** and a notification as the hour's count reaches 1, 10, 100…
- A `trust_proxy` setting: behind a proxy every buyer shares one address, so the first
  `X-Forwarded-For` hop must be used — but never when there is no proxy, since then the header is
  whatever the client sent.
- Counting declines needs kempo-payments ≥ 0.1.10, which reports every decline.

## Orders

- An order has an id (also the `recordPurchase` ref and the idempotency-key root), a buyer, lines as
  priced, the tax, the shipping, what was paid by each means (card, store credit, credits), a status
  and a history of what happened to it.
- **What the buyer was shown before paying is recorded** — the lines, prices, tax, total and the
  refund policy — because that is what answers a dispute.
- Statuses: pending payment, paid, fulfilled, cancelled, partially refunded, refunded. A payment
  that is never completed expires and its spends are reversed.

## Not in scope

- The catalog and its fields — kempo-products.
- Coupons, shipping, subscriptions, digital delivery, reviews — their own later extensions, hooked
  into the checkout sequence above.
- Selling credits as a separate extension: a credit pack is a **product**.

## Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of kempo-credits (the most recent extension):

- `server/utils/**` is HTTP-agnostic and returns `[error, data]` tuples; it never throws.
- Routes are `public/api/**/[METHOD].js`; public scope `commerce`; admin pages under `admin/`.
- Custom elements are prefixed `k-com-`. Icons are `<k-icon>`.
- Field hints go in a muted `<small>` inside the label, above the input; use `mb` classes for
  spacing; detail views are pages of their own so the back button works.
- Declare every setting in kempo-config.json. The unique idempotency indexes are created by hand in
  install.js (kempo's installer makes columns and primary keys only), and new columns on an existing
  table are added there too with `IF NOT EXISTS`.
- Tests: `kempo-test`, PGlite for the unit tier, a real Postgres and Playwright for the integration
  tier, mutation-checked concurrency tests. No mocking.
- Update README.md and CHANGELOG.md with every behaviour change.
- **Never** start, stop or restart a dev server the user owns.
