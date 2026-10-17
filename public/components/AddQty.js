import QtyPicker from '/commerce/components/QtyPicker.js';

/*
  The quantity picker for adding a product to the cart, served at /commerce/components/AddQty.js.

  ```html
  <k-commerce-add-qty value="1" label="Model car"></k-commerce-add-qty>
  ```

  One is the lowest it goes, so at 1 the "-" is simply disabled. Typing a lower number holds it at 1.
*/
export default class AddQty extends QtyPicker {}

customElements.define('k-commerce-add-qty', AddQty);
