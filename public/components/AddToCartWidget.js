import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import '/commerce/components/AddToCart.js';
import { parseSelections } from '/commerce/utils/selections.js';
import iconSource from '/commerce/utils/iconSource.js';

/*
  The Add to cart widget on a page built in the page builder: the button, with the text, icon and style its settings name.
  By default it is for the product its `product-id` names, with the options its `selections` name. With `detect-parent` it
  is for the Parent Product or Product widget it is placed in (kempo-products), and that product's chosen options, so it needs
  no product of its own. Its button is in this widget's shadow DOM, so the one it is placed in is found here and handed to it.
*/
export default class AddToCartWidget extends ShadowComponent {
  static properties = {
    productId: { type: String, attribute: 'product-id' },
    label: { type: String },
    icon: { type: String },
    variant: { type: String },
    full: { type: Boolean },
    selections: { type: String },
    detectParent: { type: Boolean, attribute: 'detect-parent' },
    inline: { type: String }
  };

  static styles = css`
    :host { display: block; }
    :host([inline="true"]) { display: inline-block !important; }
  `;

  constructor(){
    super();
    this.productId = '';
    this.label = 'Add to cart';
    this.icon = '/commerce/icons/add_shopping_cart.svg';
    this.variant = 'primary';
    this.full = false;
    this.selections = '';
    this.detectParent = false;
    this.parentProduct = null;
  }

  connectedCallback(){
    super.connectedCallback();
    this.parentProduct = this.closest('k-products-parent-widget, k-products-product-widget');
    this.requestUpdate();
  }

  render(){
    return html`<k-commerce-add-to-cart
      .productId=${this.productId}
      .label=${this.label}
      .icon=${iconSource(this.icon)}
      .variant=${this.variant}
      .full=${this.full}
      .picked=${parseSelections(this.selections)}
      .detectParent=${this.detectParent}
      .source=${this.detectParent ? this.parentProduct : null}
    ></k-commerce-add-to-cart>`;
  }
}

customElements.define('k-commerce-add-to-cart-widget', AddToCartWidget);
