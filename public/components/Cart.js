import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing, live } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/commerce/components/CartQty.js';
import { getCart, updateLine, removeLine, announceCartChanged, onCartChanged } from '/commerce/sdk.js';
import { loadFormat, optionsText, itemNames } from '/commerce/utils/format.js';

/* A table with no header row has no top border or rounded top corners of its own, so its first row draws them. */
const TOP_LEFT = 'border-top: 1px solid var(--c_border); border-top-left-radius: var(--radius);';
const TOP_RIGHT = 'border-top: 1px solid var(--c_border); border-top-right-radius: var(--radius);';

/*
  The cart page's body, served at /commerce/components/Cart.js.

  ```html
  <script type="module" src="/commerce/components/Cart.js"></script>
  <k-commerce-cart></k-commerce-cart>
  ```

  Every line with its picture, choices, unit price, quantity and total, any notices (a price that
  changed, less quantity than asked for, a product no longer for sale), the fees an extension added, the
  subtotal, and the way on to checkout. Everything shown is what the server answered after each change.
  Slots `before` and `after` are for other extensions (a coupon box, upsells).
*/
export default class Cart extends ShadowComponent {
  static properties = {
    cart: { state: true },
    config: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  constructor(){
    super();
    this.cart = null;
    this.config = null;
    this.busy = false;
    this.error = '';
    this.money = minor => String(minor);
    this.stopListening = null;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.stopListening = onCartChanged(cart => cart ? this.cart = cart : this.refresh());
    this.start();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    this.stopListening?.();
  }

  start = async () => {
    const format = await loadFormat();
    this.money = format.money;
    this.config = format.config;
    await this.refresh();
  };

  /* The cart shows one row per kind of discount or fee, adding up what it took across the lines, and which lines. */
  adjustmentRows = adjustments => {
    const rows = new Map();
    for(const adjustment of adjustments){
      const key = `${adjustment.type}|${adjustment.label}`;
      const row = rows.get(key);
      rows.set(key, { ...adjustment, amount: (row?.amount ?? 0) + adjustment.amount, lineIds: [...(row?.lineIds ?? []), ...(adjustment.lineId ? [adjustment.lineId] : [])] });
    }
    return [...rows.values()];
  };

  refresh = async () => {
    const [error, data] = await getCart();
    if(error) this.error = error.msg;
    else {
      this.error = '';
      this.cart = data.cart;
    }
  };

  /*
    Event handlers
  */

  change = async (line, quantity) => {
    this.busy = true;
    const [error, data] = await (quantity < 1 ? removeLine(line.id) : updateLine(line.id, quantity));
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.cart = data.cart;
    announceCartChanged(this, data.cart);
  };

  /*
    Rendering
  */

  renderLine(line){
    const notices = this.cart.notices.filter(notice => notice.lineId === line.id);
    return html`
      <tr>
        <td>
          <div class="d-f" style="align-items: center; gap: var(--spacer_h);">
            ${line.image ? html`<img src=${line.image.thumbnail ?? line.image.path} alt="" width="64" height="64" loading="lazy">` : nothing}
            <div>
              <a href=${`/products/${encodeURIComponent(line.slug)}/`} class="no-link"><strong>${line.name}</strong></a>
              ${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}
              ${notices.map(notice => html`<div class=${notice.blocking ? 'tc-danger small' : 'tc-warning small'}>${notice.message}</div>`)}
            </div>
          </div>
        </td>
        <td>${this.money(line.unitPrice)}</td>
        <td>
          <k-commerce-cart-qty .value=${live(line.quantity)} label=${line.name} ?disabled=${this.busy} @change=${event => this.change(line, event.detail.value)} @qty-remove=${() => this.change(line, 0)}></k-commerce-cart-qty>
        </td>
        <td>${this.money(line.lineTotal)}</td>
      </tr>
    `;
  }

  render(){
    if(!this.cart) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { cart } = this;

    if(!cart.lines.length){
      return html`<div class="ta-center py"><p class="large">Your cart is empty.</p><a class="btn primary" href="/products/">Continue shopping</a></div>`;
    }

    const general = cart.notices.filter(notice => !notice.lineId);
    return html`
      <div aria-live="polite">
        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        ${general.map(notice => html`<p class=${notice.blocking ? 'tc-danger' : 'tc-warning'}>${notice.message}</p>`)}
      </div>
      <slot name="before"></slot>
      <div class="table-wrapper mb">
        <table>
          <thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Total</th></tr></thead>
          <tbody>${cart.lines.map(line => this.renderLine(line))}</tbody>
        </table>
      </div>
      <div class="row">
        <div class="span-12 d-span-7"><slot name="after"></slot></div>
        <div class="span-12 d-span-5">
          <table class="mb">
            <tbody>
              <tr><td style=${`background-color: var(--c_bg__alt); ${TOP_LEFT}`}><strong>Subtotal</strong></td><td class="ta-right" style=${TOP_RIGHT}>${this.money(cart.totals.subtotal)}</td></tr>
              ${this.adjustmentRows(cart.adjustments).map(adjustment => html`<tr><td style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong>${itemNames(adjustment.lineIds, cart.lines) ? html`<small class="d-b tc-muted">${itemNames(adjustment.lineIds, cart.lines)}</small>` : nothing}</td><td class="ta-right">${this.money(adjustment.amount)}</td></tr>`)}
              <tr><td style="background-color: var(--c_bg__alt);"><strong>Total</strong></td><td class="ta-right"><strong>${this.money(cart.totals.total)}</strong></td></tr>
            </tbody>
          </table>
          ${cart.adjustments.some(adjustment => adjustment.data?.limited) && this.config?.priceFloorNotice ? html`<p class="tc-muted">${this.config.priceFloorNotice}</p>` : nothing}
          <p class="tc-muted small">Taxes and credits calculated at checkout.</p>
          <div class="d-g cols-2" style="gap: var(--spacer_h);">
            <a class="btn ta-center" href="/products/"><k-icon name="arrow" direction="left"></k-icon> Continue shopping</a>
            ${cart.blocked
              ? html`<button class="primary" disabled><k-icon src="/commerce/icons/shopping_cart_checkout.svg"></k-icon> Proceed to checkout</button>`
              : html`<a class="btn primary ta-center" href="/checkout/"><k-icon src="/commerce/icons/shopping_cart_checkout.svg"></k-icon> Proceed to checkout</a>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('k-commerce-cart', Cart);
