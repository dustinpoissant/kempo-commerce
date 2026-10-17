import { onPaymentRefunded } from '../server/utils/checkout/payments.js';

/* Money went back from the processor's side; flagged if it was not a refund made here. */
export default async ({ payment, refund }) => {
  await onPaymentRefunded(payment, refund);
};
