import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import { getMyOrders } from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_COLORS } from '/commerce/utils/format.js';

/*
  The signed-in customer's order history, served at /commerce/components/Orders.js.

  ```html
  <script type="module" src="/commerce/components/Orders.js"></script>
  <k-commerce-orders></k-commerce-orders>
  ```

  Number, date, status and total for each order, newest first, with a link to the order's own page.
  Guest orders placed with this account's email appear once the email is verified.
*/
export default class Orders extends ShadowComponent {
  static properties = {
    items: { state: true },
    total: { state: true },
    error: { state: true },
    signedOut: { state: true },
    loading: { state: true },
  };

  constructor(){
    super();
    this.items = [];
    this.total = 0;
    this.error = '';
    this.signedOut = false;
    this.loading = true;
    this.money = minor => String(minor);
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    this.money = (await loadFormat()).money;
    await this.more();
  };

  more = async () => {
    this.loading = true;
    const [error, data] = await getMyOrders({ limit: 20, offset: this.items.length });
    this.loading = false;
    if(error){
      this.signedOut = error.code === 401;
      this.error = this.signedOut ? '' : error.msg;
      return;
    }
    this.items = [...this.items, ...data.items];
    this.total = data.total;
  };

  render(){
    if(this.signedOut) return html`<p>Please <a href=${`/login?redirect=${encodeURIComponent(location.pathname)}`}>sign in</a> to see your orders.</p>`;
    if(this.error) return html`<p class="tc-danger" role="alert">${this.error}</p>`;
    if(this.loading && !this.items.length) return html`<k-spinner></k-spinner>`;
    if(!this.items.length) return html`<p class="tc-muted">You have not placed an order yet. <a href="/products/">Browse the shop</a>.</p>`;

    return html`
      <div class="table-wrapper mb">
        <table>
          <thead><tr><th>Order</th><th>Date</th><th>Status</th><th class="ta-right">Total</th></tr></thead>
          <tbody>
            ${this.items.map(order => html`<tr>
              <td><a href=${`/account/orders/${encodeURIComponent(order.id)}/`}>${order.numberLabel}</a></td>
              <td>${formatDate(order.placedAt)}</td>
              <td class=${STATUS_COLORS[order.status] ?? ''}>${statusLabel(order.status)}</td>
              <td class="ta-right">${this.money(order.total)}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      ${this.items.length < this.total ? html`<button ?disabled=${this.loading} @click=${this.more}>Show more</button>` : nothing}
    `;
  }
}

customElements.define('k-commerce-orders', Orders);
