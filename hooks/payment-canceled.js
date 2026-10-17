import { onPaymentCanceled } from '../server/utils/checkout/payments.js';

/* A payment was cancelled by someone else: the order it was for fails. */
export default async ({ payment }) => {
  await onPaymentCanceled(payment);
};
