import LightComponent from '/kempo-ui/components/LightComponent.js';
import { html, staticHtml, unsafeStatic, keyed, nothing, live } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Accordion.js';
import Toast from '/kempo-ui/components/Toast.js';
import '/payments/components/PaymentForm.js';
import { startCheckout, validateCheckout, placeOrder, confirmPayment, getRegions, onCartChanged, newKey } from '/commerce/sdk.js';
import { loadFormat, optionsText, itemNames } from '/commerce/utils/format.js';
import { toMinor, fromMinor, toCount, clamp } from '/commerce/utils/amount.js';
import { countryOptions, subdivisionOptions } from '/commerce/utils/regions.js';
import { checkoutSections } from '/commerce/components/checkoutSections.js';

/* A table with no header row has no top border or rounded top corners of its own, so its first row draws them. */
const TOP_LEFT = 'border-top: 1px solid var(--c_border); border-top-left-radius: var(--radius);';
const TOP_RIGHT = 'border-top: 1px solid var(--c_border); border-top-right-radius: var(--radius);';

/*
  The checkout page's body, served at /commerce/components/Checkout.js.

  ```html
  <script type="module" src="/commerce/components/Checkout.js"></script>
  <k-commerce-checkout></k-commerce-checkout>
  ```

  One page, one button. Down the left, an accordion of panels, one open at a time: **Contact** (who you are,
  an account if one is wanted, and the fields extensions asked for), **Billing address** (where, which sets
  the tax), **Store credit and credits** (when the customer has either), and **Payment** (the card for
  whatever is left). Extensions add panels of their own, a shipping address for one, by priority. On the
  right: the order, the refund policy, anything an extension puts under the summary, and the button.

  Placing the order makes it, makes the card payment, and charges the card in the same press. A card
  that is declined leaves the order saved with the form still in front of you, to try again.

  **Other extensions** add to the page with `registerCheckoutSection` (checkoutSections.js). See that file.

  **Light DOM, on purpose.** Stripe's card fields do not mount inside a shadow root (they reserve the
  space and draw nothing), so the payment form, and everything around it, is light DOM.

  The totals are the server's. Changing the address (tax) or the credit used asks the server again,
  and placing the order sends the total that was shown, so a total that moved is refused and shown
  instead of being charged. The checkout key is kept for as long as the cart's contents are the same,
  so a reload, a double click or a second tab returns the order that was already made and never a
  second one. The card is only ever believed through the server asking the processor.
*/

const SIGNATURE = cart => cart.lines.map(line => `${line.productId}:${line.quantity}:${JSON.stringify(line.selections)}`).join('|');

const keyFor = cart => {
  try {
    const saved = JSON.parse(sessionStorage.getItem('kempo-commerce-checkout') || 'null');
    if(saved?.signature === SIGNATURE(cart) && saved.cartId === cart.id) return saved.key;
    const created = { signature: SIGNATURE(cart), cartId: cart.id, key: newKey() };
    sessionStorage.setItem('kempo-commerce-checkout', JSON.stringify(created));
    return created.key;
  } catch {
    return newKey();
  }
};

export default class Checkout extends LightComponent {
  static properties = {
    quote: { state: true },
    form: { state: true },
    storeCredit: { state: true },
    creditsUsed: { state: true },
    createAccount: { state: true },
    extra: { state: true },
    errors: { state: true },
    error: { state: true },
    busy: { state: true },
    finished: { state: true },
    pricing: { state: true },
    placed: { state: true },
    regions: { state: true },
  };

  constructor(){
    super();
    this.quote = null;
    this.form = { name: '', email: '', phone: '', line1: '', line2: '', city: '', state: '', postalCode: '', country: '' };
    this.storeCredit = 0;
    this.creditsUsed = 0;
    this.createAccount = false;
    this.extra = {};
    this.errors = {};
    this.error = '';
    this.busy = false;
    this.finished = false;
    this.pricing = false;
    this.placed = null;
    this.regions = null;
    this.decimals = 2;
    this.money = minor => String(minor);
    this.priceRequest = 0;
    this.timer = null;
    this.completed = new Set();
    this.visited = new Set();
    this.userOpened = new Set();
    this.automating = false;
    this.initialized = false;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    window.addEventListener('checkout-sections-changed', this.refreshSections);
    this.stopListening = onCartChanged(() => this.refresh());
    this.start();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    window.removeEventListener('checkout-sections-changed', this.refreshSections);
    this.stopListening?.();
  }

  updated(){
    super.updated();
    this.settle();
    /* The sections read `checkout.quote` (the shipping choices), so they draw again whenever the page does. */
    for(const { tag } of [...checkoutSections('panel'), ...checkoutSections('summary')]) this.querySelectorAll(tag).forEach($section => $section.requestUpdate?.());
  }

  refreshSections = () => this.requestUpdate();

  start = async () => {
    const format = await loadFormat();
    this.money = format.money;
    this.decimals = format.config.decimals ?? 2;
    /* The pickers fill in when the lists arrive; until then, or if they never do, the fields are plain text. */
    getRegions().then(([, regions]) => { this.regions = regions; });
    const [error, data] = await startCheckout();
    if(error){
      this.error = error.msg;
      this.quote = { empty: true, notices: error.notices ?? [] };
      return;
    }
    this.quote = data.quote;
    /* The form is still empty here, so what the shop already knows only fills in blanks. */
    this.form = { ...this.form, ...Object.fromEntries(Object.entries(data.prefill ?? {}).filter(([name]) => !this.form[name])) };
    this.storeCredit = this.offer('store-credit')?.max ?? 0;
    if(data.quote.account.required) this.createAccount = true;
    this.reprice();
  };

  /*
    The cart changed somewhere else on the page (the side cart): take its lines again and price them, keeping
    what has been typed here. A cart that is now empty shows the empty page; one that was empty starts over.
  */
  refresh = async () => {
    if(!this.quote || this.placed) return;
    if(this.quote.empty) return this.start();
    const [error, data] = await startCheckout();
    if(error){
      this.error = error.msg;
      this.quote = { empty: true, notices: error.notices ?? [] };
      return;
    }
    this.quote = data.quote;
    this.creditsUsed = clamp(this.creditsUsed, this.creditsCap);
    this.storeCredit = clamp(this.storeCredit, this.storeCap);
    this.reprice();
  };

  /*
    Public methods, for the sections other extensions add
  */

  /* Asks the server for the totals with this address and these tenders. */
  reprice = async () => {
    if(!this.quote || this.quote.empty) return;
    const request = ++this.priceRequest;
    this.pricing = true;
    const [error, data] = await validateCheckout({ billing: this.form, data: this.extra, tenders: this.tenders });
    if(request !== this.priceRequest) return;
    this.pricing = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.quote = data.quote;
  };

  /* A value sent with the order as `data`, for the `checkout:validate` guard on the server. */
  setData = (key, value) => {
    this.extra = { ...this.extra, [key]: value };
  };

  /*
    What can be used
  */

  offer(kind){
    return this.quote?.tenders?.find(offer => offer.kind === kind) ?? null;
  }

  /* The money credits cover, as the server works it out. */
  creditsMinor(count){
    const offer = this.offer('credits');
    return offer ? Math.min(Math.floor(count * 10 ** this.decimals / offer.detail.perUnit), offer.max) : 0;
  }

  /* The most credits that can be asked for: what is held, what the cart lets them pay, what is due. */
  get creditsCap(){
    const offer = this.offer('credits');
    return offer ? Math.min(offer.detail.maxCredits, Math.floor(offer.max * offer.detail.perUnit / 10 ** this.decimals)) : 0;
  }

  /* The most store credit that can be used: what is held and what is still due after credits. */
  get storeCap(){
    const offer = this.offer('store-credit');
    if(!offer) return 0;
    return Math.max(0, Math.min(offer.max, this.quote.totals.total - this.creditsMinor(Math.min(this.creditsUsed, this.creditsCap))));
  }

  get tenders(){
    const tenders = {};
    const credits = Math.min(this.creditsUsed, this.creditsCap);
    if(credits > 0) tenders.credits = credits;
    const store = Math.min(this.storeCredit, this.storeCap);
    if(store > 0) tenders['store-credit'] = store;
    return tenders;
  }

  get language(){
    return navigator.language || 'en';
  }

  get stateOptions(){
    return subdivisionOptions(this.regions, this.form.country, this.language);
  }

  /*
    What the customer still has to give before the order can be placed, as words for the hint under the
    button. The server decides what tax needs (`quote.required`); the rest is who they are, what extensions
    asked for, and a card when one is needed.
  */
  get missing(){
    const { quote, form } = this;
    if(!quote || quote.empty) return [];
    const need = quote.required ?? {};
    const missing = [];
    if(!form.name?.trim()) missing.push('your name');
    if(!quote.account.signedIn && !form.email?.trim()) missing.push('your email');
    if(need.country && !form.country) missing.push('your country');
    if(need.state && this.stateOptions.length && !form.state) missing.push('your state or region');
    if(need.postalCode && !form.postalCode?.trim()) missing.push('your postal code');
    for(const field of quote.fields) if(field.required && !this.extra[field.key]) missing.push(field.label.toLowerCase());
    if(this.needsCard && !this.payForm?.complete) missing.push('your card details');
    return missing;
  }

  /* What a section says keeps the order from being placed at all (shipping that cannot be priced), or '' when nothing does. */
  get blocker(){
    for(const { tag } of [...checkoutSections('panel'), ...checkoutSections('summary')]){
      const reason = this.querySelector(tag)?.blocker;
      if(reason) return reason;
    }
    return '';
  }

  get needsCard(){
    return Boolean(this.quote?.plan?.some(entry => entry.kind === 'card'));
  }

  get payForm(){
    return this.querySelector('k-pay-form');
  }

  /*
    Event handlers
  */

  type = (name, event) => {
    this.form = { ...this.form, [name]: event.target.value };
    if(['country', 'state', 'postalCode', 'city'].includes(name)) this.schedulePricing();
  };

  /* A picker: choosing a country clears a state that is not one of its states, and asks for the tax again. */
  pick = (name, event) => {
    const value = event.target.value;
    const next = { ...this.form, [name]: value };
    if(name === 'country' && !subdivisionOptions(this.regions, value).some(state => state.code === next.state)) next.state = '';
    this.form = next;
    this.reprice();
  };

  typeExtra = (name, event) => {
    this.setData(name, event.target.type === 'checkbox' ? event.target.checked : event.target.value);
  };

  setStoreCredit = event => {
    const entered = toMinor(event.target.value, this.decimals);
    this.storeCredit = clamp(entered ?? 0, this.storeCap);
    event.target.value = fromMinor(this.storeCredit, this.decimals);
    this.reprice();
  };

  setCredits = event => {
    const entered = toCount(event.target.value);
    this.creditsUsed = clamp(entered ?? 0, this.creditsCap);
    event.target.value = String(this.creditsUsed);
    this.storeCredit = clamp(this.storeCredit, this.storeCap);
    this.reprice();
  };

  schedulePricing = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.reprice, 400);
  };

  place = async event => {
    event.preventDefault();
    const { quote } = this;
    if(this.blocker){
      this.error = this.blocker;
      return;
    }
    if(this.needsCard && !this.payForm?.complete){
      this.error = 'Enter your card details to place the order.';
      return;
    }

    this.busy = true;
    this.error = '';
    this.errors = {};
    const [error, data] = await placeOrder({
      checkoutKey: keyFor(quote.cart),
      billing: this.form,
      data: this.extra,
      tenders: this.tenders,
      account: this.createAccount && !quote.account.signedIn ? { create: true } : null,
      expectedTotal: quote.totals.total,
    });

    if(error){
      this.busy = false;
      if(error.totals) this.quote = { ...quote, totals: error.totals };
      this.error = error.code === 429 && error.retryAfter ? `${error.msg} (try again in ${Math.ceil(error.retryAfter / 60)} minutes)` : error.msg;
      if(error.errors) this.errors = Object.fromEntries(error.errors.map(entry => [entry.field, entry.msg]));
      if(error.existing) this.error = `${error.msg} `;
      return;
    }

    this.placed = data;
    if(data.payment) await this.pay(data);
    else this.finish(data.receivedUrl, false);
  };

  /*
    The order and its payment exist; charge the card on this page. A decline leaves the order saved and
    the form here, so the next press is another try at the same order. The browser saying it worked is
    never believed on its own: the server asks the processor.
  */
  pay = async data => {
    const { error, paymentIntent } = await this.payForm.confirm({ clientSecret: data.payment.clientSecret });
    if(error){
      this.busy = false;
      this.error = `${error.message || 'The payment could not be completed.'} Your order is saved. Check your card details and try again.`;
      return;
    }
    if(paymentIntent?.status !== 'processing'){
      const key = new URL(data.receivedUrl, location.origin).searchParams.get('key');
      await confirmPayment(data.order.id, key);
    }
    this.finish(data.receivedUrl, true);
  };

  /*
    The order is placed (and paid, when a card was needed). The form is locked so nothing can be changed or sent twice,
    and a toast says so with a way to the order. Closing the toast for any reason, its button or its ten seconds running
    out, goes to the order, once.
  */
  finish = (url, paid) => {
    try {
      sessionStorage.removeItem('kempo-commerce-checkout');
    } catch { /* storage may be blocked; the next checkout simply makes a new key */ }
    this.busy = true;
    this.finished = true;
    let left = false;
    const go = () => {
      if(left) return;
      left = true;
      location.href = url;
    };
    Toast.success(paid ? 'Payment complete. Your order is placed.' : 'Your order is placed.', { timeout: 10000, action: 'View order', actionCallback: go, closeCallback: go });
  };

  /*
    Rendering
  */

  field(name, label, { type = 'text', required = false, hint = '', autocomplete = '' } = {}){
    return html`
      <label class="mb">
        ${label}${required ? html` <span class="tc-danger" aria-hidden="true">*</span>` : nothing}
        ${hint ? html`<small class="tc-muted d-b">${hint}</small>` : nothing}
        <input type=${type} .value=${this.form[name] ?? ''} ?required=${required} autocomplete=${autocomplete || 'off'} @input=${event => this.type(name, event)}>
        ${this.errors[name] ? html`<small class="tc-danger d-b">${this.errors[name]}</small>` : nothing}
      </label>
    `;
  }

  select(name, label, options, { required = false, hint = '', autocomplete = '', placeholder = '' } = {}){
    return html`
      <label class="mb">
        ${label}${required ? html` <span class="tc-danger" aria-hidden="true">*</span>` : nothing}
        ${hint ? html`<small class="tc-muted d-b">${hint}</small>` : nothing}
        <select ?required=${required} autocomplete=${autocomplete || 'off'} @change=${event => this.pick(name, event)}>
          <option value="" ?selected=${!this.form[name]}>${placeholder}</option>
          ${options.map(option => html`<option value=${option.code} ?selected=${option.code === this.form[name]}>${option.name}</option>`)}
        </select>
        ${this.errors[name] ? html`<small class="tc-danger d-b">${this.errors[name]}</small>` : nothing}
      </label>
    `;
  }

  renderExtraField(field){
    if(field.type === 'checkbox') return html`<label class="checkbox mb"><input type="checkbox" .checked=${Boolean(this.extra[field.key])} @change=${event => this.typeExtra(field.key, event)}> ${field.label}</label>`;
    if(field.type === 'select') return html`<label class="mb">${field.label}<select @change=${event => this.typeExtra(field.key, event)}>${(field.options ?? []).map(option => html`<option value=${option.value ?? option}>${option.label ?? option}</option>`)}</select></label>`;
    return html`<label class="mb">${field.label}${field.hint ? html`<small class="tc-muted d-b">${field.hint}</small>` : nothing}<input type=${field.type || 'text'} ?required=${field.required} @input=${event => this.typeExtra(field.key, event)}></label>`;
  }

  renderSummary(){
    const { quote } = this;
    const { totals } = quote;
    return html`
      <h2 class="h4">Cart totals</h2>
      <table class="mb">
        <tbody>
          ${quote.cart.lines.map((line, index) => html`<tr><td style=${index === 0 ? TOP_LEFT : nothing}>${line.name} <span class="tc-muted">× ${line.quantity}</span>${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}</td><td class="ta-right" style=${index === 0 ? TOP_RIGHT : nothing}>${this.money(line.lineTotal)}</td></tr>`)}
          <tr><td style="background-color: var(--c_bg__alt);"><strong>Subtotal</strong></td><td class="ta-right">${this.money(totals.subtotal)}</td></tr>
          ${quote.cart.adjustments.map(adjustment => html`<tr><td style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong>${itemNames(adjustment.lineId, quote.cart.lines) ? html`<small class="d-b tc-muted">${itemNames(adjustment.lineId, quote.cart.lines)}</small>` : nothing}</td><td class="ta-right">${this.money(adjustment.amount)}</td></tr>`)}
          ${totals.taxComputed ? html`<tr><td style="background-color: var(--c_bg__alt);"><strong>Tax${totals.pricesIncludeTax ? ' (included)' : ''}</strong></td><td class="ta-right">${this.money(totals.taxTotal)}</td></tr>`
            : quote.taxEnabled ? html`<tr><td style="background-color: var(--c_bg__alt);"><strong>Tax</strong></td><td class="ta-right tc-muted">Enter your address to calculate</td></tr>` : nothing}
          ${quote.plan.filter(entry => entry.kind !== 'card').map(entry => html`<tr><td style="background-color: var(--c_bg__alt);"><strong>${quote.tenders.find(offer => offer.kind === entry.kind)?.label ?? entry.kind}</strong></td><td class="ta-right">−${this.money(entry.amount)}</td></tr>`)}
          <tr><td style="background-color: var(--c_bg__alt);"><strong>Total${quote.plan.some(entry => entry.kind !== 'card') ? ' to pay' : ''}</strong></td><td class="ta-right"><strong aria-live="polite">${this.pricing ? html`<k-spinner size="xs"></k-spinner>` : this.money(quote.plan.find(entry => entry.kind === 'card')?.amount ?? 0)}</strong></td></tr>
        </tbody>
      </table>
      ${quote.refundPolicy ? html`<details class="mb"><summary>Refund policy</summary><p class="small" style="white-space: pre-line;">${quote.refundPolicy}</p></details>` : nothing}
    `;
  }

  /*
    The accordion. Each panel is `{ id, title, priority, body }` for the checkout's own, or `{ id, title, priority, tag }`
    for one an extension registered, which is created here and handed the page.
  */

  get panels(){
    const { quote } = this;
    const panels = [
      { id: 'contact', title: 'Contact', priority: 500, body: this.renderContact() },
      { id: 'billing', title: 'Billing address', priority: 400, body: this.renderBilling() },
      ...(this.offer('store-credit') || this.offer('credits') ? [{ id: 'credits', title: 'Store credit and credits', priority: 200, body: this.renderCredits() }] : []),
      ...(this.needsCard || quote.plan.some(entry => entry.kind !== 'card') ? [{ id: 'payment', title: 'Payment', priority: 100, body: this.renderPayment() }] : []),
      ...checkoutSections('panel').map(({ id, title, priority, tag }) => ({ id, title, priority, tag })),
    ];
    return panels.sort((a, b) => b.priority - a.priority);
  }

  /*
    Several panels can be open. settle() opens and closes them by what is filled in; a panel the customer
    opened themselves stays open until they close it. Keyed, so a panel that comes and goes keeps the rest's state.
  */
  renderPanels(){
    return html`
      <k-accordion multiple @openpanel=${event => this.panelToggled(event, true)} @closepanel=${event => this.panelToggled(event, false)} @focusout=${this.panelBlurred}>
        ${this.panels.map(panel => keyed(panel.id, html`
          <k-accordion-header for-panel=${panel.id}>${panel.title}</k-accordion-header>
          <k-accordion-panel name=${panel.id}>
            <div class="p">
              ${panel.tag ? staticHtml`<${unsafeStatic(panel.tag)} .checkout=${this}></${unsafeStatic(panel.tag)}>` : panel.body}
            </div>
          </k-accordion-panel>
        `))}
      </k-accordion>
    `;
  }

  get accordion(){
    return this.querySelector('k-accordion');
  }

  /*
    Whether a panel's fields are all filled in. The checkout's own: contact is a name, an email (unless signed in)
    and any extra field an extension requires; billing is the country, address, city and postal code, and the
    state when there is a list of them (the apartment line is optional). Credits are optional, so they are done
    once the customer has been in them and left. Payment is done when no card is needed or the card is complete.
    An extension's panel is done when its element says so with `complete = true`.
  */
  isComplete({ id, tag }){
    const { form, quote, extra } = this;
    if(tag) return this.querySelector(tag)?.complete === true;
    if(id === 'contact') return Boolean(form.name?.trim()) && (quote.account.signedIn || Boolean(form.email?.trim())) && quote.fields.every(field => !field.required || Boolean(extra[field.key]));
    if(id === 'billing') return Boolean(form.country && form.line1?.trim() && form.city?.trim() && form.postalCode?.trim()) && (this.stateOptions.length === 0 || Boolean(form.state));
    if(id === 'credits') return this.visited.has('credits');
    return !this.needsCard || Boolean(this.payForm?.complete);
  }

  /*
    Opens and closes panels to match what is filled in. When a panel has just become done, the next one that is
    not done opens. A done panel closes once focus is out of it, unless the customer opened it themselves.
  */
  settle = () => {
    const { accordion } = this;
    if(!accordion || !this.quote || this.quote.empty) return;
    const panels = this.panels;
    const focused = document.activeElement?.closest?.('k-accordion-panel')?.getAttribute('name');
    const done = new Set(panels.filter(panel => this.isComplete(panel)).map(panel => panel.id));
    const isOpen = id => accordion.getPanel(id)?.active === true;
    const open = id => {
      if(!isOpen(id)) accordion.openPanel(id);
    };
    this.automating = true;
    try {
      if(!this.initialized){
        const first = panels.find(panel => !done.has(panel.id));
        if(first) open(first.id);
      }
      panels.forEach((panel, index) => {
        if(!done.has(panel.id) || this.completed.has(panel.id)) return;
        const next = panels.slice(index + 1).find(later => !done.has(later.id));
        if(next) open(next.id);
      });
      for(const panel of panels){
        if(done.has(panel.id) && panel.id !== focused && !this.userOpened.has(panel.id) && isOpen(panel.id)) accordion.closePanel(panel.id);
      }
    } finally {
      this.automating = false;
    }
    this.completed = done;
    this.initialized = true;
  };

  /* The customer opened or closed a panel. Closing one counts as having been in it. */
  panelToggled = (event, opened) => {
    if(this.automating) return;
    const name = event.detail.panelName;
    if(opened) this.userOpened.add(name);
    else {
      this.userOpened.delete(name);
      this.visited.add(name);
    }
  };

  /* Focus left a field: note the panel was used, then settle once focus has actually moved. */
  panelBlurred = event => {
    const name = event.target.closest?.('k-accordion-panel')?.getAttribute('name');
    if(name) this.visited.add(name);
    setTimeout(this.settle);
  };

  renderContact(){
    const { quote } = this;
    return html`
      ${this.field('name', 'Full name', { required: true, autocomplete: 'name' })}
      ${quote.account.signedIn ? nothing : this.field('email', 'Email', { type: 'email', required: true, hint: 'Your receipt and the link to your order are sent here', autocomplete: 'email' })}

      ${quote.account.signedIn ? nothing : html`
        <h3 class="h5">Account</h3>
        ${quote.account.required
          ? html`<p>${quote.account.reason === 'credits' ? 'Credits are added to an account, so one is needed to buy them.' : 'This store needs you to have an account to check out.'} We will make one with the email above and send you a link to set your password. <a href=${`/login?redirect=${encodeURIComponent('/checkout/')}`}>Already have one? Sign in</a>.</p>`
          : quote.account.canCreate ? html`<label class="checkbox mb"><input type="checkbox" .checked=${this.createAccount} @change=${event => { this.createAccount = event.target.checked; }}> Create an account so I can follow my order and check out faster next time</label>` : nothing}
      `}

      ${quote.fields.length ? html`<h3 class="h5">More details</h3>${quote.fields.map(field => this.renderExtraField(field))}` : nothing}
    `;
  }

  renderBilling(){
    const { quote } = this;
    return html`
      ${this.regions
        ? this.select('country', 'Country', countryOptions(this.regions, this.language), { required: quote.required?.country, hint: quote.required?.country ? 'Tax depends on it' : '', autocomplete: 'country', placeholder: 'Select a country' })
        : this.field('country', 'Country', { required: quote.required?.country, hint: 'A two-letter code, such as US or GB', autocomplete: 'country' })}
      ${this.field('line1', 'Address', { required: true, autocomplete: 'address-line1' })}
      ${this.field('line2', 'Apartment, suite, etc.', { autocomplete: 'address-line2' })}
      ${this.field('city', 'City', { autocomplete: 'address-level2' })}
      ${this.stateOptions.length
        ? this.select('state', 'State or region', this.stateOptions, { required: quote.required?.state, hint: quote.required?.state ? 'Tax depends on it' : '', autocomplete: 'address-level1', placeholder: 'Select a state or region' })
        : this.field('state', 'State or region', { autocomplete: 'address-level1' })}
      ${this.field('postalCode', 'Postal code', { required: quote.required?.postalCode, hint: quote.required?.postalCode ? 'Tax depends on it' : '', autocomplete: 'postal-code' })}
    `;
  }

  renderCredits(){
    const store = this.offer('store-credit');
    const credits = this.offer('credits');
    const step = (1 / 10 ** this.decimals).toFixed(this.decimals);
    return html`
      ${store ? html`
        <label class="mb">
          Store credit to use
          <small class="tc-muted d-b">You have ${this.money(store.detail.balance)}. Up to ${this.money(this.storeCap)} can pay for this order.</small>
          <input type="number" min="0" max=${fromMinor(this.storeCap, this.decimals)} step=${step} .value=${live(fromMinor(this.storeCredit, this.decimals))} @change=${this.setStoreCredit} style="max-width: 12rem;">
        </label>
      ` : nothing}

      ${credits ? html`
        <label class="mb">
          Credits to use
          <small class="tc-muted d-b">You have ${credits.detail.balance} credits. Up to ${this.creditsCap}, worth ${this.money(this.creditsMinor(this.creditsCap))}, can pay for this order.</small>
          <input type="number" min="0" max=${this.creditsCap} step="1" .value=${live(String(this.creditsUsed))} @change=${this.setCredits} style="max-width: 12rem;">
        </label>
      ` : nothing}
    `;
  }

  renderPayment(){
    const { quote } = this;
    const store = this.offer('store-credit');
    const credits = this.offer('credits');
    const covered = quote.totals.total > 0 && !this.needsCard;
    return html`
      ${covered ? html`<p class="tc-muted">Your ${store && credits ? 'store credit and credits cover' : store ? 'store credit covers' : 'credits cover'} this order, so there is nothing to pay by card.</p>` : nothing}

      ${quote.totals.total > 0 ? html`
        <div ?hidden=${!this.needsCard}>
          <p class="small tc-muted">${store || credits ? 'Pays what is left after the above. ' : ''}Your card details go straight to our payment processor. They never touch this site.</p>
          <k-pay-form deferred .postalCode=${this.form.postalCode} @card-change=${this.refreshSections}></k-pay-form>
        </div>
      ` : nothing}
    `;
  }

  renderForm(){
    const { quote } = this;
    return html`
      <form class="row" @submit=${this.place} ?inert=${this.finished}>
        <div class="span-12 d-span-7" style="padding-right: var(--spacer);">
          ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
          ${quote.cart.notices.map(notice => html`<p class=${notice.blocking ? 'tc-danger' : 'tc-warning'}>${notice.message}</p>`)}

          ${this.renderPanels()}
        </div>

        <div class="span-12 d-span-5">
          ${this.renderSummary()}
          ${checkoutSections('summary').map(({ tag }) => staticHtml`<${unsafeStatic(tag)} .checkout=${this}></${unsafeStatic(tag)}>`)}
          <button class="primary full" ?disabled=${this.busy || this.pricing || this.missing.length > 0 || Boolean(this.blocker)}>
            ${this.finished ? 'Order placed' : this.busy ? (this.placed ? 'Paying…' : 'Placing your order…') : (this.placed ? 'Try payment again' : 'Place order')}
          </button>
          ${this.blocker && !this.busy ? html`<p class="small tc-danger mt" role="alert">${this.blocker}</p>` : nothing}
          ${this.missing.length && !this.busy ? html`<p class="small tc-muted mt">To place your order, add ${this.missing.join(', ').replace(/, ([^,]*)$/, ' and $1')}.</p>` : nothing}
        </div>
      </form>
    `;
  }

  renderLightDom(){
    const { quote } = this;
    if(!quote) return html`<k-spinner></k-spinner>`;
    if(quote.empty){
      return html`<div class="ta-center py">
        <p class="large">${this.error || 'Your cart is empty.'}</p>
        ${(quote.notices ?? []).map(notice => html`<p class="tc-danger">${notice.message}</p>`)}
        <a class="btn primary" href="/cart/">Back to your cart</a>
      </div>`;
    }
    return this.renderForm();
  }
}

customElements.define('k-commerce-checkout', Checkout);
