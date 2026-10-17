import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing, live } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Aside.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/commerce/components/CartQty.js';
import { getConfig, getCart, updateLine, removeLine, announceCartChanged, onCartChanged } from '/commerce/sdk.js';
import { loadFormat, optionsText } from '/commerce/utils/format.js';

/*
  A cart that opens from the side without leaving the page, served at /commerce/components/MiniCart.js.

  ```html
  <script type="module" src="/commerce/components/MiniCart.js"></script>
  <k-commerce-mini-cart></k-commerce-mini-cart>                  <!-- on the side the site chose (right by default) -->
  <k-commerce-mini-cart side="left"></k-commerce-mini-cart>      <!-- or on the left -->
  ```

  It is a `k-aside` (overlay, closes on the backdrop and on Escape; kempo-ui reads those two attributes as "true" or "false", so they must be written out); kempo-ui's aside provides the
  panel, the focus handling and the open/closed state, and this wraps it. Open it from
  `<k-commerce-cart-button>`, or call `open()`, `close()`, `toggle()` and `refresh()` yourself. It opens
  when something is added to the cart if the site turned `mini_cart_open_on_add` on (it is off by default), and refreshes itself
  when the cart changes anywhere. It shows the server's answer after every change, never a guess.

  Other extensions add to it through slots: `before-lines`, `after-lines` (a coupon box, a free
  shipping bar) and `footer`. It hides itself on the cart and checkout pages when the site says so.
  Fires `mini-cart-opened` and `mini-cart-closed`.
*/
export default class MiniCart extends ShadowComponent {
  static properties = {
    side: { type: String, reflect: true },
    cart: { state: true },
    config: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  constructor(){
    super();
    this.side = '';
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
    window.addEventListener('cart-line-added', this.added);
    this.start();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    this.stopListening?.();
    window.removeEventListener('cart-line-added', this.added);
  }

  start = async () => {
    const [{ money }, [, data]] = await Promise.all([loadFormat(), getConfig()]);
    this.money = money;
    this.config = data?.config ?? {};
    await this.refresh();
  };

  /*
    Public methods
  */

  get aside(){
    return this.renderRoot.querySelector('k-aside');
  }

  open = () => {
    this.refresh();
    this.aside?.expand();
    this.dispatchEvent(new CustomEvent('mini-cart-opened', { bubbles: true, composed: true }));
  };

  close = () => {
    this.aside?.hide();
  };

  toggle = () => this.aside?.state === 'expanded' ? this.close() : this.open();

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

  added = () => {
    if(this.config?.miniCartOpenOnAdd === true) this.open();
  };

  closed = event => {
    if(event.detail?.state === 'offscreen') this.dispatchEvent(new CustomEvent('mini-cart-closed', { bubbles: true, composed: true }));
  };

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
    Utility functions
  */

  get hidden(){
    if(!this.config?.miniCartHideOnCartPages) return false;
    return /^\/(commerce\/)?cart(\/|$)/.test(location.pathname);
  }

  /*
    Rendering
  */

  renderLine(line){
    return html`
      <li class="mb" style="list-style: none;">
        <div class="d-f mbh" style="align-items: center; gap: var(--spacer_h);">
          ${line.image ? html`<img src=${line.image.thumbnail ?? line.image.path} alt="" width="48" height="48" loading="lazy">` : nothing}
          <div class="flex">
            <a href=${`/products/${encodeURIComponent(line.slug)}/`} class="no-link"><strong>${line.name}</strong></a>
            ${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}
            <div class="small">${this.money(line.unitPrice)} each</div>
          </div>
        </div>
        <div class="d-f" style="align-items: center; justify-content: space-between;">
          <k-commerce-cart-qty .value=${live(line.quantity)} label=${line.name} ?disabled=${this.busy} @change=${event => this.change(line, event.detail.value)} @qty-remove=${() => this.change(line, 0)}></k-commerce-cart-qty>
          <strong>${this.money(line.lineTotal)}</strong>
        </div>
      </li>
    `;
  }

  render(){
    if(this.hidden) return nothing;
    const cart = this.cart;
    const side = this.side || this.config?.miniCartSide || 'right';

    return html`
      <k-aside side=${side} main="overlay" overlay-close="true" esc-close="true" @aside_state_change=${this.closed}>
        <div class="py" role="dialog" aria-label="Your cart">
          <div class="d-f mb" style="align-items: center;">
            <h2 class="flex m0">Your cart</h2>
            <button class="no-btn" aria-label="Close the cart" @click=${this.close}><k-icon name="close"></k-icon></button>
          </div>
          <div aria-live="polite">
            ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
            ${(cart?.notices ?? []).map(notice => html`<p class=${notice.blocking ? 'tc-danger' : 'tc-warning'}>${notice.message}</p>`)}
          </div>
          <slot name="before-lines"></slot>
          ${!cart ? html`<k-spinner></k-spinner>` : cart.lines.length
            ? html`<ul class="m0 p0">${cart.lines.map(line => this.renderLine(line))}</ul>`
            : html`<p class="tc-muted">Your cart is empty. <a href="/products/">Browse the shop</a>.</p>`}
          <slot name="after-lines"></slot>
          ${cart?.lines.length ? html`
            <div class="d-f bt pt mb" style="justify-content: space-between;">
              <strong>Subtotal</strong>
              <strong>${this.money(cart.totals.subtotal)}</strong>
            </div>
            <p class="tc-muted small">Taxes and credits calculated at checkout.</p>
            <div class="d-g cols-2" style="gap: var(--spacer_h);">
              <a class="btn ta-center" href="/cart/"><k-icon src="/commerce/icons/shopping_cart.svg"></k-icon> View cart</a>
              <a class="btn primary ta-center" href="/checkout/" aria-disabled=${cart.blocked ? 'true' : 'false'}><k-icon src="/commerce/icons/shopping_cart_checkout.svg"></k-icon> Checkout</a>
            </div>
          ` : nothing}
          <slot name="footer"></slot>
        </div>
      </k-aside>
    `;
  }
}

customElements.define('k-commerce-mini-cart', MiniCart);
