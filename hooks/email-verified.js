import { linkGuestOrders } from '../server/utils/orders/link.js';

/* Someone proved they own an address: guest orders placed with it become theirs. */
export default async ({ userId, email }) => {
  await linkGuestOrders({ userId, email });
};
