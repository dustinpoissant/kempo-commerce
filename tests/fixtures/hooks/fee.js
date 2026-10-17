/* totals:fees: a shipping fee, taxable, with the extension's name as its source. */
export default ({ adjustments }) => {
  adjustments.push({ type: 'fee', code: 'ship', label: 'Shipping', amount: 700, taxable: true, source: 'fixture-shipping' });
};
