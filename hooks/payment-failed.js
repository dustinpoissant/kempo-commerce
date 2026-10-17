import { onPaymentFailed } from '../server/utils/checkout/payments.js';

/* A card was declined: counts towards the cool-down. */
export default async ({ payment }) => {
  await onPaymentFailed(payment);
};
