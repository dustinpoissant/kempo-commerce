/*
  How the discounts on one line combine. Pure arithmetic in the smallest currency unit, per unit of the
  product, so the cart, the checkout, the order and a storefront price all get the same answer.

  A discount is `{ kind: 'fixed' | 'percent', value, stackable }`: a fixed amount off, or a percent off.

  Among the discounts that apply to a line:

    - the ones that can be combined (`stackable`) all apply together: every fixed amount comes off the
      price first, then the percents are added up and taken off what is left;
    - one that cannot be combined applies alone;
    - the line gets whichever of those saves the most (the combination wins a tie);
    - the price never goes below the product's minimum price, or zero when it has none.

  Percents are rounded down, so rounding never takes off more than was stated. Each row's share of a
  combined percent is rounded down too, and the leftover unit goes to the first percent row, so the rows
  add up to the whole.

  Returns `{ amounts, total, limited }`: what each discount (by its position in the input) takes off one
  unit, the total taken off one unit, and whether the minimum price held something back.
*/

const valid = discount => discount
  && (discount.kind === 'fixed' || discount.kind === 'percent')
  && Number.isSafeInteger(discount.value)
  && discount.value > 0
  && (discount.kind === 'fixed' || discount.value <= 100);

/* Makes the amounts add up to `total`: takes from the last first when they are over, gives the rest to the first when under. */
const fit = (amounts, total) => {
  let sum = amounts.reduce((all, amount) => all + amount, 0);
  for(let i = amounts.length - 1; i >= 0 && sum > total; i--){
    const cut = Math.min(amounts[i], sum - total);
    amounts[i] -= cut;
    sum -= cut;
  }
  if(sum < total && amounts.length) amounts[0] += total - sum;
  return amounts;
};

/* What taking these discounts together off `price` comes to, row by row: [[index, amount]]. */
const together = (price, discounts) => {
  const rows = [];
  let left = price;
  for(const discount of discounts.filter(entry => entry.kind === 'fixed')){
    const take = Math.min(discount.value, left);
    rows.push([discount.index, take]);
    left -= take;
  }
  const percents = discounts.filter(entry => entry.kind === 'percent');
  if(percents.length){
    const added = Math.min(100, percents.reduce((all, entry) => all + entry.value, 0));
    const amounts = fit(percents.map(entry => Math.floor(left * entry.value / 100)), Math.floor(left * added / 100));
    percents.forEach((entry, position) => rows.push([entry.index, amounts[position]]));
  }
  return rows;
};

const sumOf = rows => rows.reduce((all, [, amount]) => all + amount, 0);

export const resolveUnitDiscounts = ({ unitPrice, minimumPrice = null, discounts = [] }) => {
  const amounts = discounts.map(() => 0);
  if(!Number.isSafeInteger(unitPrice) || unitPrice <= 0) return { amounts, total: 0, limited: false };

  const entries = discounts.map((discount, index) => ({ ...discount, index })).filter(valid);
  const room = Math.max(0, unitPrice - (Number.isSafeInteger(minimumPrice) && minimumPrice > 0 ? minimumPrice : 0));

  const candidates = [
    entries.filter(entry => entry.stackable),
    ...entries.filter(entry => !entry.stackable).map(entry => [entry]),
  ].filter(set => set.length).map(set => together(unitPrice, set));

  let best = [];
  for(const rows of candidates){
    if(sumOf(rows) > sumOf(best)) best = rows;
  }

  const wanted = sumOf(best);
  const total = Math.min(wanted, room);
  if(total < wanted){
    const trimmed = fit(best.map(([, amount]) => amount), total);
    best = best.map(([index], position) => [index, trimmed[position]]);
  }
  for(const [index, amount] of best) amounts[index] = amount;

  return { amounts, total, limited: total < wanted };
};

/*
  Works out the discount rows that handlers pushed onto a cart or an order. A row that says what it is,
  `data: { kind, value, stackable }` with a `lineId`, gets its amount here, per line, in the order above;
  its amount is for the whole line (per unit times quantity). A row that already has an `amount` and no
  `kind` is left alone, so earlier handlers keep working. A row with a `kind` and no line is dropped,
  because an order-wide discount is not worked out here yet.

  Rows that end up taking nothing off are dropped. When the minimum price held a line back, its rows say
  so in `data.limited`.
*/
export const resolveDiscountRows = ({ adjustments, lines }) => {
  const kinded = adjustments.filter(row => row?.type === 'discount' && row.data && (row.data.kind === 'fixed' || row.data.kind === 'percent'));
  if(!kinded.length) return adjustments;

  const resolved = new Map();
  const byLine = new Map();
  for(const row of kinded){
    if(!row.lineId) continue;
    if(!byLine.has(row.lineId)) byLine.set(row.lineId, []);
    byLine.get(row.lineId).push(row);
  }

  for(const [lineId, rows] of byLine){
    const line = lines.find(candidate => candidate.id === lineId);
    if(!line) continue;
    const { amounts, limited } = resolveUnitDiscounts({
      unitPrice: line.unitPrice,
      minimumPrice: line.minimumPrice ?? null,
      discounts: rows.map(row => ({ kind: row.data.kind, value: row.data.value, stackable: row.data.stackable === true })),
    });
    rows.forEach((row, position) => {
      const amount = amounts[position] * line.quantity;
      if(amount > 0) resolved.set(row, { ...row, amount, data: { ...row.data, ...(limited ? { limited: true } : {}) } });
    });
  }

  return adjustments.flatMap(row => kinded.includes(row) ? (resolved.has(row) ? [resolved.get(row)] : []) : [row]);
};
