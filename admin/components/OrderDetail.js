import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import Toast from '/kempo-ui/components/Toast.js';
import { getOrder, setOrderStatus, cancelUnpaid, markPaid } from '/commerce/sdk.js';
import { formatDate, statusLabel, STATUS_COLORS } from '/commerce/utils/format.js';

/*
  The top of one order's admin page, served at /admin/extension/kempo-commerce/components/OrderDetail.js: its number and status,
  and the actions that move it along (mark paid, complete, reopen, hold, resume, cancel, refund). The tabs below are the page's own
  (order/index.page.html), each a component of its own.

  Whenever an action changes the order it dispatches `orderChanged`, which bubbles to the order page's `#order` wrapper, and every
  part of the page reloads. Feedback is a toast.
*/
export default class AdminOrder extends ShadowComponent {
  static properties = {
    order: { state: true },
    error: { state: true },
    busy: { state: true },
  };

  constructor(){
    super();
    this.order = null;
    this.error = '';
    this.busy = false;
  }

  connectedCallback(){
    super.connectedCallback();
    this.closest('#order')?.addEventListener('orderChanged', this.load);
    this.load();
  }

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
  };

  /* Runs one action, announces the change when it worked, and shows what the server answered. */
  act = async (run, done = '') => {
    this.busy = true;
    const [error] = await run();
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    if(done) Toast.success(done);
    this.dispatchEvent(new CustomEvent('orderChanged', { bubbles: true }));
  };

  paid = () => {
    const note = prompt('How was it paid? (cash, a bank transfer...)');
    if(note === null) return;
    return this.act(() => markPaid(this.order.id, note), 'Marked as paid');
  };

  cancel = () => confirm('Cancel this order? Whatever it took is given back and the quantity is released.') && this.act(() => cancelUnpaid(this.order.id, 'Cancelled by the shop'), 'Order cancelled');

  render(){
    if(this.error && !this.order) return html`<p class="tc-danger mb" role="alert">${this.error}</p><a class="btn" href="/admin/extension/kempo-commerce/">Back to orders</a>`;
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
    `;
  }
}

customElements.define('k-commerce-admin-order', AdminOrder);
