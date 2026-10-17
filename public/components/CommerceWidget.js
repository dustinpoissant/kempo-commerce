import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary } from '/commerce/sdk.js';
import { loadFormat } from '/commerce/utils/format.js';

/*
  The dashboard's view of the shop: orders and revenue today and this week, and what is waiting for a
  person (orders to process, orders on hold).
*/
export default class CommerceWidget extends DashboardWidget {
  static properties = {
    ...DashboardWidget.properties,
    summary: { state: true },
  };

  constructor(){
    super();
    this.summary = null;
    this.money = minor => String(minor);
    this.cta = { label: 'View orders', iconSrc: '/admin/extension/kempo-commerce/icons/receipt.svg', href: '/admin/extension/kempo-commerce/' };
  }

  load = async () => {
    this.money = (await loadFormat()).money;
    this.summary = await this.unwrap(getSummary());
  };

  renderContent(){
    const { today, week, processing, onHold, pending } = this.summary;
    return html`
      <div class="d-f mb">
        <div class="flex"><div class="h2 m0">${today.orders}</div><div class="tc-muted">Orders today · ${this.money(today.revenue)}</div></div>
        <div class="flex"><div class="h2 m0">${week.orders}</div><div class="tc-muted">This week · ${this.money(week.revenue)}</div></div>
      </div>
      ${processing ? html`<p class="mbq"><strong>${processing}</strong> order${processing === 1 ? '' : 's'} to process</p>` : nothing}
      ${onHold ? html`<p class="mbq tc-warning"><strong>${onHold}</strong> on hold</p>` : nothing}
      ${pending ? html`<p class="mbq tc-muted">${pending} waiting for payment</p>` : nothing}
    `;
  }
}

customElements.define('k-commerce-widget', CommerceWidget);
