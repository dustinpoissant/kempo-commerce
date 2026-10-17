import { onPaymentSucceeded } from '../server/utils/checkout/payments.js';

/* The money arrived: complete the order it was for. */
export default async ({ payment }) => {
  await onPaymentSucceeded(payment);
};
