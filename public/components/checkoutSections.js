/*
  How another extension puts something on the checkout page, served at /commerce/components/checkoutSections.js.

  The left side of the checkout is an accordion, one panel open at a time. Contact, billing, credits and payment
  are the checkout's own panels. An extension adds a panel of its own, such as a shipping address, or puts an
  element under the order summary:

  ```javascript
  import { registerCheckoutSection } from '/commerce/components/checkoutSections.js';

  const TAG = 'k-shipping-address';
  customElements.define(TAG, ShippingAddress);
  registerCheckoutSection(TAG, { title: 'Shipping address', priority: 300 });
  ```

  Options:

    title       the panel's heading (required for a panel)
    priority    where the panel goes, highest first. The checkout's own are contact 500, billing 400,
                credits 200 and payment 100, so 300 lands between billing and credits
    id          names the panel (default: the tag). contact, billing, credits and payment are reserved
    where       'panel' (default) for an accordion panel, or 'summary' for an element under the order
                summary, above the button that places the order

  The checkout opens a panel while it is not done and closes it once it is, and opens the next panel when one
  becomes done. An element says when its panel is done with a `complete` property (`get complete(){ ... }`,
  true when the customer has filled in what it asks for). The checkout looks again only when something on the
  page changes, so an element calls `checkout.setData(key, value)` whenever what it holds changes, which is
  what makes the checkout look at it. Without a `complete`, its panel stays as the customer left it.

  Each element is created by the checkout and handed `checkout`: the page itself. What it can use:

    checkout.quote        the server's current answer (cart, totals, tenders, plan). A Lit element is asked to
                          draw again whenever the checkout does, so it can read this in `render`
    checkout.form         the contact and billing details typed so far
    checkout.reprice()    asks the server for the totals again, which is what an element calls after it
                          changed something the totals depend on (it applied a coupon to the cart)
    checkout.setData(key, value)   a value sent with the order as `data`, which the `checkout:validate` guard
                          on the server receives

  An element can also keep the order from being placed with a `blocker` property (`get blocker(){ ... }`): a sentence for
  the customer saying why, or '' when nothing stops it. While it is not empty the button is disabled and the sentence is
  shown under it. The server must refuse the order too (in `checkout:validate`), as this is only the page being clear.

  The server side of a section is the extension's own: money it takes off goes through the cart's
  adjustments, and what it needs to check goes in the `checkout:validate` guard.

  The registry lives in this module, so every script that imports it shares one.
*/

const RESERVED = ['contact', 'billing', 'credits', 'payment'];

const sections = new Map();

const changed = () => window.dispatchEvent(new CustomEvent('checkout-sections-changed'));

export const registerCheckoutSection = (tag, { id = tag, title = '', priority = 0, where = 'panel' } = {}) => {
  if(typeof tag !== 'string' || !tag.includes('-')) throw new Error('A checkout section is a custom element tag, such as k-shipping-address');
  if(!['panel', 'summary'].includes(where)) throw new Error('A checkout section goes in a "panel" or in the "summary"');
  if(where === 'panel' && !title) throw new Error('A checkout panel needs a title');
  if(where === 'panel' && RESERVED.includes(id)) throw new Error(`"${id}" is the checkout's own panel; choose another id`);
  if(where === 'panel' && [...sections.values()].some(section => section.where === 'panel' && section.id === id && section.tag !== tag)){
    throw new Error(`Another checkout panel already has the id "${id}"`);
  }
  sections.set(tag, { tag, id, title, priority, where });
  changed();
};

export const unregisterCheckoutSection = tag => {
  if(sections.delete(tag)) changed();
};

/* The registered sections for a place (`panel` or `summary`), highest priority first. */
export const checkoutSections = where => [...sections.values()]
  .filter(section => section.where === where)
  .sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag));
