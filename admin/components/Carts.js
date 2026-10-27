import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html } from '/kempo-ui/lit-all.min.js';
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
  The carts with one status, read-only, served at /admin/extension/kempo-commerce/components/Carts.js.
  The page puts one of these in each status's tab (`status="open"` or `status="abandoned"`), so the
  tabs are the page's own. A row opens the cart's own page.
*/
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
    status: { type: String, reflect: true },
    error: { state: true },
  };

  constructor(){
    super();
    this.status = 'open';
    this.error = '';
    this.loaded = false;
  }

  /*
    Lifecycle
  */
  connectedCallback(){
    super.connectedCallback();
    const pane = this.closest('k-tab-content');
    // Loads when its tab is first shown, so a tab nobody opens makes no requests.
    if(!pane || pane.active) this.load();
    else this.closest('k-tabs')?.addEventListener('tabfirstshown', ({ detail }) => {
      if(detail.tab === pane.name) this.load();
    });
  }

  /*
    Data
  */
  load = async () => {
    if(this.loaded) return;
    this.loaded = true;
    const $table = this.renderRoot.querySelector('k-table');
    const [error, data] = await listCarts({ status: this.status, limit: 25, offset: 0 });
    if(error){
      this.error = error.msg;
      return;
    }
    $table.setData({
      records: data.items.map(cart => ({ ...cart, _url: `${CART}${encodeURIComponent(cart.id)}` })),
      fields,
    });
    $table.setupFetchRecords(data.total, async (start, count) => {
      const [fetchError, page] = await listCarts({ status: this.status, limit: count, offset: start });
      return fetchError ? [] : page.items.map(cart => ({ ...cart, _url: `${CART}${encodeURIComponent(cart.id)}` }));
    });
  };

  /*
    View
  */
  render(){
    return html`
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : ''}
      <k-table open-on-click enable-pages page-size="25" page-size-options="[10,25,50]" placeholder="No ${this.status} carts.">
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

customElements.define('k-commerce-admin-carts', AdminCarts);
