import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import { getCart, updateLine, removeLine, announceCartChanged, onCartChanged } from '/commerce/sdk.js';
import { loadFormat } from '/commerce/utils/format.js';
import { renderNotices, renderLines, renderTotals, renderActions } from '/commerce/utils/cartParts.js';

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

  **A layout of your own.** Put the pieces inside it and it draws only them, in your order, instead of its own layout:

  ```html
  <k-commerce-cart>
    <k-commerce-cart-lines-widget></k-commerce-cart-lines-widget>
    <k-commerce-cart-totals-widget></k-commerce-cart-totals-widget>
    <k-commerce-cart-actions-widget></k-commerce-cart-actions-widget>
  </k-commerce-cart>
  ```

  A piece finds the cart with `closest('k-commerce-cart')` and reads `cart`, `money(minor)`, `config`, `busy`, `error`
  and `change(line, quantity)` from it, and draws again on its `cart-change` event. An empty cart draws the empty cart
  message and none of the pieces.
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
    this.watcher = new MutationObserver(() => this.requestUpdate());
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.stopListening = onCartChanged(cart => this.cartChanged(cart));
    this.watcher.observe(this, { childList: true });
    this.start();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    this.stopListening?.();
    this.watcher.disconnect();
  }

  updated(changed){
    super.updated?.(changed);
    this.dispatchEvent(new CustomEvent('cart-change'));
  }

  start = async () => {
    const format = await loadFormat();
    this.money = format.money;
    this.config = format.config;
    await this.refresh();
  };

  /* The cart changed somewhere else on the page (the side cart): take it, or ask again. */
  cartChanged = cart => (cart ? this.cart = cart : this.refresh());

  /* Whether pieces are placed inside, so the cart draws them and nothing of its own. */
  get layout(){
    return [...this.children].some(child => !child.slot);
  }

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

  render(){
    if(!this.cart) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { cart } = this;

    if(!cart.lines.length){
      return html`<div class="ta-center py"><p class="large">Your cart is empty.</p><a class="btn primary" href="/products/">Continue shopping</a></div>`;
    }

    if(this.layout) return html`<slot name="before"></slot><slot></slot><slot name="after"></slot>`;

    return html`
      ${renderNotices(this)}
      <slot name="before"></slot>
      ${renderLines(this)}
      <div class="row">
        <div class="span-12 d-span-7"><slot name="after"></slot></div>
        <div class="span-12 d-span-5">
          ${renderTotals(this)}
          ${renderActions(this)}
        </div>
      </div>
    `;
  }
}

customElements.define('k-commerce-cart', Cart);
