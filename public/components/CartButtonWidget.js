import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import '/commerce/components/CartButton.js';
import iconSource from '/commerce/utils/iconSource.js';

/*
  The Cart button widget on a page built in the page builder: the cart button, with the icon and text its settings
  name and the count turned on or off. The count and the link still come from the cart itself.
*/
export default class CartButtonWidget extends ShadowComponent {
  static properties = {
    icon: { type: String },
    text: { type: String },
    counter: { type: String },
    inline: { type: String }
  };

  static styles = css`
    :host { display: block; }
    :host([inline="true"]) { display: inline-block !important; }
  `;

  constructor(){
    super();
    this.icon = '/commerce/icons/shopping_cart.svg';
    this.text = '';
    this.counter = 'true';
    this.inline = 'false';
  }

  render(){
    return html`<k-commerce-cart-button .icon=${iconSource(this.icon)} .text=${this.text} .counter=${this.counter}></k-commerce-cart-button>`;
  }
}

customElements.define('k-commerce-cart-button-widget', CartButtonWidget);
