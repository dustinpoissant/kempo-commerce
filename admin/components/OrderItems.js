import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import Toast from '/kempo-ui/components/Toast.js';
import { getOrder, setFulfillment } from '/commerce/sdk.js';
import { loadFormat, optionsText, itemNames } from '/commerce/utils/format.js';

/*
  The Items tab of an order, served at /admin/extension/kempo-commerce/components/OrderItems.js: what was bought, the fees and tax,
  and whether each line has been sent. It reloads whenever the order changes, from anywhere on the page.
*/
export default class OrderItems extends ShadowComponent {
  static properties = {
    order: { state: true },
    money: { state: true },
    busy: { state: true },
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

  fulfil = async (line, done) => {
    this.busy = true;
    const [error] = await setFulfillment(this.order.id, line.id, done ? 'done' : 'pending');
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    this.dispatchEvent(new CustomEvent('orderChanged', { bubbles: true }));
  };

  render(){
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const paid = Boolean(order.paidAt);
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
                : html`<label class="checkbox m0"><input type="checkbox" .checked=${line.fulfillment === 'done'} ?disabled=${this.busy || !paid} @change=${event => this.fulfil(line, event.target.checked)}> Sent</label>`}</td>
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
    `;
  }
}

customElements.define('k-commerce-order-items', OrderItems);
