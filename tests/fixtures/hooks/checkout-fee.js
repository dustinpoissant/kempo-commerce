/* totals:fees at checkout only: a fee that depends on the details the customer has entered. */
export default ({ checkout, adjustments }) => {
  if(!checkout) return;
  adjustments.push({ type: 'fee', code: 'ship', label: 'Shipping', amount: checkout.data?.shipping ? 500 : 900, taxable: false, source: 'fixture-checkout-fee' });
};
