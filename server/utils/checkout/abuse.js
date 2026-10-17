import db from 'kempo/server/db/index.js';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { kempoCommerceAttempt } from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import { notifyAdmins } from '../orders/emails.js';

/*
  Card-testing protection. Selling cheap things to strangers invites people to try stolen card numbers
  on them, and guest checkout (the default) removes "signed-in buyers only" as a defence, so these
  limits are the whole of it:

  - **Rate limits** per account, per address and site-wide over the last hour. 0 turns one off.
  - **A decline cool-down.** After N declines from one account or address within the cool-down
    window, further attempts are refused until it passes, and the payment that hit the limit is
    cancelled at the processor so no more cards can be tried against it from the browser. One decline
    and a retry is a customer and works.
  - **A log of every refused attempt**, and a notification to the shop as the hour's count reaches
    1, 10, 100...

  `ip` is whatever the route determined; behind a proxy that is the `trust_proxy` setting's business.
*/

const HOUR = 3600000;
const since = ms => new Date(Date.now() - ms);

const countWhere = async (...conditions) => {
  const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCommerceAttempt).where(and(...conditions));
  return total;
};

const log = (kind, { userId = null, ip = null, email = null, reason = null } = {}) => db.insert(kempoCommerceAttempt).values({
  kind, userId, ip, email, reason, createdAt: new Date(),
});

/* Powers of ten: 1, 10, 100, ... so a flood is one notification per order of magnitude, not thousands. */
const isMilestone = count => count > 0 && /^10*$/.test(String(count));

/*
  Called before a checkout does anything. Returns `[null, null]` to proceed, or a 429 error with
  `retryAfter` seconds. A permitted attempt is recorded, so it counts towards the limits.
*/
export const checkLimits = async ({ userId = null, ip = null, email = null } = {}) => {
  try {
    const config = await readConfig();
    const hour = gte(kempoCommerceAttempt.createdAt, since(HOUR));
    const attempts = eq(kempoCommerceAttempt.kind, 'attempt');

    const refuse = async (reason, retryAfter) => {
      await log('refused', { userId, ip, email, reason });
      const refused = await countWhere(eq(kempoCommerceAttempt.kind, 'refused'), hour);
      if(isMilestone(refused)){
        await notifyAdmins({ title: 'Checkout attempts are being refused', message: `${refused} checkout attempt${refused === 1 ? ' was' : 's were'} refused in the last hour (${reason}). This can be someone trying stolen cards.`, level: 'warning', dedupeKey: `checkout-refused:${new Date().toISOString().slice(0, 13)}:${refused}` });
      }
      return [{ code: 429, msg: 'Too many checkout attempts. Please try again a little later.', retryAfter }, null];
    };

    const cooldownMs = config.failedPaymentCooldownMinutes * 60000;
    if(config.failedPaymentLimit > 0){
      const window = gte(kempoCommerceAttempt.createdAt, since(cooldownMs));
      const declines = eq(kempoCommerceAttempt.kind, 'decline');
      const byUser = userId ? await countWhere(declines, eq(kempoCommerceAttempt.userId, userId), window) : 0;
      const byIp = ip ? await countWhere(declines, eq(kempoCommerceAttempt.ip, ip), window) : 0;
      if(byUser >= config.failedPaymentLimit || byIp >= config.failedPaymentLimit) return refuse('too many declined payments', Math.ceil(cooldownMs / 1000));
    }
    if(config.purchaseLimitPerUser > 0 && userId && await countWhere(attempts, eq(kempoCommerceAttempt.userId, userId), hour) >= config.purchaseLimitPerUser) return refuse('too many attempts by one account', 3600);
    if(config.purchaseLimitPerIp > 0 && ip && await countWhere(attempts, eq(kempoCommerceAttempt.ip, ip), hour) >= config.purchaseLimitPerIp) return refuse('too many attempts from one address', 3600);
    if(config.purchaseLimitGlobal > 0 && await countWhere(attempts, hour) >= config.purchaseLimitGlobal) return refuse('too many attempts site-wide', 3600);

    await log('attempt', { userId, ip, email });
    return [null, null];
  } catch(error) {
    /* If the limits cannot be checked, checkout continues: refusing every customer is worse than not limiting for a moment. */
    console.error('[kempo-commerce] Could not check the checkout limits:', error);
    return [null, null];
  }
};

/* A declined payment, counted towards the cool-down. Returns true when the account or address is now over the limit. */
export const recordDecline = async ({ userId = null, ip = null, email = null }) => {
  try {
    const config = await readConfig();
    await log('decline', { userId, ip, email });
    if(config.failedPaymentLimit <= 0) return false;
    const window = gte(kempoCommerceAttempt.createdAt, since(config.failedPaymentCooldownMinutes * 60000));
    const declines = eq(kempoCommerceAttempt.kind, 'decline');
    const byUser = userId ? await countWhere(declines, eq(kempoCommerceAttempt.userId, userId), window) : 0;
    const byIp = ip ? await countWhere(declines, eq(kempoCommerceAttempt.ip, ip), window) : 0;
    return byUser >= config.failedPaymentLimit || byIp >= config.failedPaymentLimit;
  } catch(error) {
    console.error('[kempo-commerce] Could not record the decline:', error);
    return false;
  }
};

/* Old attempts are only needed for the longest window. */
export const pruneAttempts = async () => {
  const config = await readConfig();
  const keep = Math.max(HOUR, config.failedPaymentCooldownMinutes * 60000) * 2;
  await db.delete(kempoCommerceAttempt).where(lt(kempoCommerceAttempt.createdAt, since(keep)));
};
