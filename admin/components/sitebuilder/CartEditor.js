import Cart from '/commerce/components/Cart.js';
import { loadFormat } from '/commerce/utils/format.js';
import sampleCart from './sampleCart.js';

/*
  The Cart as the page builder shows it: the same cart, drawn by the same component, with a sample cart in place of the
  visitor's own so the layout can be seen and its pieces placed. Nothing is read from or sent to the server, so changing a
  quantity changes nothing.
*/
export default class CartEditor extends Cart {
  start = async () => {
    const format = await loadFormat();
    this.money = format.money;
    this.config = format.config;
    this.cart = sampleCart();
  };

  cartChanged = () => {};

  change = async () => {};
}

customElements.define('k-commerce-cart-editor', CartEditor);
