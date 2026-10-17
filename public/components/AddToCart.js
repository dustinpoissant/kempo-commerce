import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import Toast from '/kempo-ui/components/Toast.js';
import '/commerce/components/AddQty.js';
import { getConfig, addToCart, announceCartChanged } from '/commerce/sdk.js';

/* The site's settings, asked for once however many of these buttons a page has. */
let config = null;
const loadConfig = () => config ??= getConfig();

/*
  Quantity and an "Add to cart" button, served at /commerce/components/AddToCart.js.

  Injected into kempo-products' product cards and product page by public/product-actions.global.html, so
  every card and page shows one without editing either. Inside a card it finds the card with
  `closest('k-products-card')` and uses the product the list already loaded; inside the product page it
  finds `closest('k-products-detail')`, reads the product and the choices so far from it, and follows
  its `selection-change` event. It can also stand alone:

  ```html
  <script type="module" src="/commerce/components/AddToCart.js"></script>
  <k-commerce-add-to-cart product-id="9f2c1e0a44b7d3a1"></k-commerce-add-to-cart>
  ```

  It disables itself with the reason: sold out, or options still to choose. On a card with options
  to choose it links to the product's page instead. The server decides everything that matters (the
  price, the quantity); this only names a product and a quantity. After an add it shows a toast naming the
  product, with a "View cart" button that opens the mini-cart or the cart page as the site chose
  (`add_to_cart_toast_action`), and fires `cart-line-added` and `cart-changed`, which the mini-cart and
  the cart button listen to.
*/
export default class AddToCart extends ShadowComponent {
  static properties = {
    productId: { type: String, attribute: 'product-id' },
    product: { attribute: false },
    selections: { attribute: false },
    price: { attribute: false },
    complete: { attribute: false },
    quantity: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  constructor(){
    super();
    this.host = null;
    this.productId = '';
    this.product = null;
    this.selections = undefined;
    this.price = null;
    this.complete = true;
    this.quantity = 1;
    this.busy = false;
    this.error = '';
  }

  /*
    Lifecycle callbacks
  */

  connectedCallback(){
    super.connectedCallback();
    this.host = this.closest('k-products-card, k-products-detail');
    this.host?.addEventListener('selection-change', this.follow);
    this.follow();
  }

  disconnectedCallback(){
    this.host?.removeEventListener('selection-change', this.follow);
    super.disconnectedCallback();
  }

  /*
    Event handlers
  */

  /* Takes what the card or product page it sits in knows: the product, and on a product page the choices. */
  follow = () => {
    const { host } = this;
    if(!host) return;
    this.product = host.product ?? null;
    if(this.product && host.localName === 'k-products-detail'){
      this.selections = host.selections;
      this.price = host.price;
      this.complete = host.complete;
    }
  };

  add = async () => {
    this.busy = true;
    this.error = '';
    const [error, data] = await addToCart({ productId: this.product?.id ?? this.productId, quantity: this.quantity, selections: this.selections ?? {} });
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    const [, configData] = await loadConfig();
    const choice = configData?.config?.addToCartAction ?? 'mini-cart';
    const action = choice === 'none' ? {} : {
      action: 'View cart',
      actionCallback: () => {
        const miniCart = document.querySelector('k-commerce-mini-cart');
        if(choice === 'mini-cart' && miniCart) miniCart.open(); else location.href = '/cart/';
      },
    };
    /* A toast sets its text as HTML, so the product's name is escaped. */
    const name = this.product?.name ? ` <strong>${this.product.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</strong>` : '';
    /* At the bottom centre, because the mini-cart opens on the right and would be covered. */
    Toast.success(`Added${this.quantity === 1 ? '' : ` ${this.quantity} ×`}${name} to your cart`, { position: 'bottom center', ...action });
    this.dispatchEvent(new CustomEvent('cart-line-added', { detail: { line: data.line, cart: data.cart }, bubbles: true, composed: true }));
    announceCartChanged(this, data.cart);
  };

  /*
    Utility functions
  */

  get reason(){
    const { product } = this;
    if(!product) return '';
    if(product.availability === 'sold') return 'Sold';
    if(product.availability === 'pending') return 'Sale pending';
    if(product.inStock === false) return 'Out of stock';
    if(product.price === null || product.price === undefined) return 'Not for sale online';
    if(this.selections !== undefined && this.complete === false) return 'Choose your options';
    return '';
  }

  /* On a card, a product with options has to be configured on its own page. */
  get needsOptions(){
    return this.selections === undefined && (this.product?.options ?? []).some(option => option.required);
  }

  /*
    Rendering
  */

  render(){
    if(!this.product && !this.productId) return nothing;
    const reason = this.reason;
    const onCard = this.selections === undefined;

    if(this.needsOptions){
      return html`<a class="btn full ta-center" href=${`/products/${encodeURIComponent(this.product.slug)}/`}><k-icon src="/commerce/icons/ballot.svg"></k-icon> Choose options</a>`;
    }

    return html`
      <div class=${onCard ? '' : 'mb'}>
        ${onCard ? nothing : html`
          <div class="mb">
            <div class="mbq">Quantity</div>
            <k-commerce-add-qty .value=${this.quantity} label=${this.product?.name ?? ''} ?disabled=${Boolean(reason) || this.busy} @change=${event => { this.quantity = event.detail.value; }}></k-commerce-add-qty>
          </div>
        `}
        <button class="primary full" ?disabled=${Boolean(reason) || this.busy} @click=${this.add}>
          <k-icon src="/commerce/icons/add_shopping_cart.svg"></k-icon> ${reason || (this.busy ? 'Adding…' : 'Add to cart')}
        </button>
        ${this.error ? html`<p class="tc-danger mtq mb0" role="alert">${this.error}</p>` : nothing}
      </div>
    `;
  }
}

customElements.define('k-commerce-add-to-cart', AddToCart);
