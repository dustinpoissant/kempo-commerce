import { loadTax } from '../optional.js';
import { EVENTS, notify } from '../hooks.js';
import { subdivisionsOf } from './regions.js';

/*
  Tax comes from kempo-tax when it is installed and enabled, and from nothing otherwise: a store
  without it charges no tax and says nothing about it.

  kempo-tax's `prices_include_tax` setting decides whether the catalog's prices already contain tax. Commerce
  never decides that itself and never adds tax twice: with inclusive prices the tax is reported and the
  total is the subtotal; with exclusive prices the tax is added.

  A tax provider that is installed but cannot calculate (not connected, a key expired) is an error, not
  a silent zero. A checkout that quietly stopped charging tax for a week is a liability that grows with
  every order; a loud one is fixed the same afternoon.
*/

const FIELDS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'];

export const addressOf = billing => {
  const address = {};
  for(const field of FIELDS) if(typeof billing?.[field] === 'string' && billing[field].trim()) address[field] = billing[field].trim();
  if(address.country) address.country = address.country.toUpperCase();
  return address;
};

/* True when kempo-tax is on, which is what makes an address worth asking for. */
export const taxEnabled = async () => Boolean(await loadTax());

/*
  What the tax needs of an address, by country, beyond the country itself. A state or province where the tax
  is set by it (the United States and Canada), and a postal code where the provider refuses to calculate
  without one (the United States). Anywhere else the country is enough. Add a country here when its tax turns
  out to depend on more.
*/
const STATE_FOR_TAX = new Set(['US', 'CA']);
const POSTAL_CODE_FOR_TAX = new Set(['US']);

export const needsFor = country => ({
  country: true,
  state: STATE_FOR_TAX.has(country) && Boolean(subdivisionsOf(country)),
  postalCode: POSTAL_CODE_FOR_TAX.has(country),
});

/* What the address must have for tax to be calculated, as { country, state, postalCode } booleans; all false when tax is off. */
export const addressRequirements = async billing => {
  if(!(await taxEnabled())) return { country: false, state: false, postalCode: false };
  return needsFor(addressOf(billing).country);
};

/* True when the address has everything tax needs. */
const addressReady = address => {
  if(!address.country) return false;
  const needs = needsFor(address.country);
  return (!needs.state || Boolean(address.state)) && (!needs.postalCode || Boolean(address.postalCode));
};

/*
  Works out the tax on `lines` (each `{ id, lineTotal }`) plus any taxable fees, for an address.
  Returns [null, null] when there is nothing to tax with yet (tax is off, or the address is not complete
  enough: a provider asked early only answers with a complaint), or
  [null, { tax, total, calculationId, perLine, pricesIncludeTax }].

  The `totals:tax` notification lets another extension replace or add to what kempo-tax said.
*/
export const quoteTax = async ({ lines, adjustments = [], billing, currency, cart, order }) => {
  const sdk = await loadTax();
  if(!sdk) return [null, null];

  const address = addressOf(billing);
  if(!addressReady(address)) return [null, null];

  /* A line-level discount lowers what is taxed on that line; one on the whole order is not spread here. */
  const taxLines = lines.map(line => ({
    reference: line.id,
    /* What kind of product it is, so kempo-tax can tax it as its Settings say that type is (credits are not taxed like a mug). */
    productType: line.productType,
    amount: Math.max(0, line.lineTotal + adjustments.filter(adjustment => adjustment.lineId === line.id).reduce((sum, adjustment) => sum + adjustment.amount, 0)),
  })).filter(line => line.amount > 0);
  const shipping = adjustments.filter(adjustment => adjustment.type === 'fee' && adjustment.taxable).reduce((sum, adjustment) => sum + adjustment.amount, 0);
  if(!taxLines.length && shipping <= 0) return [null, null];

  const [error, result] = await sdk.calculateTax({ address, currency, lines: taxLines, ...(shipping > 0 ? { shipping: { amount: shipping } } : {}) });
  if(error) return [{ code: error.code === 409 ? 409 : 502, msg: `Tax could not be calculated: ${error.msg}` }, null];

  const quote = {
    tax: result.tax,
    total: result.total,
    calculationId: result.calculationId ?? null,
    perLine: Object.fromEntries((result.lines ?? []).map(line => [line.reference, line.tax])),
    pricesIncludeTax: (result.lines?.[0]?.taxBehavior ?? 'exclusive') === 'inclusive',
  };

  const payload = { cart, order, taxable: taxLines, address, tax: quote };
  await notify(EVENTS.totalsTax, payload);
  return [null, payload.tax];
};

/* Records the sale with kempo-tax once the payment has succeeded. Returns the transaction id, or null. */
export const recordSale = async ({ calculationId, reference }) => {
  const sdk = await loadTax();
  if(!sdk || !calculationId) return [null, null];
  const [error, sale] = await sdk.recordTransaction({ calculationId, reference });
  if(error) return [error, null];
  return [null, sale.transactionId];
};

/* Reverses part or all of a recorded sale, for a refund. */
export const reverseSale = async ({ transactionId, reference, amount }) => {
  const sdk = await loadTax();
  if(!sdk || !transactionId) return [null, null];
  const [error, reversal] = await sdk.reverseTransaction({ transactionId, reference, ...(amount ? { amount } : {}) });
  if(error) return [error, null];
  return [null, reversal];
};
