import { loadCredits } from '../optional.js';

/*
  The credits an order's products give. Whoever takes the order grants them once it is paid (kempo-products
  only says how many a product gives), under a key made from the order, so granting twice gives them once.
  A failure never undoes the sale: it is returned for the caller to log, and running it again is safe.
*/
export const grantOrderCredits = async (order, lines) => {
  const amount = lines.reduce((sum, line) => sum + (Number(line.creditsGranted) || 0) * (Number(line.quantity) || 0), 0);
  if(!amount || !order.userId) return [null, { granted: 0 }];

  const credits = await loadCredits();
  if(!credits) return [{ code: 501, msg: 'kempo-credits is not available' }, null];

  const [error, result] = await credits.grantCredits({
    userId: order.userId,
    amount,
    kind: 'purchase',
    reason: 'product-purchase',
    reference: { owner: 'kempo-commerce', ref: order.id },
    idempotencyKey: `commerce:order:${order.id}:credits`,
  });
  return error ? [error, null] : [null, { granted: amount, duplicate: Boolean(result?.duplicate) }];
};
