# Changelog

All notable changes to `kempo-commerce` are documented in this file.

## [Unreleased]

### Added (discounts)

- **Discounts from other extensions combine on one rule.** A `totals:discounts` handler can push a row that says what it is, `data: { kind: 'fixed' | 'percent', value, stackable }` with a `lineId`, and leave out the amount. Commerce works out each row's amount per line: combinable discounts apply together (fixed amounts first, then the added percents off what is left), one that cannot be combined applies alone, the line gets whichever saves more, and the price never goes below the product's minimum price. `resolveUnitDiscounts` and `resolveDiscountRows` are exported. Rows that already carry an `amount` and no `kind` are unchanged.
- **The minimum price** (kempo-products `minimumPrice`) is carried onto each cart line, and a line held back by it tells the cart, which shows the new `price_floor_notice` setting under the totals.
- The cart shows one row per kind of discount or fee, adding up what it took across the lines.

### Fixed (discounts)

- **A discount on a line stays against that line on the order** (it was stored against no line, so tax and refunds could not tell which line it belonged to), and **a refund of a line returns what was paid for it**, after its discounts, not its full price.

### Changed (breaking)

- **Quantity goes through kempo-products' ledger, and credits are granted here.** kempo-products no longer has purchases or holds, so placing an order takes its quantity as one ledger entry (`order:<id>`, every line or none), and an order that fails, expires or is cancelled adds the entry that undoes it, but only after the order itself has become `failed` or `cancelled`, so an order that was paid in the meantime never loses its quantity. Completing an order claims it as paid first (only one run can), then grants the credits its products give, once, as kempo-commerce under the order's id (it was kempo-products, so credits given to orders placed before this are not found when such an order is refunded). Refunding a whole order and restocking adds one entry that undoes the order's. The recovery sweep no longer expires holds, because there are none. The price check at the moment of taking quantity is gone: the cart is priced and checked a moment earlier, and reports a changed price or an unavailable product to the customer as a notice.

### Added

- **A "View cart" button on the add confirmation**, with a setting (`add_to_cart_toast_action`, in Commerce Settings) for what it does: open the mini-cart (the default, and the cart page when the page has no mini-cart), go to the cart page, or not be shown.

### Changed

- **Its icons ship with it**, used by path instead of by name from kempo's shared set: the cart, add-to-cart, checkout, remove and options glyphs the storefront draws are in `public/icons/` (served at `/commerce/icons/`, so they work on the live site), and the Orders glyph is in `admin/icons/`, used by the menu entry, the dashboard widget and its button (dashboard widgets now take `iconSrc`). The Cart item offered to menus names its icon with the new `icon-src` attribute.
- **The cart button is a link.** The Cart menu item is now `<a href="/cart/"><k-commerce-cart-button></k-commerce-cart-button></a>` instead of a button inside a shadow root. The link is an ordinary child of the nav, so it gets the nav's link styling (padding, theme link colour, hover, focus) the same as the account link, with nothing hard-coded, and it goes to the cart page before any script has loaded. `<k-commerce-cart-button>` finds the link around it with `closest('a')` and, on a plain click, opens the mini-cart instead; a Ctrl, Cmd, Shift or middle click, or a page with no mini-cart, follows the link. On its own, outside a link, it draws its own. Menus keep a copy of an extension's item, so an existing site picks the new markup up the next time its extensions change or its menu is edited.
- **The mini-cart no longer opens when something is added, unless the site turns it on.** `mini_cart_open_on_add` now defaults to off (it was on). A toast confirms the add and the cart is one click away. A site that already installed keeps the value it has; turn it off in Commerce Settings, or on to keep the old behaviour for new sites.
- **Adding to the cart is confirmed by a toast that names the product** ("Added **Starter credits** to your cart", or "Added 3 × …"), at the bottom centre so it does not cover the mini-cart that opens on the right,, instead of a message shown in the page under the button. The name is escaped, since a toast sets its text as HTML. A failed add still shows its reason under the button.
- **"Add to cart" on products is injected by composition, not registered from a script.** `public/product-actions.global.html` fills kempo-products' `products-card-actions`, `products-detail-actions` and `products-scripts` locations; `<k-commerce-add-to-cart>` finds its card (`closest('k-products-card')`, using the product the list already loaded) or product page (`closest('k-products-detail')`, following its `selection-change`). It no longer calls `registerProductAction`, and the storefront script no longer loads it on every page: it loads on product pages only. Needs the kempo-products release with the locations.
- **The cart button is a menu item, not a script's guess.** It is no longer put into the navigation by JavaScript beside the account link. It is offered to kempo's Menus page as **Cart**: Admin → Content → Menus, **Add item** on the navigation, choose Cart. It is then placed, ordered, hidden and removed like any other link, and leaves the site if this extension is disabled. The mini-cart is still placed on every page by `mini_cart_inject`. Needs a kempo with menu items (a `*.menu-item.html` file in an extension's `public/`).
- The admin menu is four groups, in this order: **Commerce** (Orders, Carts, Shipping, Tax, Commerce Settings), **Products**, **Payments** and **Marketing**. Shipping, Sales and Discounts, Coupons and Affiliates are not here: each is its own extension (kempo-shipping, kempo-discounts, kempo-coupons, kempo-affiliates), not built yet, which for now only reserve their menu entry and a "coming soon" page.

First release.

Carts, orders, checkout and refunds for kempo, modelled on WooCommerce's core.

### Cart

- Two quantity pickers built for the shop: `<k-commerce-cart-qty>` (mini-cart and cart page) and `<k-commerce-add-qty>` (the product page), one bordered control with a "-" button, a number you can type into and a "+" button, a whole number from 1 with no maximum. In the cart the "-" turns into the remove-from-cart icon at 1 (typing 0 removes the line too); on the product page it is disabled at 1.
- A cart for visitors (a random token in an httpOnly cookie, stored hashed) and customers, merged when someone signs in. Every read prices it again from the catalogue and reports notices (price changed, less stock than asked for, product no longer for sale, option unavailable, quantity limit) rather than fixing anything silently. Nothing is reserved by a cart.
- "Add to cart" on every product card and product page through kempo-products' product-card and product-page locations, a mini-cart (`<k-commerce-mini-cart>`, a `k-aside`) and a cart button put on every public page, the cart page, `/cart/`.

### Checkout and orders

- **Order history is linked from the account page**, and the page is called **Order history** with a button back to the account. The link is added to the account page's `account-links` place (a site whose account page predates it needs that `<location>` added).
- **Tax asks for what it needs, and says so before it complains.** The server tells the page what the address must have for tax: a state or province in the United States and Canada (where the tax is set by it) and a postal code in the United States (where the provider refuses without one). Those fields are marked required, the tax row says "Enter your address to calculate", and the provider is not asked until the address is complete, so a half-filled address no longer shows the provider's own error. Placing an order with them missing is refused with a plain message. Anywhere else the country is enough.
- **Place order stays disabled until everything required is filled in**: name, email, country, the state and postal code tax needs, the extensions' required fields and the card. A line under the button says what is still missing.
- A tax failure now reads "Tax could not be calculated", and "worked out" is gone from the wording.
- **Country and state are pickers.** Country is a list of every country, named in the visitor's language; choosing one fills the state or region list with that country's own (the 50 states and DC, the Canadian provinces, the German Länder, ...), and a country with none listed gets a text box. The state is stored as its code (`VT`), which is what tax and the processors expect, and the server refuses a country or a state that is not on the lists, so an API call cannot store something that is not a place. An address saved before this (a typed "Vermont") is fitted to the lists when it prefills. The data is ISO 3166 (MIT, from `iso3166-2-db`), built by `scripts/build-regions.js` into `server/data/regions.json`, and served at `GET /commerce/api/regions`.
- **Leaving checkout is never blocked.** A **Back to cart** button sits beside the title, the full site navigation stays, and the side cart now works on the checkout page (it used to be hidden there, leaving its button doing nothing). Changing or removing an item in it updates the checkout, keeping what has been typed. `mini_cart_hide_on_cart_pages` now hides it only on the cart page, which shows the same thing; the nav button goes to the cart page when there is no side cart to open.
- The order summary is headed **Cart totals**.
- **Everything on one page.** The checkout no longer has a second payment page. A **Payment** section at the bottom of the form has a store credit amount to use, a credits amount to use, and the card for what is left (shown only when something is left), and **Place order** makes the order, makes the payment and charges the card in one step. A declined card leaves the order saved and the form there to try again. The card fields are kempo-payments' `<k-pay-form deferred>`, so this needs `kempo-payments >=0.3.0`.
- **Extensions can add to the checkout page** with `registerCheckoutSection(tag, { where })` from `/commerce/components/checkoutSections.js` (`details`, `payment` or `summary`); the element is handed the page to read the quote, ask for new totals and add data to the order.
- The checkout form starts filled in for a signed-in customer: their name and email from the account, and the phone and address from their last order. The account wins over the last order for the name (an order can be a gift), only blanks are filled, and a guest starts with an empty form.
- Checkout for guests (on by default) and signed-in customers, with an optional account step that is required when the cart has credits for sale. Prices on the server, one `placeOrder` call that is idempotent on a checkout key, stock held through kempo-products' stock holds, then credits, store credit and the card taken as **tenders** with a full undo on any failure. An order covered by store credit and credits needs no payment processor.
- WooCommerce's seven order statuses, an append-only history, notes (private or shown to the customer), per-line fulfilment, sequential order numbers, and what the customer was shown kept with the order. A guest reaches their order with the key in their link, and guest orders join an account when its email is verified.
- Tax through kempo-tax, with inclusive and exclusive prices. Completing is idempotent and safe to run any number of times at once; a payment that arrives after the order expired is refunded automatically.
- A recovery sweep every minute through kempo's scheduler, rate limits and a decline cool-down against card testing, and emails (processing, completed, on hold, failed, cancelled, refunded, part refunded, note, set password) through kempo's email system.

### Refunds

- Issued by an administrator by lines or amount, tender by tender, with restock, tax reversal, and a **warning when the customer already spent credits** the refund takes back (leave them at zero or owing). A refund that fails partway is left partial and can be finished.

### Extending

- 32 hooks, a server SDK, a browser SDK, `registerTender`, fragments for other extensions, a dashboard widget and admin pages for orders, refunds, carts and settings.
