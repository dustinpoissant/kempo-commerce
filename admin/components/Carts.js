import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Tabs.js';
import '/kempo-ui/components/Table.js';
import '/kempo-ui/components/controls/TcOpen.js';
import '/kempo-ui/components/controls/TcFirstPage.js';
import '/kempo-ui/components/controls/TcPrevPage.js';
import '/kempo-ui/components/controls/TcNextPage.js';
import '/kempo-ui/components/controls/TcLastPage.js';
import '/kempo-ui/components/controls/TcPageSelect.js';
import '/kempo-ui/components/controls/TcPageSize.js';
import { listCarts } from '/commerce/sdk.js';
import { formatDate } from '/commerce/utils/format.js';

/*
  Open and abandoned carts, read-only, served at /admin/extension/kempo-commerce/components/Carts.js.
  Each status is a tab, and the tab is in the address, so a reload or the back button keeps it. A row opens the
  cart's own page. Abandoned carts are what a later "abandoned cart" extension would email about.
*/
const STATUSES = ['open', 'abandoned'];
const CART = '/admin/extension/kempo-commerce/cart/';

const fields = [
  { name: 'userId', label: 'Who', editable: false, calculator: cart => cart.userId ? cart.userId : 'Visitor' },
  { name: 'items', label: 'Items', size: 200, editable: false, calculator: cart => {
    const quantity = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
    return `${quantity} item${quantity === 1 ? '' : 's'} in ${cart.lines.length} line${cart.lines.length === 1 ? '' : 's'}`;
  } },
  { name: 'updatedAt', label: 'Last touched', size: 190, editable: false, formatter: formatDate },
];

export default class AdminCarts extends ShadowComponent {
  static properties = {
    error: { state: true },
  };

  constructor(){
    super();
    this.error = '';
    this.loaded = new Set();
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  /* Loads the tab the address opened on, and each tab the first time it is shown. */
  start = async () => {
    await this.updateComplete;
    const $tabs = this.renderRoot.querySelector('k-tabs');
    $tabs.addEventListener('tabfirstshown', ({ detail }) => this.load(detail.tab));
    await $tabs.updateComplete;
    this.load($tabs.active);
  };

  load = async status => {
    if(this.loaded.has(status)) return;
    this.loaded.add(status);
    const $table = this.renderRoot.querySelector(`#${status}Table`);
    const [error, data] = await listCarts({ status, limit: 25, offset: 0 });
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    $table.setData({
      records: data.items.map(cart => ({ ...cart, _url: `${CART}${encodeURIComponent(cart.id)}` })),
      fields,
    });
    $table.setupFetchRecords(data.total, async (start, count) => {
      const [fetchError, page] = await listCarts({ status, limit: count, offset: start });
      return fetchError ? [] : page.items.map(cart => ({ ...cart, _url: `${CART}${encodeURIComponent(cart.id)}` }));
    });
  };

  renderTable(status){
    return html`
      <k-table id="${status}Table" open-on-click enable-pages page-size="25" page-size-options="[10,25,50]" placeholder="No ${status} carts.">
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

  render(){
    return html`
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : ''}
      <k-tabs id="cartTabs" hash-routing active="open">
        <k-tab for="open">Open</k-tab>
        <k-tab for="abandoned">Abandoned</k-tab>
        ${STATUSES.map(status => html`<k-tab-content name="${status}">${this.renderTable(status)}</k-tab-content>`)}
      </k-tabs>
    `;
  }
}

customElements.define('k-commerce-admin-carts', AdminCarts);
