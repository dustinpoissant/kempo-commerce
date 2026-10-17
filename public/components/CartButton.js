import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import { getCart, onCartChanged } from '/commerce/sdk.js';

/*
  The cart icon with a count of what is in it, served at /commerce/components/CartButton.js.

  It is a link to the cart page that opens the mini-cart instead when the page has one. Put it inside a
  link of your own and that link is the thing on the page, so it is styled like every other link around
  it (a link in a nav gets the nav's padding, colour and hover, whatever the site's theme is) and it works
  as a link before any script has run:

  ```html
  <a href="/cart/"><k-commerce-cart-button></k-commerce-cart-button></a>
  <script type="module" src="/commerce/components/CartButton.js"></script>
  ```

  This is what the **Cart** item on kempo's Menus page puts in a menu. On its own, outside any link, it
  draws its own link to the cart page.

  A plain click on the link opens the mini-cart (`<k-commerce-mini-cart>`) and does not leave the page. A
  click with Ctrl, Cmd, Shift or the middle button is left alone, so the cart can still be opened in a
  new tab, and so is a click when there is no mini-cart on the page, which goes to the cart page. The
  count stays current by listening for `cart-changed`, from any component or another tab; it never polls.
*/
export default class CartButton extends ShadowComponent {
  static properties = {
    count: { state: true },
  };

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--spacer_q);
    }
    a {
      display: inline-flex;
      align-items: center;
      gap: var(--spacer_q);
      padding: var(--spacer_h);
      text-decoration: none;
    }
    .count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 1.25rem;
      height: 1.25rem;
      padding: 0 var(--spacer_q);
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1;
    }
  `;

  constructor(){
    super();
    this.count = 0;
    this.link = null;
    this.stopListening = null;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.link = this.closest('a');
    this.link?.addEventListener('click', this.handleClick);
    this.stopListening = onCartChanged(cart => cart ? this.show(cart) : this.refresh());
    this.refresh();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    this.link?.removeEventListener('click', this.handleClick);
    this.stopListening?.();
  }

  updated(){
    this.link?.setAttribute('aria-label', this.label);
  }

  /*
    Public methods
  */

  refresh = async () => {
    const [error, data] = await getCart();
    if(!error) this.show(data.cart);
  };

  open = () => {
    const miniCart = document.querySelector('k-commerce-mini-cart');
    if(miniCart?.open && !miniCart.hidden) miniCart.open();
    else if(!/^\/(commerce\/)?cart(\/|$)/.test(location.pathname)) location.href = '/cart/';
  };

  /*
    Event handlers
  */

  /* A plain click opens the mini-cart; anything else, or a page with no mini-cart, follows the link. */
  handleClick = event => {
    const miniCart = document.querySelector('k-commerce-mini-cart');
    if(event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if(!miniCart?.open || miniCart.hidden) return;
    event.preventDefault();
    miniCart.open();
  };

  /*
    Utility functions
  */

  show = cart => {
    this.count = cart?.itemCount ?? 0;
  };

  get label(){
    return this.count === 1 ? 'Cart, 1 item' : `Cart, ${this.count} items`;
  }

  /*
    Rendering
  */

  render(){
    const content = html`<k-icon src="/commerce/icons/shopping_cart.svg"></k-icon>${this.count ? html`<span class="count bg-primary" aria-hidden="true">${this.count}</span>` : ''}`;
    return this.link ? content : html`<a href="/cart/" aria-label=${this.label} @click=${this.handleClick}>${content}</a>`;
  }
}

customElements.define('k-commerce-cart-button', CartButton);
