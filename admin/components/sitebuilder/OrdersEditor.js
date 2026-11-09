import Orders from '/commerce/components/Orders.js';
import { loadFormat } from '/commerce/utils/format.js';

/*
  The order history as the page builder shows it: the same table, drawn by the same component, with two sample orders in
  place of the signed-in customer's own (the builder is not that customer, and may have none). Nothing is asked of the server.
*/
export default class OrdersEditor extends Orders {
  start = async () => {
    this.money = (await loadFormat()).money;
    const day = 86400000;
    this.items = [
      { id: 'sample-2', numberLabel: '#1002', placedAt: new Date(Date.now() - day).toISOString(), status: 'processing', total: 5000 },
      { id: 'sample-1', numberLabel: '#1001', placedAt: new Date(Date.now() - 9 * day).toISOString(), status: 'completed', total: 7500 },
    ];
    this.total = this.items.length;
    this.loading = false;
  };

  more = async () => {};
}

customElements.define('k-commerce-orders-editor', OrdersEditor);
