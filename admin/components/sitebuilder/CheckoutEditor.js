import { html } from '/kempo-ui/lit-all.min.js';
import Checkout from '/commerce/components/Checkout.js';
import { loadFormat } from '/commerce/utils/format.js';
import { getRegions } from '/commerce/sdk.js';
import sampleQuote from './sampleQuote.js';

/*
  The Checkout as the page builder shows it: the same checkout, drawn by the same component, with a sample order in place of
  the visitor's cart. It never reads or sends anything about an order: the totals stay as they are, the card is a
  placeholder (the real card fields would load the payment processor into the editor), the sections other extensions add
  are named but not drawn, and the button does nothing.
*/
export default class CheckoutEditor extends Checkout {
  start = async () => {
    const format = await loadFormat();
    this.money = format.money;
    this.decimals = format.config.decimals ?? 2;
    getRegions().then(([, regions]) => { this.regions = regions; });
    this.quote = sampleQuote();
  };

  refresh = async () => {};

  reprice = async () => {};

  place = async event => {
    event?.preventDefault?.();
  };

  renderSectionBody({ title }){
    return html`<p class="tc-muted">${title}: drawn by the extension that adds it, on the page.</p>`;
  }

  renderPayment(){
    return html`
      <p class="small tc-muted">Your card details go straight to our payment processor. They never touch this site.</p>
      <label class="mb">Card details<input type="text" placeholder="Card number, expiry, security code" disabled></label>
    `;
  }
}

customElements.define('k-commerce-checkout-editor', CheckoutEditor);
