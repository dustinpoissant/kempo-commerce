import db from 'kempo/server/db/index.js';
import { and, eq } from 'drizzle-orm';
import { kempoCommerceTender } from '../../../../../../server/db/schema.js';
import { body, customerOrder, refuse } from '../../../../../../server/http/gate.js';
import { forCustomer, getOrder } from '../../../../../../server/utils/orders/read.js';

/*
  The browser says it finished paying. It is not believed: this asks the processor, which fires
  `payment:succeeded` if it really was paid, and then reports where the order stands. The order's
  owner, or a guest holding its key, may ask.
*/
export default async (request, response) => {
  const [accessError, access] = await customerOrder(request, request.params.id, body(request).key ?? request.query.key);
  if(accessError) return refuse(response, accessError);

  if(access.order.status === 'pending_payment'){
    const [card] = await db.select().from(kempoCommerceTender).where(and(eq(kempoCommerceTender.orderId, access.order.id), eq(kempoCommerceTender.kind, 'card')));
    if(card?.reference){
      try {
        const payments = await import('kempo-payments/sdk');
        await payments.syncPayment(card.reference);
      } catch(error) {
        console.error('[kempo-commerce] Could not ask the processor about a payment:', error);
      }
    }
  }

  const [error, order] = await getOrder(access.order.id, { notes: true });
  if(error) return refuse(response, error);
  response.json({ order: forCustomer(order) });
};
