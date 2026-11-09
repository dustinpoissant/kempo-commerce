import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import '/commerce/components/Cart.js';
import { renderNotices, renderLines, renderTotals, renderActions } from '/commerce/utils/cartParts.js';

/*
  The pieces of the cart page, for a layout built in the page builder (or by hand): put them inside a `<k-commerce-cart>` and
  it draws only them, in your order. Each finds the cart with `closest('k-commerce-cart')` (or the page builder's copy of it),
  draws what the cart holds, and draws again when the cart changes. With nothing in the cart none of them draws, and the cart
  says it is empty.

    <k-commerce-cart-notices-widget>   what changed or went wrong (a price that moved, a product no longer for sale)
    <k-commerce-cart-lines-widget>     the lines, with their quantities
    <k-commerce-cart-totals-widget>    the subtotal, discounts and fees, and the total
    <k-commerce-cart-actions-widget>   continue shopping, and on to checkout
*/
class CartPart extends ShadowComponent {
  static styles = css`
    :host { display: block; }
  `;

  connectedCallback(){
    super.connectedCallback();
    this.cartHost = this.closest('k-commerce-cart, k-commerce-cart-editor');
    this.cartHost?.addEventListener('cart-change', this.refresh);
    this.requestUpdate();
  }

  disconnectedCallback(){
    this.cartHost?.removeEventListener('cart-change', this.refresh);
    super.disconnectedCallback();
  }

  refresh = () => this.requestUpdate();

  /* What the piece draws, from the cart element. */
  renderPart(){
    return nothing;
  }

  render(){
    if(!this.cartHost) return html`<p class="tc-muted">Place this in a Cart</p>`;
    if(!this.cartHost.cart?.lines?.length) return nothing;
    return this.renderPart(this.cartHost);
  }
}

class CartNotices extends CartPart {
  renderPart(host){
    return renderNotices(host);
  }
}

class CartLines extends CartPart {
  renderPart(host){
    return renderLines(host);
  }
}

class CartTotals extends CartPart {
  renderPart(host){
    return renderTotals(host);
  }
}

class CartActions extends CartPart {
  renderPart(host){
    return renderActions(host);
  }
}

customElements.define('k-commerce-cart-notices-widget', CartNotices);
customElements.define('k-commerce-cart-lines-widget', CartLines);
customElements.define('k-commerce-cart-totals-widget', CartTotals);
customElements.define('k-commerce-cart-actions-widget', CartActions);
