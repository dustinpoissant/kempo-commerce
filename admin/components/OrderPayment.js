import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import Toast from '/kempo-ui/components/Toast.js';
import { getOrder, finishRefund } from '/commerce/sdk.js';
import { loadFormat, formatDate } from '/commerce/utils/format.js';

/*
  The Payment tab of an order, served at /admin/extension/kempo-commerce/components/OrderPayment.js: how it was paid, the refunds
  and what is left to finish. It reloads whenever the order changes, from anywhere on the page.
*/
export default class OrderPayment extends ShadowComponent {
  static properties = {
    order: { state: true },
    money: { state: true },
    busy: { state: true },
  };

  constructor(){
    super();
    this.order = null;
    this.money = minor => String(minor);
    this.busy = false;
  }

  connectedCallback(){
    super.connectedCallback();
    const pane = this.closest('k-tab-content');
    const start = () => {
      this.loaded = true;
      this.load();
    };
    this.closest('#order')?.addEventListener('orderChanged', () => this.loaded && this.load());
    // Loads when its tab is first opened, so a tab nobody opens makes no requests.
    if(!pane || pane.active) start();
    else this.closest('k-tabs')?.addEventListener('tabfirstshown', ({ detail }) => {
      if(detail.tab === pane.name) start();
    });
  }

  load = async () => {
    const id = new URLSearchParams(location.search).get('id') ?? '';
    const [[error, data], format] = await Promise.all([getOrder(id), loadFormat()]);
    this.money = format.money;
    if(error){
      Toast.error(error.msg);
      return;
    }
    this.order = data.order;
  };

  finish = async refund => {
    this.busy = true;
    const [error] = await finishRefund(refund.id);
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    Toast.success('Refund finished');
    this.dispatchEvent(new CustomEvent('orderChanged', { bubbles: true }));
  };

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
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const paid = Boolean(order.paidAt);
    const canRefund = paid && !['pending_payment', 'failed', 'cancelled', 'refunded'].includes(order.status) && order.refundedTotal < order.paidTotal;
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
}

customElements.define('k-commerce-order-payment', OrderPayment);
