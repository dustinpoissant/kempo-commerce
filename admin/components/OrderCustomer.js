import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Dialog.js';
import Toast from '/kempo-ui/components/Toast.js';
import { getOrder, contactCustomer } from '/commerce/sdk.js';

/*
  The Customer tab of an order, served at /admin/extension/kempo-commerce/components/OrderCustomer.js: who it is for, and a dialog that
  emails them. The dialog stays open until the email is sent, so a failure does not lose what was typed. It reloads whenever the order
  changes, from anywhere on the page.
*/
export default class OrderCustomer extends ShadowComponent {
  static properties = {
    order: { state: true },
    emailSubject: { state: true },
    emailBody: { state: true },
    busy: { state: true },
  };

  constructor(){
    super();
    this.order = null;
    this.emailSubject = '';
    this.emailBody = '';
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
    const [error, data] = await getOrder(id);
    if(error){
      Toast.error(error.msg);
      return;
    }
    this.order = data.order;
  };

  openEmail = () => this.renderRoot.querySelector('#emailDialog').open();

  confirmEmail = event => {
    event.keepDialogOpen = true;
    this.sendEmail();
  };

  sendEmail = async () => {
    if(!this.emailSubject.trim() || !this.emailBody.trim()){
      Toast.error('Write a subject and a message');
      return;
    }
    this.busy = true;
    const [error, result] = await contactCustomer(this.order.id, this.emailSubject, this.emailBody);
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    this.renderRoot.querySelector('#emailDialog').close();
    Toast.success(`Email sent to ${result.to}`);
    this.emailSubject = '';
    this.emailBody = '';
    this.dispatchEvent(new CustomEvent('orderChanged', { bubbles: true }));
  };

  render(){
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    const billing = order.billing ?? {};
    return html`
      <h2 class="h5">Customer</h2>
      <p class="mb">
        <strong>${billing.name}</strong><br>
        ${order.email}${order.userId ? html` · <span class="tc-muted">has an account</span>` : html` · <span class="tc-muted">guest</span>`}
      </p>
      <h3 class="h6">Billing address</h3>
      <p class="mb">${[billing.line1, billing.line2, billing.city, billing.state, billing.postalCode, billing.country].filter(Boolean).join(', ') || html`<span class="tc-muted">None kept</span>`}</p>

      <h2 class="h5">Contact</h2>
      ${order.email ? html`
        <p class="mb">${order.email}</p>
        <p class="tc-muted mb">An email goes to this address, looks like the shop's other order emails, and is noted in the order's history.</p>
        <button class="mb" @click=${this.openEmail}>Email the customer</button>
        <k-dialog id="emailDialog" style="--width: 40rem;" confirm-text="Send email" confirm-classes="primary ml" cancel-text="Cancel" .confirmAction=${this.confirmEmail}>
          <h2 slot="title" class="h5 pyh px m0">Email ${order.email}</h2>
          <div class="p">
            <label class="mb">Subject<input type="text" maxlength="200" .value=${this.emailSubject} @input=${event => { this.emailSubject = event.target.value; }}></label>
            <label class="mb">Message<textarea rows="8" maxlength="5000" .value=${this.emailBody} @input=${event => { this.emailBody = event.target.value; }}></textarea></label>
          </div>
        </k-dialog>
      ` : html`<p class="tc-muted mb">This order has no email address.</p>`}
    `;
  }
}

customElements.define('k-commerce-order-customer', OrderCustomer);
