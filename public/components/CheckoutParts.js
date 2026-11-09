import LightComponent from '/kempo-ui/components/LightComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/commerce/components/Checkout.js';

/*
  The pieces of the checkout page, for a layout built in the page builder (or by hand): put them inside a
  `<k-commerce-checkout>` and it holds the order and draws none of its own layout, so the pieces can go anywhere inside it,
  in columns or rows, in any order. Each finds the checkout with `closest('k-commerce-checkout')` (or the page builder's
  copy of it), draws what the checkout draws for that part, and draws again when the checkout does.

    <k-commerce-checkout-contact-widget>    who the customer is, an account if one is wanted, and what extensions ask for
    <k-commerce-checkout-billing-widget>    the billing address (which sets the tax)
    <k-commerce-checkout-credits-widget>    store credit and credits, when the customer has any to spend
    <k-commerce-checkout-payment-widget>    the card, when anything is to be paid by it
    <k-commerce-checkout-sections-widget>   the sections other extensions add (a shipping address)
    <k-commerce-checkout-summary-widget>    the order and its totals, and what extensions put under them
    <k-commerce-checkout-place-widget>      the problems, and the button that places the order

  They are light DOM, like the checkout, because the card fields cannot be drawn inside a shadow root. With nothing in the
  cart none of them draws, and the checkout says the cart is empty.
*/
class CheckoutPart extends LightComponent {
  connectedCallback(){
    super.connectedCallback();
    this.checkout = this.closest('k-commerce-checkout, k-commerce-checkout-editor');
    this.checkout?.addEventListener('checkout-change', this.refresh);
    this.requestUpdate();
  }

  disconnectedCallback(){
    this.checkout?.removeEventListener('checkout-change', this.refresh);
    super.disconnectedCallback();
  }

  refresh = () => this.requestUpdate();

  /* What the piece draws, from the checkout; nothing when it has nothing to show. */
  renderPart(){
    return nothing;
  }

  renderLightDom(){
    if(!this.checkout) return html`<p class="tc-muted">Place this in a Checkout</p>`;
    const { quote } = this.checkout;
    if(!quote || quote.empty) return nothing;
    return this.renderPart(this.checkout);
  }
}

class CheckoutContact extends CheckoutPart {
  renderPart(checkout){
    return html`<h2 class="h4">Contact</h2>${checkout.renderContact()}`;
  }
}

class CheckoutBilling extends CheckoutPart {
  renderPart(checkout){
    return html`<h2 class="h4">Billing address</h2>${checkout.renderBilling()}`;
  }
}

class CheckoutCredits extends CheckoutPart {
  renderPart(checkout){
    return checkout.creditsShown ? html`<h2 class="h4">Store credit and credits</h2>${checkout.renderCredits()}` : nothing;
  }
}

class CheckoutPayment extends CheckoutPart {
  renderPart(checkout){
    return checkout.paymentShown ? html`<h2 class="h4">Payment</h2>${checkout.renderPayment()}` : nothing;
  }
}

class CheckoutSections extends CheckoutPart {
  renderPart(checkout){
    return checkout.renderSections();
  }
}

class CheckoutSummary extends CheckoutPart {
  renderPart(checkout){
    return html`${checkout.renderSummary()}${checkout.renderSummarySections()}`;
  }
}

class CheckoutPlace extends CheckoutPart {
  renderPart(checkout){
    return html`${checkout.renderMessages()}${checkout.renderPlaceOrder({ standalone: true })}`;
  }
}

customElements.define('k-commerce-checkout-contact-widget', CheckoutContact);
customElements.define('k-commerce-checkout-billing-widget', CheckoutBilling);
customElements.define('k-commerce-checkout-credits-widget', CheckoutCredits);
customElements.define('k-commerce-checkout-payment-widget', CheckoutPayment);
customElements.define('k-commerce-checkout-sections-widget', CheckoutSections);
customElements.define('k-commerce-checkout-summary-widget', CheckoutSummary);
customElements.define('k-commerce-checkout-place-widget', CheckoutPlace);
