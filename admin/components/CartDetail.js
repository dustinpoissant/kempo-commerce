import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import { getAdminCart } from '/commerce/sdk.js';
import { loadFormat, formatDate } from '/commerce/utils/format.js';

/*
  One cart, read-only, served at /admin/extension/kempo-commerce/components/CartDetail.js. The cart's id is the last
  part of the address (/admin/extension/kempo-commerce/cart/<id>). Each line is shown at the price it was last priced
  at: nothing is priced again here, so this is what the cart held, not what it would cost today.
*/
const CARTS = '/admin/extension/kempo-commerce/carts/';

export default class AdminCartDetail extends ShadowComponent {
  static properties = {
    data: { state: true },
    error: { state: true },
    loading: { state: true },
  };

  constructor(){
    super();
    this.data = null;
    this.error = '';
    this.loading = true;
    this.money = minor => String(minor);
    this.cartId = decodeURIComponent(location.pathname.split('/admin/extension/kempo-commerce/cart/')[1]?.replace(/\/$/, '') ?? '');
  }

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    this.money = (await loadFormat()).money;
    if(!this.cartId){
      this.loading = false;
      this.error = 'No cart was asked for.';
      return;
    }
    const [error, data] = await getAdminCart(this.cartId);
    this.loading = false;
    if(error){
      this.error = error.msg || 'The cart could not be loaded.';
      return;
    }
    this.data = data;
  };

  updated(changed){
    if(!changed.has('data') || !this.data) return;
    const { money } = this;
    this.renderRoot.querySelector('k-table')?.setData({
      records: this.data.lines,
      fields: [
        { name: 'productId', label: 'Product', editable: false },
        { name: 'quantity', label: 'Quantity', size: 110, editable: false },
        { name: 'unitPrice', label: 'Cart price', size: 140, editable: false, calculator: line => line.unitPrice === null ? '—' : money(line.unitPrice) },
        { name: 'currentUnitPrice', label: 'Current price', size: 140, editable: false, calculator: line => line.currentUnitPrice === null ? '—' : money(line.currentUnitPrice) },
        { name: 'total', label: 'Current total', size: 140, editable: false, calculator: line => line.currentUnitPrice === null ? '—' : money(line.currentUnitPrice * line.quantity) },
      ],
    });
  }

  render(){
    const header = html`
      <div class="d-f mb" style="align-items: center; gap: var(--spacer);">
        <a href=${CARTS} class="btn"><k-icon name="arrow" direction="left"></k-icon> Carts</a>
        <h1 class="flex mb0">Cart</h1>
      </div>
    `;
    if(this.loading) return html`${header}<k-spinner></k-spinner>`;
    if(this.error) return html`${header}<p class="tc-danger" role="alert">${this.error}</p>`;
    const { cart, lines } = this.data;
    const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    const cartTotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
    const currentTotal = lines.reduce((sum, line) => sum + (line.currentUnitPrice ?? line.unitPrice) * line.quantity, 0);
    return html`
      ${header}
      <div class="card mb">
        <h2 class="h4 mb">Information</h2>
        <p class="mb"><strong>Status</strong> ${cart.status[0].toUpperCase()}${cart.status.slice(1)}</p>
        <p class="mb"><strong>Who</strong> ${cart.userId
          ? html`<a href=${`/admin/accounts/users/${encodeURIComponent(cart.userId)}`}>${cart.userId}</a>`
          : html`<span class="tc-muted">A visitor who is not signed in</span>`}</p>
        <p class="mb"><strong>Currency</strong> ${cart.currency.toUpperCase()}</p>
        <p class="mb"><strong>Started</strong> ${formatDate(cart.createdAt)}</p>
        <p class="mb"><strong>Last touched</strong> ${formatDate(cart.updatedAt)}</p>
        <p class="mb"><strong>Expires</strong> ${cart.expiresAt ? formatDate(cart.expiresAt) : html`<span class="tc-muted">Never</span>`}</p>
      </div>
      <div class="card mb">
        <h2 class="h4 mb">Lines</h2>
        <k-table placeholder="This cart is empty."></k-table>
        ${lines.length ? html`<p class="tc-muted small mt">${quantity} item${quantity === 1 ? '' : 's'} in ${lines.length} line${lines.length === 1 ? '' : 's'}. Cart total <strong>${this.money(cartTotal)}</strong>, current total <strong>${this.money(currentTotal)}</strong>.</p>` : nothing}
      </div>
    `;
  }
}

customElements.define('k-commerce-admin-cart', AdminCartDetail);
