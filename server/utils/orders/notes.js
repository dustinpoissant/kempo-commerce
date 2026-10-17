import db from 'kempo/server/db/index.js';
import { eq } from 'drizzle-orm';
import { kempoCommerceNote, kempoCommerceOrder } from '../../db/schema.js';
import newId from '../ids.js';
import { EVENTS, notify } from '../hooks.js';
import { addEvent } from './events.js';
import { assemble } from './read.js';
import { escapeHtml, sendOrderEmail } from './emails.js';

const MAX_NOTE = 5000;

/*
  A note on an order, private or visible to the customer. A visible one is also emailed to them. The
  text is stored as written and escaped wherever it is shown or sent: it is staff-written content that
  a customer will read.
*/
export const addOrderNote = async (orderId, { body, visibleToCustomer = false, authorId = null } = {}) => {
  const text = typeof body === 'string' ? body.trim() : '';
  if(!text) return [{ code: 400, msg: 'A note needs some text' }, null];
  if(text.length > MAX_NOTE) return [{ code: 400, msg: `A note can be at most ${MAX_NOTE} characters` }, null];
  if(text.includes('\u0000')) return [{ code: 400, msg: 'A note cannot contain null characters' }, null];

  try {
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];

    const note = await db.transaction(async tx => {
      const [row] = await tx.insert(kempoCommerceNote).values({
        id: newId('note'), orderId, authorId, body: text, visibleToCustomer: visibleToCustomer === true, createdAt: new Date(),
      }).returning();
      await addEvent(tx, orderId, 'note', { actor: authorId || 'system', visible: row.visibleToCustomer, data: { noteId: row.id } });
      return row;
    });

    const full = await assemble(order);
    await notify(EVENTS.orderNoteAdded, { order: full, note });
    if(note.visibleToCustomer) await sendOrderEmail(full, 'order-note', 'A note about your order', { note: escapeHtml(note.body) });
    return [null, note];
  } catch(error) {
    return [{ code: 500, msg: 'Failed to add the note' }, null];
  }
};
