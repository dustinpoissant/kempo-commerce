import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Spinner.js';
import Toast from '/kempo-ui/components/Toast.js';
import { getOrder, addNote } from '/commerce/sdk.js';
import { formatDate, eventText } from '/commerce/utils/format.js';

/*
  The History tab of an order, served at /admin/extension/kempo-commerce/components/OrderHistory.js: everything that happened to the
  order, and its notes, with a form to add one. It reloads whenever the order changes, from anywhere on the page.
*/
export default class OrderHistory extends ShadowComponent {
  static properties = {
    order: { state: true },
    events: { state: true },
    note: { state: true },
    noteVisible: { state: true },
    busy: { state: true },
  };

  constructor(){
    super();
    this.order = null;
    this.events = [];
    this.note = '';
    this.noteVisible = false;
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
    this.events = data.events;
  };

  saveNote = async event => {
    event.preventDefault();
    this.busy = true;
    const [error] = await addNote(this.order.id, this.note, this.noteVisible);
    this.busy = false;
    if(error){
      Toast.error(error.msg);
      return;
    }
    Toast.success(this.noteVisible ? 'Note added, and emailed to the customer' : 'Note added');
    this.note = '';
    this.dispatchEvent(new CustomEvent('orderChanged', { bubbles: true }));
  };

  render(){
    if(!this.order) return html`<k-spinner></k-spinner>`;
    const { order } = this;
    return html`
      <h2 class="h5">History</h2>
      <ul class="mb">${this.events.map(event => html`<li class="mb"><span class="tc-muted small">${formatDate(event.createdAt)}${event.actorName ? ` · ${event.actorName}` : ''}</span><br>${eventText(event)}${event.visible ? '' : html` <span class="tc-muted small">(private)</span>`}</li>`)}</ul>
      ${order.placedAt ? html`<p class="small tc-muted mb">Placed ${formatDate(order.placedAt)}${order.paidAt ? `, paid ${formatDate(order.paidAt)}` : ''}</p>` : nothing}

      <h2 class="h5">Notes</h2>
      ${(order.notes ?? []).map(entry => html`<blockquote class="mb">${entry.body}<div class="small tc-muted">${formatDate(entry.createdAt)} · ${entry.visibleToCustomer ? 'the customer sees this' : 'private'}</div></blockquote>`)}
      <form @submit=${this.saveNote} class="mb">
        <label class="mb">Add a note<textarea rows="3" .value=${this.note} required @input=${event => { this.note = event.target.value; }}></textarea></label>
        <label class="checkbox mb"><input type="checkbox" .checked=${this.noteVisible} @change=${event => { this.noteVisible = event.target.checked; }}> Show to the customer, and email it to them</label>
        <button ?disabled=${this.busy || !this.note.trim()}>Add note</button>
      </form>
    `;
  }
}

customElements.define('k-commerce-order-history', OrderHistory);
