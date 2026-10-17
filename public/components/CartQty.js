import QtyPicker from '/commerce/components/QtyPicker.js';

/*
  The quantity picker for a line in the cart, served at /commerce/components/CartQty.js.

  ```html
  <k-commerce-cart-qty value="3" label="Model car"></k-commerce-cart-qty>
  ```

  At the minimum (1) the "-" turns into the remove-from-cart icon, and pressing it fires `qty-remove`
  instead of changing the number. Typing 0 asks to remove the line the same way. The element never
  removes anything itself: whoever owns the cart listens for `change` and `qty-remove` and answers with
  the cart the server returns.
*/
export default class CartQty extends QtyPicker {
  get removes(){
    return true;
  }

  belowMin(){
    this.dispatchEvent(new CustomEvent('qty-remove', { bubbles: true, composed: true }));
  }
}

customElements.define('k-commerce-cart-qty', CartQty);
