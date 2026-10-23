import db from 'kempo/server/db/index.js';
import { eq } from 'drizzle-orm';
import { kempoCommerceOrder } from '../../db/schema.js';
import { addEvent } from './events.js';
import { assemble } from './read.js';
import { escapeHtml, sendOrderEmail } from './emails.js';

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

/*
  An email from the shop to the order's customer, written by staff: a subject and a message. It goes through the same order
  email template as a note the customer can see, so it looks like the shop's other emails, and it is recorded in the order's
  history (who sent it, and the subject) so nobody emails twice by mistake. The message is escaped: it is staff-written text
  that goes into an HTML email.
*/
export const contactCustomer = async (orderId, { subject, body, authorId = null } = {}) => {
  const title = typeof subject === 'string' ? subject.trim() : '';
  const text = typeof body === 'string' ? body.trim() : '';
  if(!title) return [{ code: 400, msg: 'An email needs a subject' }, null];
  if(!text) return [{ code: 400, msg: 'An email needs a message' }, null];
  if(title.length > MAX_SUBJECT) return [{ code: 400, msg: `A subject can be at most ${MAX_SUBJECT} characters` }, null];
  if(text.length > MAX_BODY) return [{ code: 400, msg: `A message can be at most ${MAX_BODY} characters` }, null];
  if(`${title}${text}`.includes('\u0000') || /[\r\n]/.test(title)) return [{ code: 400, msg: 'The subject must be one line, and nothing can contain null characters' }, null];

  try {
    const [order] = await db.select().from(kempoCommerceOrder).where(eq(kempoCommerceOrder.id, orderId));
    if(!order) return [{ code: 404, msg: 'Order not found' }, null];
    if(!order.email) return [{ code: 409, msg: 'This order has no email address' }, null];

    const [error] = await sendOrderEmail(await assemble(order), 'order-note', title, { note: escapeHtml(text) });
    if(error) return [{ code: error.code === 400 ? 502 : (error.code || 502), msg: `The email could not be sent: ${error.msg}` }, null];

    await addEvent(db, orderId, 'message', { actor: authorId || 'system', visible: false, data: { subject: title, to: order.email } });
    return [null, { sent: true, to: order.email }];
  } catch {
    return [{ code: 500, msg: 'Failed to send the email' }, null];
  }
};
