import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { listOrders } from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_COLORS, STATUS_LABELS } from '/commerce/utils/format.js';

/*
  The orders list, served at /admin/extension/kempo-commerce/components/Orders.js.

  Search by number, name or email, filter by status and date, newest first. Opening an order goes to its
  own page, so the back button returns here with the search kept in the address.
*/
export default class AdminOrders extends ShadowComponent {
  static properties = {
    items: { state: true },
    total: { state: true },
    loading: { state: true },
    error: { state: true },
    search: { state: true },
    status: { state: true },
    from: { state: true },
    to: { state: true },
    page: { state: true },
  };

  constructor(){
    super();
    this.items = [];
    this.total = 0;
    this.loading = true;
    this.error = '';
    const params = new URLSearchParams(location.search);
    this.search = params.get('search') ?? '';
    this.status = params.get('status') ?? '';
    this.from = params.get('from') ?? '';
    this.to = params.get('to') ?? '';
    this.page = Number(params.get('page')) || 1;
    this.money = minor => String(minor);
    this.timer = null;
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    this.money = (await loadFormat()).money;
    await this.load();
  };

  load = async () => {
    this.loading = true;
    const [error, data] = await listOrders({ search: this.search, status: this.status, from: this.from, to: this.to, limit: 25, offset: (this.page - 1) * 25 });
    this.loading = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.items = data.items;
    this.total = data.total;
    const params = new URLSearchParams();
    for(const [name, value] of Object.entries({ search: this.search, status: this.status, from: this.from, to: this.to, page: this.page > 1 ? this.page : '' })){
      if(value) params.set(name, value);
    }
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  };

  change = (name, event) => {
    this[name] = event.target.value;
    this.page = 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(this.load, name === 'search' ? 300 : 0);
  };

  go = page => {
    this.page = page;
    this.load();
  };

  render(){
    const pages = Math.max(1, Math.ceil(this.total / 25));
    return html`
      <div class="row">
        <label class="span-12 d-span-4 pr mb">Search<small class="tc-muted d-b">Order number, name or email</small>
          <input type="search" .value=${this.search} @input=${event => this.change('search', event)}></label>
        <label class="span-12 d-span-3 pr mb">Status<small class="tc-muted d-b">&nbsp;</small>
          <select .value=${this.status} @change=${event => this.change('status', event)}>
            <option value="">Any</option>
            ${Object.entries(STATUS_LABELS).map(([value, label]) => html`<option value=${value} ?selected=${this.status === value}>${label}</option>`)}
          </select></label>
        <label class="span-6 d-span-2 pr mb">From<small class="tc-muted d-b">&nbsp;</small><input type="date" .value=${this.from} @change=${event => this.change('from', event)}></label>
        <label class="span-6 d-span-2 mb">To<small class="tc-muted d-b">&nbsp;</small><input type="date" .value=${this.to} @change=${event => this.change('to', event)}></label>
      </div>

      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
      ${this.loading && !this.items.length ? html`<k-spinner></k-spinner>` : nothing}
      ${!this.loading && !this.items.length && !this.error ? html`<p class="tc-muted">No orders match.</p>` : nothing}

      ${this.items.length ? html`
        <div class="table-wrapper mb">
          <table>
            <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Status</th><th class="ta-right">Total</th></tr></thead>
            <tbody>
              ${this.items.map(order => html`<tr>
                <td><a href=${`/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(order.id)}`}><strong>${order.numberLabel}</strong></a></td>
                <td>${formatDate(order.placedAt)}</td>
                <td>${order.billing?.name ?? ''}<div class="tc-muted small">${order.email}${order.userId ? '' : ' · guest'}</div></td>
                <td class=${STATUS_COLORS[order.status] ?? ''}>${statusLabel(order.status)}</td>
                <td class="ta-right">${this.money(order.total)}${order.refundedTotal ? html`<div class="tc-muted small">−${this.money(order.refundedTotal)} refunded</div>` : nothing}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <div class="d-f" style="align-items: center; gap: var(--spacer);">
          <button ?disabled=${this.page <= 1} @click=${() => this.go(this.page - 1)}>Previous</button>
          <span class="tc-muted">Page ${this.page} of ${pages} · ${this.total} order${this.total === 1 ? '' : 's'}</span>
          <button ?disabled=${this.page >= pages} @click=${() => this.go(this.page + 1)}>Next</button>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('k-commerce-admin-orders', AdminOrders);
