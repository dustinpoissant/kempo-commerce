/*
  An order for the page builder to draw, since the builder shows the checkout page without anyone's real cart behind it. It
  has the shape the server answers with: a cart of two lines, a card to pay with, and an offer of store credit and credits so
  the part for them can be seen. A signed-in customer, so the email is not asked for.
*/
export default () => ({
  empty: false,
  cart: {
    id: 'sample',
    notices: [],
    adjustments: [],
    lines: [
      { id: 'sample-1', productId: 'sample-1', slug: 'sample-product', name: 'Sample product', selections: { size: 'Large' }, unitPrice: 2500, quantity: 2, lineTotal: 5000 },
      { id: 'sample-2', productId: 'sample-2', slug: 'another-product', name: 'Another product', selections: {}, unitPrice: 2500, quantity: 1, lineTotal: 2500 },
    ],
  },
  totals: { subtotal: 7500, total: 7500, taxTotal: 0, taxComputed: false, pricesIncludeTax: false },
  taxEnabled: false,
  tenders: [
    { kind: 'store-credit', label: 'Store credit', max: 1000, detail: { balance: 1000 } },
    { kind: 'credits', label: 'Credits', max: 500, detail: { balance: 50, perUnit: 10, maxCredits: 50 } },
  ],
  plan: [{ kind: 'card', amount: 7500 }],
  fields: [],
  required: { country: false, state: false, postalCode: false },
  account: { signedIn: true, required: false, canCreate: false },
  refundPolicy: '',
});
