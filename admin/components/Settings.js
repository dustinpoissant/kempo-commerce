import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import { getSettings, saveSettings } from '/commerce/sdk.js';

/*
  The commerce settings, served at /admin/extension/kempo-commerce/components/Settings.js: grouped,
  each with what it does as a hint inside its label. The server checks every value and says what is
  wrong with one; the same values also appear on kempo's own settings screen.
*/

const SECTIONS = [
  { title: 'Your store', names: ['site_url', 'guest_checkout', 'allow_account_creation', 'refund_policy', 'restock_on_refund'] },
  { title: 'Carts', names: ['max_lines_per_cart', 'max_quantity_per_line', 'cart_expiry_days', 'cart_purge_days'] },
  { title: 'Orders', names: ['pending_expiry_minutes', 'order_number_prefix', 'order_number_padding', 'order_number_start'] },
  { title: 'The mini-cart', names: ['mini_cart_inject', 'mini_cart_side', 'mini_cart_open_on_add', 'add_to_cart_toast_action', 'mini_cart_hide_on_cart_pages'] },
  { title: 'Protection against card testing', names: ['purchase_limit_per_user', 'purchase_limit_per_ip', 'purchase_limit_global', 'failed_payment_limit', 'failed_payment_cooldown_minutes', 'trust_proxy'] },
];

const TITLES = {
  site_url: 'Site address', guest_checkout: 'Guest checkout', allow_account_creation: 'Offer to create an account', refund_policy: 'Refund policy',
  restock_on_refund: 'Restock refunded products', max_lines_per_cart: 'Most lines in a cart', max_quantity_per_line: 'Most of one product', cart_expiry_days: 'Days until a cart is abandoned',
  cart_purge_days: 'Days until an abandoned cart is deleted', pending_expiry_minutes: 'Minutes to pay', order_number_prefix: 'Order number prefix', order_number_padding: 'Order number digits',
  order_number_start: 'First order number', mini_cart_inject: 'Show the mini-cart on every page', mini_cart_side: 'Mini-cart side', mini_cart_open_on_add: 'Open on add', add_to_cart_toast_action: 'View cart button',
  mini_cart_hide_on_cart_pages: 'Hide on the cart page', purchase_limit_per_user: 'Checkouts per account per hour', purchase_limit_per_ip: 'Checkouts per address per hour',
  purchase_limit_global: 'Checkouts per hour, whole site', failed_payment_limit: 'Declines before a cool-down', failed_payment_cooldown_minutes: 'Cool-down minutes', trust_proxy: 'Trust the proxy address',
};

export default class AdminSettings extends ShadowComponent {
  static properties = {
    settings: { state: true },
    values: { state: true },
    error: { state: true },
    saved: { state: true },
    busy: { state: true },
  };

  constructor(){
    super();
    this.settings = null;
    this.values = {};
    this.error = '';
    this.saved = false;
    this.busy = false;
  }

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  load = async () => {
    const [error, data] = await getSettings();
    if(error){
      this.error = error.msg;
      return;
    }
    this.settings = Object.fromEntries(data.settings.map(setting => [setting.name, setting]));
    this.values = Object.fromEntries(data.settings.map(setting => [setting.name, setting.value]));
  };

  set = (name, event) => {
    this.values = { ...this.values, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value };
    this.saved = false;
  };

  save = async event => {
    event.preventDefault();
    this.busy = true;
    this.error = '';
    const [error] = await saveSettings(this.values);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.saved = true;
    await this.load();
  };

  renderField(name){
    const setting = this.settings[name];
    if(!setting) return nothing;
    const value = this.values[name];
    const hint = html`<small class="tc-muted d-b">${setting.description}</small>`;

    if(setting.type === 'boolean') return html`<label class="checkbox mb"><input type="checkbox" .checked=${value === true || value === 'true'} @change=${event => this.set(name, event)}> ${TITLES[name]}${hint}</label>`;
    if(name === 'mini_cart_side') return html`<label class="mb">${TITLES[name]}${hint}<select @change=${event => this.set(name, event)}><option value="left" ?selected=${value === 'left'}>Left</option><option value="right" ?selected=${value === 'right'}>Right</option></select></label>`;
    if(name === 'add_to_cart_toast_action') return html`<label class="mb">${TITLES[name]}${hint}<select @change=${event => this.set(name, event)}><option value="mini-cart" ?selected=${value === 'mini-cart'}>Opens the mini-cart</option><option value="cart-page" ?selected=${value === 'cart-page'}>Goes to the cart page</option><option value="none" ?selected=${value === 'none'}>No button</option></select></label>`;
    if(name === 'refund_policy') return html`<label class="mb">${TITLES[name]}${hint}<textarea rows="4" .value=${value ?? ''} @input=${event => this.set(name, event)}></textarea></label>`;
    return html`<label class="mb">${TITLES[name]}${hint}<input type=${setting.type === 'number' ? 'number' : 'text'} .value=${String(value ?? '')} @input=${event => this.set(name, event)}></label>`;
  }

  render(){
    if(this.error && !this.settings) return html`<p class="tc-danger" role="alert">${this.error}</p>`;
    if(!this.settings) return html`<k-spinner></k-spinner>`;

    return html`
      <form @submit=${this.save}>
        ${SECTIONS.map(section => html`<div class="card mb"><h2 class="h4">${section.title}</h2>${section.names.map(name => this.renderField(name))}</div>`)}
        <div aria-live="polite">
          ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
          ${this.saved ? html`<p class="tc-success">Saved.</p>` : nothing}
        </div>
        <button class="primary" ?disabled=${this.busy}>${this.busy ? 'Saving…' : 'Save settings'}</button>
      </form>
    `;
  }
}

customElements.define('k-commerce-admin-settings', AdminSettings);
