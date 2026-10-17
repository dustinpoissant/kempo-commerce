import { onPaymentDisputed } from '../server/utils/checkout/payments.js';

/* A chargeback opened or closed: recorded and flagged, never acted on. */
export default async ({ payment, disputed, reason }) => {
  await onPaymentDisputed(payment, disputed, reason);
};
