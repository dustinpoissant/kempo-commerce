import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Tabs.js';
import '/kempo-ui/components/Dialog.js';
import Toast from '/kempo-ui/components/Toast.js';
import {
  getOrder, setOrderStatus, addNote, setFulfillment, cancelUnpaid, markPaid, finishRefund, contactCustomer,
} from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_COLORS, optionsText, eventText, itemNames } from '/commerce/utils/format.js';

/*
  One order, as the shop sees it: served at /admin/extension/kempo-commerce/components/OrderDetail.js.

  The page is a row of actions (pause or resume, mark a paid order processing or completed, record a payment taken another way,
  cancel an unpaid order, refund) over tabs:

    Items       what was bought, the fees and tax, and whether each line has been sent
    Payment     how it was paid, and the refunds
    Customer    who it is for, and a button that opens a dialog to email them
    History     everything that happened to the order, and the notes

  **Other extensions add tabs** by filling the `commerce-admin-order-tabs` location on the order page with a
  `k-commerce-order-tab` element that names the tab and says where it goes among the others:

    <k-commerce-order-tab name="shipping" label="Shipping" position="300"> ...anything... </k-commerce-order-tab>

  `position` orders the tabs: Items is 100, Payment 200, Customer 400 and History 1000, and a tab with none goes at 600,
  between Customer and History. The extension's script finds the order the page is showing in `?id=` of the address, or by
  asking this element (`closest('k-commerce-admin-order').order`). A tab's content is slotted in, so it keeps its own styles.
  The older `panels` slot (content under the items) and `actions` slot (buttons in the row) still work.
*/
const CORE_POSITIONS = { items: 100, payment: 200, customer: 400, history: 1000 };
const DEFAULT_TAB_POSITION = 600;

export default class AdminOrder extends ShadowComponent {
  static properties = {
    order: { state: true },
    events: { state: true },
    error: { state: true },
    message: { state: true },
    busy: { state: true },
    note: { state: true },
    noteVisible: { state: true },
    emailSubject: { state: true },
    emailBody: { state: true },
    extensionTabs: { state: true },
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
    this.emailSubject = '';
    this.emailBody = '';
    this.extensionTabs = [];
    this.money = minor => String(minor);
  }

  connectedCallback(){
    super.connectedCallback();
    /* The tabs other extensions put on the page, each slotted into a tab of its own. */
    this.extensionTabs = [...this.querySelectorAll(':scope > k-commerce-order-tab')].map(($tab, index) => {
      const name = $tab.getAttribute('name') || $tab.getAttribute('label') || `tab-${index}`;
      $tab.slot = `tab-${name}`;
      $tab.style.display = 'block';
      return { id: name, slotName: `tab-${name}`, label: $tab.getAttribute('label') || name, position: Number($tab.getAttribute('position')) || DEFAULT_TAB_POSITION, extension: true };
    });
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

  openEmail = () => this.renderRoot.querySelector('#emailDialog').open();

  /* The dialog's Send button: the dialog stays open until the email is sent, so a failure does not lose what was typed. */
  confirmEmail = event => {
    event.keepDialogOpen = true;
    this.sendEmail();
  };

  sendEmail = async () => {
    if(!this.emailSubject.trim() || !this.emailBody.trim()){
      Toast.error('Write a subject and a message');
      return;
    }
    this.busy = true;
    this.error = '';
    const [error, result] = await contactCustomer(this.order.id, this.emailSubject, this.emailBody);
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    this.renderRoot.querySelector('#emailDialog').close();
    Toast.success(`Email sent to ${result.to}`);
    this.emailSubject = '';
    this.emailBody = '';
    await this.load();
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

  renderItems(order, paid){
    return html`
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
            ${order.adjustments.filter(adjustment => adjustment.type !== 'tax').map(adjustment => html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong>${itemNames(adjustment.lineId, order.lines) ? html`<small class="d-b tc-muted">${itemNames(adjustment.lineId, order.lines)}</small>` : ''}</td><td class="ta-right">${this.money(adjustment.amount)}</td><td class="tc-muted small">${adjustment.source}</td></tr>`)}
            ${order.taxTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Tax${order.pricesIncludeTax ? ' (included)' : ''}</strong></td><td class="ta-right">${this.money(order.taxTotal)}</td><td></td></tr>` : nothing}
            <tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Total</strong></td><td class="ta-right"><strong>${this.money(order.total)}</strong></td><td></td></tr>
            ${order.refundedTotal ? html`<tr><td colspan="3" class="ta-right" style="background-color: var(--c_bg__alt);"><strong>Refunded</strong></td><td class="ta-right tc-warning">−${this.money(order.refundedTotal)}</td><td></td></tr>` : nothing}
          </tfoot>
        </table>
      </div>
      <slot name="panels"></slot>
    `;
  }

  renderPayment(order, canRefund){
    return html`
      <h2 class="h5">Paid with</h2>
      ${order.tenders.length ? html`<ul class="mb">${order.tenders.map(tender => html`<li>
        ${tender.kind === 'credits' ? `${tender.detail?.credits ?? ''} credits` : tender.kind.replace('-', ' ')} — ${this.money(tender.amount)}
        <span class="tc-muted">(${tender.status}${tender.refundedAmount ? `, ${this.money(tender.refundedAmount)} refunded` : ''})</span>
        ${tender.kind === 'card' && tender.reference ? html` <a href=${`/admin/extension/kempo-payments/?payment=${encodeURIComponent(tender.reference)}`}>See the payment</a>` : nothing}</li>`)}</ul>` : html`<p class="tc-muted mb">Nothing was due.</p>`}

      <p class="mb">
        <strong>Total</strong> ${this.money(order.total)}
        ${order.paidAt ? html`<span class="tc-muted"> · paid ${formatDate(order.paidAt)}</span>` : html`<span class="tc-warning"> · not paid</span>`}
        ${order.refundedTotal ? html`<br><span class="tc-warning">${this.money(order.refundedTotal)} refunded</span>` : nothing}
      </p>
      ${canRefund ? html`<p class="mb"><a class="btn primary" href=${`/admin/extension/kempo-commerce/refund/?order=${encodeURIComponent(order.id)}`}>Refund</a></p>` : nothing}

      ${order.refunds.length ? html`<h2 class="h5">Refunds</h2><ul class="mb">${order.refunds.map(refund => this.renderRefund(refund))}</ul>` : nothing}
    `;
  }

  renderCustomer(order){
    const billing = order.billing ?? {};
    return html`
      <h2 class="h5">Customer</h2>
      <p class="mb">
        <strong>${billing.name}</strong><br>
        ${order.email}${order.userId ? html` · <span class="tc-muted">has an account</span>` : html` · <span class="tc-muted">guest</span>`}
      </p>
      <h3 class="h6">Billing address</h3>
      <p class="mb">${[billing.line1, billing.line2, billing.city, billing.state, billing.postalCode, billing.country].filter(Boolean).join(', ') || html`<span class="tc-muted">None kept</span>`}</p>

      <h2 class="h5">Contact</h2>
      ${order.email ? html`
        <p class="mb">${order.email}</p>
        <p class="tc-muted mb">An email goes to this address, looks like the shop's other order emails, and is noted in the order's history.</p>
        <button class="mb" @click=${this.openEmail}>Email the customer</button>
        <k-dialog id="emailDialog" style="--width: 40rem;" confirm-text="Send email" confirm-classes="primary ml" cancel-text="Cancel" .confirmAction=${this.confirmEmail}>
          <h2 slot="title" class="h5 pyh px m0">Email ${order.email}</h2>
          <div class="p">
            <label class="mb">Subject<input type="text" maxlength="200" .value=${this.emailSubject} @input=${event => { this.emailSubject = event.target.value; }}></label>
            <label class="mb">Message<textarea rows="8" maxlength="5000" .value=${this.emailBody} @input=${event => { this.emailBody = event.target.value; }}></textarea></label>
          </div>
        </k-dialog>
      ` : html`<p class="tc-muted mb">This order has no email address.</p>`}
    `;
  }

  renderHistory(order){
    return html`
      <h2 class="h5">History</h2>
      <ul class="mb">${this.events.map(event => html`<li class="mb"><span class="tc-muted small">${formatDate(event.createdAt)}${event.actorName ? ` · ${event.actorName}` : ''}</span><br>${eventText(event)}${event.visible ? '' : html` <span class="tc-muted small">(private)</span>`}</li>`)}</ul>
      ${order.placedAt ? html`<p class="small tc-muted mb">Placed ${formatDate(order.placedAt)}${order.paidAt ? `, paid ${formatDate(order.paidAt)}` : ''}</p>` : nothing}

      <h2 class="h5">Notes</h2>
      ${(order.notes ?? []).map(entry => html`<blockquote class="mb">${entry.body}<div class="small tc-muted">${formatDate(entry.createdAt)} · ${entry.visibleToCustomer ? 'the customer sees this' : 'private'}</div></blockquote>`)}
      <form @submit=${this.saveNote} class="mb">
        <label class="mb">Add a note<textarea rows="3" .value=${this.note} required @input=${event => { this.note = event.target.value; }}></textarea></label>
        <label class="checkbox mb"><input type="checkbox" .checked=${this.noteVisible} @change=${event => { this.noteVisible = event.target.checked; }}> Show to the customer, and email it to them</label>
        <button ?disabled=${this.busy || !this.note.trim()}>Add note</button>
      </form>
    `;
  }

  render(){
    if(this.error && !this.order) return html`<p class="tc-danger mb" role="alert">${this.error}</p><a class="btn" href="/admin/extension/kempo-commerce/">Back to orders</a>`;
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const paid = Boolean(order.paidAt);
    const canRefund = paid && !['pending_payment', 'failed', 'cancelled', 'refunded'].includes(order.status) && order.refundedTotal < order.paidTotal;

    const tabs = [
      { id: 'items', label: 'Items', position: CORE_POSITIONS.items, content: () => this.renderItems(order, paid) },
      { id: 'payment', label: 'Payment', position: CORE_POSITIONS.payment, content: () => this.renderPayment(order, canRefund) },
      { id: 'customer', label: 'Customer', position: CORE_POSITIONS.customer, content: () => this.renderCustomer(order) },
      { id: 'history', label: 'History', position: CORE_POSITIONS.history, content: () => this.renderHistory(order) },
      ...this.extensionTabs,
    ].sort((a, b) => a.position - b.position);

    return html`
      <div class="d-f mb" style="align-items: center; gap: var(--spacer);">
        <a href="/admin/extension/kempo-commerce/" class="btn"><k-icon name="arrow" direction="left"></k-icon> Orders</a>
        <h1 class="flex mb0">Order ${order.numberLabel}</h1>
        <strong class=${`h4 mb0 ${STATUS_COLORS[order.status] ?? ''}`}>${statusLabel(order.status)}</strong>
      </div>

      <div aria-live="polite">
        ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
        ${this.message ? html`<p class="tc-success mb">${this.message}</p>` : nothing}
      </div>

      <div class="d-f mb" style="gap: var(--spacer_h);">
        ${canRefund ? html`<a class="btn primary" href=${`/admin/extension/kempo-commerce/refund/?order=${encodeURIComponent(order.id)}`}>Refund</a>` : nothing}
        <a class="btn" href=${`/commerce/api/orders/${encodeURIComponent(order.id)}/packing-slip`} target="_blank" rel="noopener">Packing slip</a>
        ${order.status === 'pending_payment' || order.status === 'on_hold' && !paid ? html`
          <button ?disabled=${this.busy} @click=${this.paid}>Mark as paid</button>
          <button class="danger" ?disabled=${this.busy} @click=${this.cancel}>Cancel order</button>` : nothing}
        ${paid && order.status === 'processing' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'completed'), 'Marked completed')}>Mark completed</button>` : nothing}
        ${paid && order.status === 'completed' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'processing'), 'Moved back to processing')}>Reopen</button>` : nothing}
        ${['processing', 'pending_payment'].includes(order.status) ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, 'on_hold'), 'Put on hold')}>Put on hold</button>` : nothing}
        ${order.status === 'on_hold' ? html`<button ?disabled=${this.busy} @click=${() => this.act(() => setOrderStatus(order.id, paid ? 'processing' : 'pending_payment'), 'Resumed')}>Resume</button>` : nothing}
        <slot name="actions"></slot>
      </div>

      <k-tabs class="mb">
        ${tabs.map(tab => html`<k-tab for=${tab.id}>${tab.label}</k-tab>`)}
        ${tabs.map(tab => html`<k-tab-content name=${tab.id} class="pt">${tab.extension ? html`<slot name=${tab.slotName}></slot>` : tab.content()}</k-tab-content>`)}
      </k-tabs>
    `;
  }
}

customElements.define('k-commerce-admin-order', AdminOrder);
