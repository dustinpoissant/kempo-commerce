import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import '/kempo-ui/components/controls/TcOpen.js';
import '/kempo-ui/components/controls/TcFirstPage.js';
import '/kempo-ui/components/controls/TcPrevPage.js';
import '/kempo-ui/components/controls/TcNextPage.js';
import '/kempo-ui/components/controls/TcLastPage.js';
import '/kempo-ui/components/controls/TcPageSelect.js';
import '/kempo-ui/components/controls/TcPageSize.js';
import { listOrders } from '/commerce/sdk.js';
import { loadFormat, formatDate, statusLabel, STATUS_LABELS } from '/commerce/utils/format.js';

/*
  The orders list, served at /admin/extension/kempo-commerce/components/Orders.js.

  Search by number, name or email, filter by status and date, newest first. Opening an order goes to its
  own page, so the back button returns here with the search kept in the address. The table pages the
  orders itself and fetches each page when it is shown.
*/
export default class AdminOrders extends ShadowComponent {
  static properties = {
    total: { state: true },
    loading: { state: true },
    error: { state: true },
    search: { state: true },
    status: { state: true },
    from: { state: true },
    to: { state: true },
  };

  constructor(){
    super();
    this.total = 0;
    this.loading = true;
    this.error = '';
    const params = new URLSearchParams(location.search);
    this.search = params.get('search') ?? '';
    this.status = params.get('status') ?? '';
    this.from = params.get('from') ?? '';
    this.to = params.get('to') ?? '';
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

  /* The filters as the API takes them. */
  filters = () => ({ search: this.search, status: this.status, from: this.from, to: this.to });

  load = async () => {
    await this.updateComplete;
    const $table = this.renderRoot.querySelector('k-table');
    this.loading = true;
    const [error, data] = await listOrders({ ...this.filters(), limit: 25, offset: 0 });
    this.loading = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.total = data.total;
    $table.setData({
      records: data.items.map(order => ({ ...order, _url: `/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(order.id)}` })),
      fields: [
        { name: 'numberLabel', label: 'Order', size: 140, editable: false },
        { name: 'placedAt', label: 'Date', size: 160, editable: false, formatter: formatDate },
        { name: 'customer', label: 'Customer', editable: false, calculator: order => `${order.billing?.name ?? ''}${order.billing?.name ? ' · ' : ''}${order.email}${order.userId ? '' : ' · guest'}` },
        { name: 'status', label: 'Status', size: 140, editable: false, calculator: order => statusLabel(order.status) },
        { name: 'total', label: 'Total', size: 180, editable: false, calculator: order => `${this.money(order.total)}${order.refundedTotal ? ` · −${this.money(order.refundedTotal)} refunded` : ''}` },
      ],
    });
    $table.setupFetchRecords(data.total, async (start, count) => {
      const [fetchError, page] = await listOrders({ ...this.filters(), limit: count, offset: start });
      if(fetchError) return [];
      return page.items.map(order => ({ ...order, _url: `/admin/extension/kempo-commerce/order/?id=${encodeURIComponent(order.id)}` }));
    });
    const params = new URLSearchParams();
    for(const [name, value] of Object.entries(this.filters())){
      if(value) params.set(name, value);
    }
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  };

  change = (name, event) => {
    this[name] = event.target.value;
    clearTimeout(this.timer);
    this.timer = setTimeout(this.load, name === 'search' ? 300 : 0);
  };

  render(){
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
      ${this.loading ? html`<k-spinner></k-spinner>` : nothing}

      <k-table open-on-click enable-pages page-size="25" page-size-options="[10,25,50]" placeholder="No orders match.">
        <kc-tc-open slot="before"></kc-tc-open>
        <div class="d-f full" style="align-items: center;">
          <div>
            <kc-tc-first-page></kc-tc-first-page>
            <kc-tc-prev-page></kc-tc-prev-page>
            <kc-tc-next-page></kc-tc-next-page>
            <kc-tc-last-page></kc-tc-last-page>
          </div>
          <div class="flex"></div>
          <div><kc-tc-page-select></kc-tc-page-select></div>
          <div class="flex"></div>
          <div><kc-tc-page-size></kc-tc-page-size></div>
        </div>
      </k-table>
    `;
  }
}

customElements.define('k-commerce-admin-orders', AdminOrders);
