/*
  totals:discounts: what a sales extension pushes. It says what each discount is (a fixed amount or a percent, and
  whether it combines) and leaves the amount for commerce to work out, line by line.
*/
export default ({ lines, adjustments }) => {
  for(const line of lines){
    adjustments.push({ type: 'discount', code: 'sale:fixed', label: 'Sale', lineId: line.id, source: 'fixture-sales', data: { kind: 'fixed', value: 1000, stackable: true } });
    adjustments.push({ type: 'discount', code: 'sale:fall', label: 'Sale', lineId: line.id, source: 'fixture-sales', data: { kind: 'percent', value: 25, stackable: true } });
    adjustments.push({ type: 'discount', code: 'promo:thanks', label: 'Promo', lineId: line.id, source: 'fixture-promo', data: { kind: 'percent', value: 10, stackable: true } });
  }
};
