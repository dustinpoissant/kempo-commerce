import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { getOrder, previewRefund, refundOrder } from '/commerce/sdk.js';
import { loadFormat, optionsText } from '/commerce/utils/format.js';

/*
  The refund screen, served at /admin/extension/kempo-commerce/components/Refund.js and opened as
  /admin/extension/kempo-commerce/refund/?order=<id>.

  Pick lines and how many of each, or enter an amount; say why; choose whether the products go back in
  quantity and where the card money goes. The numbers shown are the server's, calculated again on every
  change, and issuing runs the same calculation again.

  **The credits warning.** When the products gave the customer credits and they have already spent some,
  the refund cannot take them all back. The screen says how many they spent, links to their credits
  history (to see whether this is someone buying an item, spending the bonus credits on another and
  asking for the first to be refunded), and makes the administrator choose before it can be issued:
  take what they hold and leave them at zero, or take all of it and leave them owing the rest.
*/
export default class AdminRefund extends ShadowComponent {
  static properties = {
    order: { state: true },
    quantities: { state: true },
    includeFees: { state: true },
    amount: { state: true },
    mode: { state: true },
    reason: { state: true },
    restock: { state: true },
    destination: { state: true },
    credits: { state: true },
    preview: { state: true },
    error: { state: true },
    busy: { state: true },
    pricing: { state: true },
  };

  constructor(){
    super();
    this.order = null;
    this.quantities = {};
    this.includeFees = false;
    this.amount = '';
    this.mode = 'lines';
    this.reason = '';
    this.restock = true;
    this.destination = 'original';
    this.credits = '';
    this.preview = null;
    this.error = '';
    this.busy = false;
    this.pricing = false;
    this.money = minor => String(minor);
    this.decimals = 2;
    this.timer = null;
    this.request = 0;
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    const { money, config } = await loadFormat();
    this.money = money;
    this.decimals = config.decimals;
    const [error, data] = await getOrder(new URLSearchParams(location.search).get('order') ?? '');
    if(error){
      this.error = error.msg;
      return;
    }
    this.order = data.order;
  };

  /* "12.50" -> 1250 */
  get amountMinor(){
    const text = String(this.amount).trim();
    if(!/^\d+(\.\d+)?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    if(fraction.length > this.decimals) return null;
    return Number(whole) * 10 ** this.decimals + Number(fraction.padEnd(this.decimals, '0') || 0);
  }

  get options(){
    const lines = Object.fromEntries(Object.entries(this.quantities).filter(([, quantity]) => Number(quantity) > 0).map(([id, quantity]) => [id, Number(quantity)]));
    return {
      orderId: this.order.id,
      ...(this.mode === 'lines' ? { lines, includeFees: this.includeFees } : { amount: this.amountMinor }),
      destination: this.destination,
      restock: this.restock,
    };
  }

  get ready(){
    return this.mode === 'lines' ? Object.keys(this.options.lines ?? {}).length > 0 : this.amountMinor > 0;
  }

  /*
    Event handlers
  */

  changed = () => {
    clearTimeout(this.timer);
    this.preview = null;
    this.error = '';
    if(!this.ready) return;
    this.timer = setTimeout(this.reprice, 250);
  };

  reprice = async () => {
    const request = ++this.request;
    this.pricing = true;
    const [error, data] = await previewRefund(this.options);
    if(request !== this.request) return;
    this.pricing = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.preview = data.preview;
  };

  setQuantity = (line, event) => {
    this.quantities = { ...this.quantities, [line.id]: event.target.value };
    this.changed();
  };

  set = (name, event) => {
    this[name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if(['mode', 'includeFees', 'amount', 'restock', 'destination'].includes(name)) this.changed();
  };

  issue = async event => {
    event.preventDefault();
    this.busy = true;
    this.error = '';
    const [error, data] = await refundOrder(this.order.id, { ...this.options, reason: this.reason, credits: this.credits || null });
    this.busy = false;
    if(error){
      if(error.preview) this.preview = error.preview;
      this.error = error.msg;
      return;
    }
    location.href = `/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(data.order.id)}`;
  };

  /*
    Rendering
  */

  renderCredits(){
    const credits = this.preview?.credits;
    if(!credits) return nothing;
    if(!credits.shortfall) return html`<p class="tc-muted">This refund takes back ${credits.given} credits the customer was given. They still hold them.</p>`;
    return html`
      <div class="card mb" role="alert">
        <p><strong>The customer has already spent ${credits.shortfall} of the ${credits.given} credits this refund takes back.</strong></p>
        <p>They hold ${credits.held}. You can take back what they hold and leave them at zero, or take all ${credits.given} and leave them owing ${credits.shortfall}.</p>
        <p><a href=${credits.historyUrl} target="_blank" rel="noopener">View their credits history <k-icon name="open_in_new"></k-icon></a> (this opens in a new tab) to see where they went before you decide.</p>
        <label class="radio"><input type="radio" name="credits" value="zero" .checked=${this.credits === 'zero'} @change=${event => this.set('credits', event)}> Leave them at zero</label>
        <label class="radio"><input type="radio" name="credits" value="owe" .checked=${this.credits === 'owe'} @change=${event => this.set('credits', event)}> Leave them owing ${credits.shortfall}</label>
      </div>
    `;
  }

  render(){
    if(this.error && !this.order) return html`<p class="tc-danger" role="alert">${this.error}</p>`;
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order, preview } = this;
    const needsDecision = preview?.credits?.shortfall > 0 && !this.credits;

    return html`
      <div class="d-f mb" style="align-items: center; gap: var(--spacer);">
        <a href=${`/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(order.id)}`} class="btn"><k-icon name="arrow" direction="left"></k-icon> Order ${order.numberLabel}</a>
        <h1 class="flex mb0">Refund</h1>
      </div>
      <p class="tc-muted">Paid ${this.money(order.paidTotal)}, ${this.money(order.refundedTotal)} already refunded. Spent credits are never refunded as money.</p>

      <form @submit=${this.issue}>
        <div class="mb">
          <label class="radio"><input type="radio" name="mode" value="lines" .checked=${this.mode === 'lines'} @change=${event => this.set('mode', event)}> Refund products</label>
          <label class="radio"><input type="radio" name="mode" value="amount" .checked=${this.mode === 'amount'} @change=${event => this.set('mode', event)}> Refund an amount</label>
        </div>

        ${this.mode === 'lines' ? html`
          <div class="table-wrapper mb">
            <table>
              <thead><tr><th>Product</th><th>Paid</th><th>Already refunded</th><th>Refund how many</th></tr></thead>
              <tbody>
                ${order.lines.map(line => {
                  const left = line.quantity - line.refundedQuantity;
                  return html`<tr>
                    <td>${line.name}${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}</td>
                    <td>${line.quantity} × ${this.money(line.unitPrice)}</td>
                    <td>${line.refundedQuantity}</td>
                    <td><label class="m0"><span class="small tc-muted">How many of ${line.name} (up to ${left})</span>
                      <input type="number" min="0" max=${left} ?disabled=${left < 1} .value=${String(this.quantities[line.id] ?? '')} @input=${event => this.setQuantity(line, event)} style="max-width: 6rem;"></label></td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>
          ${order.feeTotal ? html`<label class="checkbox mb"><input type="checkbox" .checked=${this.includeFees} @change=${event => this.set('includeFees', event)}> Refund the fees too (${this.money(order.feeTotal)})</label>` : nothing}
        ` : html`
          <label class="mb">Amount to refund<small class="tc-muted d-b">Up to ${this.money(order.paidTotal - order.refundedTotal)}, in the store's currency</small>
            <input type="text" inputmode="decimal" .value=${this.amount} @input=${event => this.set('amount', event)} style="max-width: 12rem;"></label>
        `}

        <label class="mb">Reason<small class="tc-muted d-b">Kept with the refund, and shown to the customer in their email</small>
          <input type="text" .value=${this.reason} maxlength="1000" @input=${event => this.set('reason', event)}></label>

        <label class="checkbox mb"><input type="checkbox" .checked=${this.restock} @change=${event => this.set('restock', event)}> Put the products back in stock</label>

        ${order.userId ? html`
          <label class="mb">Where the card money goes
            <select .value=${this.destination} @change=${event => this.set('destination', event)}>
              <option value="original" ?selected=${this.destination === 'original'}>Back to the card</option>
              <option value="store-credit" ?selected=${this.destination === 'store-credit'}>To the customer's store credit</option>
            </select></label>
        ` : nothing}

        <div aria-live="polite">
          ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
          ${this.pricing ? html`<k-spinner size="xs"></k-spinner>` : nothing}
        </div>

        ${preview ? html`
          <div class="card mb">
            <h2 class="h5">This refund</h2>
            <p class="h3 mb">${this.money(preview.amount)}</p>
            <ul class="mb">${preview.tenders.map(tender => html`<li>${tender.viaStoreCredit ? 'Store credit (instead of the card)' : tender.label}: ${this.money(tender.amount)}</li>`)}</ul>
            ${preview.warnings.map(warning => html`<p class="tc-warning">${warning}</p>`)}
            ${preview.blocked ? html`<p class="tc-danger" role="alert">${preview.blocked}</p>` : nothing}
          </div>
          ${this.renderCredits()}
        ` : nothing}

        <button class="primary" ?disabled=${this.busy || !preview || Boolean(preview.blocked) || needsDecision}>${this.busy ? 'Refunding…' : 'Issue refund'}</button>
        ${needsDecision ? html`<span class="tc-muted"> Choose what happens to the spent credits first.</span>` : nothing}
      </form>
    `;
  }
}

customElements.define('k-commerce-admin-refund', AdminRefund);
