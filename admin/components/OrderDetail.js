import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import {
  getOrder, setOrderStatus, addNote, setFulfillment, cancelUnpaid, markPaid, finishRefund,
} from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_COLORS, optionsText, eventText } from '/commerce/utils/format.js';

/*
  One order, as the shop sees it: served at /admin/extension/kempo-commerce/components/OrderDetail.js.

  Everything on the order and everything that happened to it: the lines (each can be marked sent), the
  fees and tax, how it was paid, the customer, the refunds, private notes and ones the customer sees, and
  the whole history. The actions: pause or resume, mark a paid order processing or completed, record a
  payment taken another way, cancel an unpaid order, and refund (its own page).

  Other extensions add panels (a shipment, a fraud score) through the `panels` slot and buttons through
  `actions`.
*/
export default class AdminOrder extends ShadowComponent {
  static properties = {
    order: { state: true },
    events: { state: true },
    error: { state: true },
    message: { state: true },
    busy: { state: true },
    note: { state: true },
    noteVisible: { state: true },
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
    this.order = null;
    this.events = [];
    this.error = '';
    this.message = '';
    this.busy = false;
    this.note = '';
    this.noteVisible = false;
    this.money = minor => String(minor);
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    this.money = (await loadFormat()).money;
    await this.load();
  };

  get id(){
    return new URLSearchParams(location.search).get('id') ?? '';
  }

  load = async () => {
    const [error, data] = await getOrder(this.id);
    if(error){
      this.error = error.msg;
      return;
    }
    this.order = data.order;
    this.events = data.events;
  };

  /* Runs one action, then shows what the server answered. */
  act = async (run, done = '') => {
    this.busy = true;
    this.error = '';
    this.message = '';
    const [error] = await run();
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.message = done;
    await this.load();
  };

  saveNote = async event => {
    event.preventDefault();
    await this.act(() => addNote(this.order.id, this.note, this.noteVisible), this.noteVisible ? 'Note added, and emailed to the customer' : 'Note added');
    this.note = '';
  };

  cancel = () => confirm('Cancel this order? Whatever it took is given back and the quantity is released.') && this.act(() => cancelUnpaid(this.order.id, 'Cancelled by the shop'), 'Order cancelled');

  paid = () => {
    const note = prompt('How was it paid? (cash, a bank transfer...)');
    if(note === null) return;
    return this.act(() => markPaid(this.order.id, note), 'Marked as paid');
  };

  finish = refund => this.act(() => finishRefund(refund.id), 'Refund finished');

  /*
    Rendering
  */

  renderRefund(refund){
    const failed = refund.steps.filter(step => step.status === 'failed');
    return html`
      <li class="mb">
        <strong>${this.money(refund.amount)}</strong> on ${formatDate(refund.createdAt)}${refund.reason ? html` — ${refund.reason}` : nothing}
        ${refund.status === 'issuing' || refund.status === 'partial' ? html`
          <div class="tc-danger">Only partly issued.${failed.map(step => html` “${step.label}” failed: ${step.error}.`)}
            <button class="small" ?disabled=${this.busy} @click=${() => this.finish(refund)}>Try the rest</button></div>` : nothing}
        ${refund.credits ? html`<div class="tc-muted small">Spent credits: ${refund.credits === 'owe' ? 'the customer owes the rest' : 'left at zero'}</div>` : nothing}
      </li>
    `;
  }

  render(){
    if(this.error && !this.order) return html`<p class="tc-danger" role="alert">${this.error}</p><a class="btn" href="/admin/extension/kempo-commerce/">Back to orders</a>`;
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const paid = Boolean(order.paidAt);
    const canRefund = paid && !['pending_payment', 'failed', 'cancelled', 'refunded'].includes(order.status) && order.refundedTotal < order.paidTotal;

    return html`
      <div class="d-f mb" style="align-items: center; gap: var(--spacer);">
        <a href="/admin/extension/kempo-commerce/" class="btn"><k-icon name="arrow" direction="left"></k-icon> Orders</a>
        <h1 class="flex mb0">Order ${order.numberLabel}</h1>
        <strong class=${`h4 mb0 ${STATUS_COLORS[order.status] ?? ''}`}>${statusLabel(order.status)}</strong>
      </div>

      <div aria-live="polite">
        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        ${this.message ? html`<p class="tc-success">${this.message}</p>` : nothing}
      </div>

      <div class="d-f mb" style="gap: var(--spacer_h);">
        ${canRefund ? html`<a class="btn primary" href=${`/admin/extension/kempo-commerce/refund/?order=${encodeURIComponent(order.id)}`}>Refund</a>` : nothing}
        ${order.status === 'pending_payment' || order.status === 'on_hold' && !paid ? html`
          <button ?disabled=${this.busy} @click=${this.paid}>Mark as paid</button>
          <button class="danger" ?disabled=${this.busy} @click=${this.cancel}>Cancel order</button>` : nothing}
        ${paid && order.status === 'processing' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'completed'), 'Marked completed')}>Mark completed</button>` : nothing}
        ${paid && order.status === 'completed' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'processing'), 'Moved back to processing')}>Reopen</button>` : nothing}
        ${['processing', 'pending_payment'].includes(order.status) ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'on_hold'), 'Put on hold')}>Put on hold</button>` : nothing}
        ${order.status === 'on_hold' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, paid ? 'processing' : 'pending_payment'), 'Resumed')}>Resume</button>` : nothing}
        <slot name="actions"></slot>
      </div>

      <div class="row">
        <div class="span-12 d-span-8" style="padding-right: var(--spacer);">
          <div class="table-wrapper mb">
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th class="ta-right">Total</th><th>Fulfilment</th></tr></thead>
              <tbody>
                ${order.lines.map(line => html`<tr>
                  <td><strong>${line.name}</strong>${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}
                    ${line.creditsGranted ? html`<div class="tc-muted small">Gives ${line.creditsGranted * line.quantity} credits</div>` : nothing}
                    ${line.refundedQuantity ? html`<div class="tc-warning small">${line.refundedQuantity} refunded</div>` : nothing}</td>
                  <td>${this.money(line.unitPrice)}</td><td>${line.quantity}</td><td class="ta-right">${this.money(line.lineTotal)}${line.tax && !order.pricesIncludeTax ? html`<div class="tc-muted small">+${this.money(line.tax)} tax</div>` : nothing}</td>
                  <td>${line.fulfillment === 'none' ? html`<span class="tc-muted">Nothing to send</span>`
                    : html`<label class="checkbox m0"><input type="checkbox" .checked=${line.fulfillment === 'done'} ?disabled=${this.busy || !paid} @change=${event => this.act(() => setFulfillment(order.id, line.id, event.target.checked ? 'done' : 'pending'))}> Sent</label>`}</td>
                </tr>`)}
              </tbody>
              <tfoot>
                <tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Subtotal</strong></td><td class="ta-right">${this.money(order.subtotal)}</td><td></td></tr>
                ${order.adjustments.filter(adjustment => adjustment.type !== 'tax').map(adjustment => html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong></td><td class="ta-right">${this.money(adjustment.amount)}</td><td class="tc-muted small">${adjustment.source}</td></tr>`)}
                ${order.taxTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Tax${order.pricesIncludeTax ? ' (included)' : ''}</strong></td><td class="ta-right">${this.money(order.taxTotal)}</td><td></td></tr>` : nothing}
                <tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Total</strong></td><td class="ta-right"><strong>${this.money(order.total)}</strong></td><td></td></tr>
                ${order.refundedTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Refunded</strong></td><td class="ta-right tc-warning">−${this.money(order.refundedTotal)}</td><td></td></tr>` : nothing}
              </tfoot>
            </table>
          </div>

          <slot name="panels"></slot>

          <h2 class="h5">Paid with</h2>
          ${order.tenders.length ? html`<ul class="mb">${order.tenders.map(tender => html`<li>
            ${tender.kind === 'credits' ? `${tender.detail?.credits ?? ''} credits` : tender.kind.replace('-', ' ')} — ${this.money(tender.amount)}
            <span class="tc-muted">(${tender.status}${tender.refundedAmount ? `, ${this.money(tender.refundedAmount)} refunded` : ''})</span></li>`)}</ul>` : html`<p class="tc-muted">Nothing was due.</p>`}

          ${order.refunds.length ? html`<h2 class="h5">Refunds</h2><ul class="mb">${order.refunds.map(refund => this.renderRefund(refund))}</ul>` : nothing}

          <h2 class="h5">Notes</h2>
          ${(order.notes ?? []).map(entry => html`<blockquote class="mb">${entry.body}<div class="small tc-muted">${formatDate(entry.createdAt)} · ${entry.visibleToCustomer ? 'the customer sees this' : 'private'}</div></blockquote>`)}
          <form @submit=${this.saveNote} class="mb">
            <label>Add a note<textarea rows="3" .value=${this.note} required @input=${event => { this.note = event.target.value; }}></textarea></label>
            <label class="checkbox"><input type="checkbox" .checked=${this.noteVisible} @change=${event => { this.noteVisible = event.target.checked; }}> Show to the customer, and email it to them</label>
            <button ?disabled=${this.busy || !this.note.trim()}>Add note</button>
          </form>
        </div>

        <div class="span-12 d-span-4">
          <h2 class="h5">Customer</h2>
          <p class="mb">
            <strong>${order.billing?.name}</strong><br>
            ${order.email}${order.userId ? html` · <span class="tc-muted">account</span>` : html` · <span class="tc-muted">guest</span>`}<br>
            ${[order.billing?.line1, order.billing?.line2, order.billing?.city, order.billing?.state, order.billing?.postalCode, order.billing?.country].filter(Boolean).join(', ')}
          </p>
          <h2 class="h5">History</h2>
          <ul class="mb">${this.events.map(event => html`<li><span class="tc-muted small">${formatDate(event.createdAt)}${event.actor && event.actor !== 'system' ? ` · ${event.actor}` : ''}</span><br>${eventText(event)}${event.visible ? '' : html` <span class="tc-muted small">(private)</span>`}</li>`)}</ul>
          ${order.placedAt ? html`<p class="small tc-muted">Placed ${formatDate(order.placedAt)}${order.paidAt ? `, paid ${formatDate(order.paidAt)}` : ''}</p>` : nothing}
        </div>
      </div>
    `;
  }
}

customElements.define('k-commerce-admin-order', AdminOrder);
