import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import { listCarts } from '/commerce/sdk.js';
import { formatDate } from '/commerce/utils/format.js';

/*
  Open and abandoned carts, read-only, served at /admin/extension/kempo-commerce/components/Carts.js.
  Abandoned carts are what a later "abandoned cart" extension would email about.
*/
export default class AdminCarts extends ShadowComponent {
  static properties = {
    status: { state: true },
    items: { state: true },
    total: { state: true },
    loading: { state: true },
    error: { state: true },
  };

  constructor(){
    super();
    this.status = 'open';
    this.items = [];
    this.total = 0;
    this.loading = true;
    this.error = '';
  }

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  load = async () => {
    this.loading = true;
    const [error, data] = await listCarts({ status: this.status, limit: 50 });
    this.loading = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.items = data.items;
    this.total = data.total;
  };

  show = status => {
    this.status = status;
    this.load();
  };

  render(){
    return html`
      <div class="btn-grp mb">
        <button class=${this.status === 'open' ? 'primary' : ''} @click=${() => this.show('open')}>Open</button>
        <button class=${this.status === 'abandoned' ? 'primary' : ''} @click=${() => this.show('abandoned')}>Abandoned</button>
      </div>
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
      ${this.loading ? html`<k-spinner></k-spinner>` : nothing}
      ${!this.loading && !this.items.length ? html`<p class="tc-muted">No ${this.status} carts.</p>` : nothing}
      ${this.items.length ? html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Who</th><th>Items</th><th>Last touched</th></tr></thead>
            <tbody>${this.items.map(cart => html`<tr>
              <td>${cart.userId ? html`<code>${cart.userId}</code>` : html`<span class="tc-muted">Visitor</span>`}</td>
              <td>${cart.lines.reduce((sum, line) => sum + line.quantity, 0)} item${cart.lines.reduce((sum, line) => sum + line.quantity, 0) === 1 ? '' : 's'} in ${cart.lines.length} line${cart.lines.length === 1 ? '' : 's'}</td>
              <td>${formatDate(cart.updatedAt)}</td>
            </tr>`)}</tbody>
          </table>
        </div>
        <p class="tc-muted small mt">${this.total} ${this.status} cart${this.total === 1 ? '' : 's'}.</p>
      ` : nothing}
    `;
  }
}

customElements.define('k-commerce-admin-carts', AdminCarts);
