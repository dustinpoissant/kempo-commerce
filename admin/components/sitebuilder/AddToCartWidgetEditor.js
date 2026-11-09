import WidgetEditor from '/kempo-ui/components/pagebuilder/WidgetEditor.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import addToCartButton from '/commerce/utils/addToCartButton.js';
import iconSource from '/commerce/utils/iconSource.js';

/*
  The Add to cart widget as the page builder shows it: the same button the page shows, drawn by the same
  template. Clicks go to the widget (to select it), not to the button, so nothing is added to a cart here.
  A setting at its default is not written on the element, so the defaults are the page widget's own.
*/
export default class AddToCartWidgetEditor extends WidgetEditor {
  static properties = {
    ...WidgetEditor.properties,
    label: { type: String, reflect: true },
    icon: { type: String, reflect: true },
    variant: { type: String, reflect: true },
    full: { type: Boolean, reflect: true }
  };

  static styles = css`
    :host { display: block; }
    :host([inline="true"]) { display: inline-block !important; }
    button { pointer-events: none; }
  `;

  constructor(){
    super();
    this.label = 'Add to cart';
    this.icon = '/commerce/icons/add_shopping_cart.svg';
    this.variant = 'primary';
    this.full = false;
  }

  render(){
    return html`${addToCartButton({ label: this.label, icon: iconSource(this.icon), variant: this.variant, full: this.full })}`;
  }
}

customElements.define('k-commerce-add-to-cart-editor', AddToCartWidgetEditor);
