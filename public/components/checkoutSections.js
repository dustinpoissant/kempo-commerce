/*
  How another extension puts something on the checkout page, served at /commerce/components/checkoutSections.js.

  A coupon box, a sales banner, an affiliate code, a gift message: each is a custom element the extension
  writes, and registers here with the place it belongs:

  ```javascript
  import { registerCheckoutSection } from '/commerce/components/checkoutSections.js';

  const TAG = 'k-coupons-box';
  customElements.define(TAG, CouponsBox);
  registerCheckoutSection(TAG, { where: 'payment' });
  ```

  Where:

    details   after contact and billing, before the payment section
    payment   at the top of the payment section, above store credit, credits and the card
    summary   under the order summary, above the button that places the order

  Each element is created by the checkout and handed `checkout`: the page itself. What it can use:

    checkout.quote        the server's current answer (cart, totals, tenders, plan)
    checkout.form         the contact and billing details typed so far
    checkout.reprice()    asks the server for the totals again, which is what an element calls after it
                          changed something the totals depend on (it applied a coupon to the cart)
    checkout.setData(key, value)   a value sent with the order as \`data\`, which the \`checkout:validate\`
                          guard on the server receives

  The server side of a section is the extension's own: money it takes off goes through the cart's
  adjustments, and what it needs to check goes in the \`checkout:validate\` guard.

  The registry lives in this module, so every script that imports it shares one.
*/

const sections = new Map();

export const registerCheckoutSection = (tag, { where = 'details', priority = 0 } = {}) => {
  if(typeof tag !== 'string' || !tag.includes('-')) throw new Error('A checkout section is a custom element tag, such as k-coupons-box');
  sections.set(tag, { tag, where, priority });
  window.dispatchEvent(new CustomEvent('checkout-sections-changed'));
};

export const unregisterCheckoutSection = tag => {
  if(sections.delete(tag)) window.dispatchEvent(new CustomEvent('checkout-sections-changed'));
};

/* The tags registered for a place, highest priority first. */
export const checkoutSections = where => [...sections.values()]
  .filter(section => section.where === where)
  .sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag))
  .map(section => section.tag);

/* Makes `container` hold exactly the registered elements for `where`, each given `props`. */
export const syncCheckoutSections = (container, where, props) => {
  if(!container) return;
  const wanted = checkoutSections(where);
  for(const child of [...container.children]){
    if(!wanted.includes(child.localName)) child.remove();
  }
  for(const tag of wanted){
    let element = [...container.children].find(child => child.localName === tag);
    if(!element){
      element = document.createElement(tag);
      container.append(element);
    }
    for(const [name, value] of Object.entries(props)){
      if(element[name] !== value) element[name] = value;
    }
  }
};
