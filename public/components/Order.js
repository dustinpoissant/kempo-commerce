import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { getMyOrder, getOrderByKey, cancelOrder, cancelOrderByKey, confirmPayment } from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_COLORS, optionsText, eventText } from '/commerce/utils/format.js';

/*
  One order, served at /commerce/components/Order.js.

  ```html
  <script type="module" src="/commerce/components/Order.js"></script>
  <k-commerce-order></k-commerce-order>            <!-- the id comes from the address -->
  <k-commerce-order received></k-commerce-order>   <!-- the "thank you" page: waits for the payment to be confirmed -->
  ```

  A signed-in customer sees their own order; a guest sees theirs with the `key` in the address of their
  link (`?key=...`). Either can cancel it while it is unpaid, as in WooCommerce; a paid order is
  refunded by the shop, not cancelled here. With `received` it asks the server to check the payment
  every few seconds until the order is paid, because the browser telling us it paid is not proof.

  Other extensions add panels (tracking, downloads) through the `panels` slot, and buttons through
  `actions`.
*/

const ADDRESS = /\/(?:order|orders)\/([^/]+)\//;

export default class Order extends ShadowComponent {
  static properties = {
    orderId: { type: String, attribute: 'order-id' },
    received: { type: Boolean },
    order: { state: true },
    events: { state: true },
    error: { state: true },
    busy: { state: true },
    waited: { state: true },
  };

  /* kempo-css rounds the last row of every body, which is wrong when a footer follows it. */
  static styles = css`
    tbody:not(:last-child) tr:last-child td {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }
  `;

  constructor(){
    super();
    this.orderId = '';
    this.received = false;
    this.order = null;
    this.events = [];
    this.error = '';
    this.busy = false;
    this.waited = 0;
    this.money = minor => String(minor);
    this.poll = null;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    clearTimeout(this.poll);
  }

  start = async () => {
    this.money = (await loadFormat()).money;
    await this.load();
    if(this.received) this.watch();
  };

  /*
    Utility functions
  */

  get id(){
    return this.orderId || ADDRESS.exec(location.pathname)?.[1] || location.pathname.split('/').filter(Boolean).at(-1) || '';
  }

  get key(){
    return new URLSearchParams(location.search).get('key') || '';
  }

  load = async () => {
    const id = decodeURIComponent(this.id);
    const [error, data] = this.key ? await getOrderByKey(id, this.key) : await getMyOrder(id);
    if(error){
      this.error = error.code === 401 || error.code === 404
        ? 'We could not find that order. If you ordered as a guest, use the link from your email; otherwise sign in to the account you ordered with.'
        : error.msg;
      return;
    }
    this.error = '';
    this.order = data.order;
    this.events = data.events ?? [];
  };

  /* After paying, ask the server (which asks the processor) until the order moves on, for up to two minutes. */
  watch = () => {
    if(!this.order || this.order.status !== 'pending_payment' || this.waited > 40) return;
    this.poll = setTimeout(async () => {
      this.waited++;
      await confirmPayment(this.order.id, this.key);
      await this.load();
      this.watch();
    }, 3000);
  };

  cancel = async () => {
    if(!confirm('Cancel this order? Nothing has been charged.')) return;
    this.busy = true;
    const [error, data] = await (this.key ? cancelOrderByKey(this.order.id, this.key) : cancelOrder(this.order.id));
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.order = data.order;
    await this.load();
  };

  /*
    Rendering
  */

  renderHeading(){
    const { order } = this;
    if(this.received){
      if(order.status === 'pending_payment') return html`<h1>Waiting for your payment</h1><p><k-spinner size="xs"></k-spinner> We are checking with the payment processor. This page updates by itself.</p>`;
      if(order.status === 'failed' || order.status === 'cancelled') return html`<h1>This order was not completed</h1><p>Nothing was charged. You can go back to your cart and try again.</p>`;
      return html`<h1>Thank you</h1><p>We received your order and your payment. A receipt was sent to <strong>${order.email}</strong>.</p>`;
    }
    return html`<h1>Order ${order.numberLabel}</h1>`;
  }

  render(){
    if(this.error) return html`<p class="tc-danger" role="alert">${this.error}</p>`;
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const visibleNotes = order.notes ?? [];

    return html`
      ${this.renderHeading()}
      <p>
        ${this.received ? html`<strong>${order.numberLabel}</strong> · ` : nothing}
        Placed ${formatDate(order.placedAt)} ·
        <strong class=${STATUS_COLORS[order.status] ?? ''}>${statusLabel(order.status)}</strong>
      </p>

      <div class="table-wrapper mb">
        <table>
          <thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th class="ta-right">Total</th></tr></thead>
          <tbody>
            ${order.lines.map(line => html`<tr>
              <td>${line.name}${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}
                ${line.creditsGranted ? html`<div class="tc-success small">${line.creditsGranted * line.quantity} credits ${order.paidAt ? 'added to your account' : 'once paid'}</div>` : nothing}
                ${line.fulfillment === 'pending' && order.paidAt ? html`<div class="tc-muted small">Being prepared</div>` : nothing}
                ${line.fulfillment === 'done' ? html`<div class="tc-success small">Sent</div>` : nothing}</td>
              <td>${this.money(line.unitPrice)}</td><td>${line.quantity}</td><td class="ta-right">${this.money(line.lineTotal)}</td>
            </tr>`)}
          </tbody>
          <tfoot>
            <tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Subtotal</strong></td><td class="ta-right">${this.money(order.subtotal)}</td></tr>
            ${order.adjustments.filter(adjustment => adjustment.type !== 'tax').map(adjustment => html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong></td><td class="ta-right">${this.money(adjustment.amount)}</td></tr>`)}
            ${order.taxTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Tax${order.pricesIncludeTax ? ' (included)' : ''}</strong></td><td class="ta-right">${this.money(order.taxTotal)}</td></tr>` : nothing}
            <tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Total</strong></td><td class="ta-right"><strong>${this.money(order.total)}</strong></td></tr>
            ${order.refundedTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Refunded</strong></td><td class="ta-right">−${this.money(order.refundedTotal)}</td></tr>` : nothing}
          </tfoot>
        </table>
      </div>

      ${order.tenders.some(tender => tender.status !== 'reversed') ? html`
        <h2 class="h5">Paid with</h2>
        <ul class="mb">${order.tenders.filter(tender => tender.status !== 'reversed').map(tender => html`<li>${tender.kind === 'card' ? 'Card' : tender.kind === 'store-credit' ? 'Store credit' : tender.kind === 'credits' ? `${tender.detail?.credits ?? ''} credits` : tender.kind} — ${this.money(tender.amount)}</li>`)}</ul>
      ` : nothing}

      <slot name="panels"></slot>

      ${visibleNotes.length ? html`<h2 class="h5">Notes from the shop</h2>${visibleNotes.map(note => html`<blockquote class="mb">${note.body}<div class="small tc-muted">${formatDate(note.createdAt)}</div></blockquote>`)}` : nothing}

      ${this.events.length ? html`<h2 class="h5">History</h2><ul class="mb">${this.events.map(event => html`<li><span class="tc-muted">${formatDate(event.createdAt)}</span> — ${eventText(event)}</li>`)}</ul>` : nothing}

      <div class="d-f" style="gap: var(--spacer_h);">
        <slot name="actions"></slot>
        ${order.status === 'pending_payment' ? html`<button class="danger" ?disabled=${this.busy} @click=${this.cancel}>Cancel this order</button>` : nothing}
        ${this.received ? html`<a class="btn" href="/products/">Keep shopping</a>` : nothing}
        ${order.status === 'failed' || order.status === 'cancelled' ? html`<a class="btn primary" href="/cart/">Back to your cart</a>` : nothing}
      </div>
    `;
  }
}

customElements.define('k-commerce-order', Order);
