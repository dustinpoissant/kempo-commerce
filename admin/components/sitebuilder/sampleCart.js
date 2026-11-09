/*
  A cart for the page builder to draw, since the builder shows the cart page without anyone's real cart in it (and a real
  cart may be empty, which draws nothing of the layout). It has the shape the server answers with.
*/
export default () => ({
  id: 'sample',
  blocked: false,
  notices: [],
  adjustments: [],
  totals: { subtotal: 7500, total: 7500 },
  lines: [
    { id: 'sample-1', productId: 'sample-1', slug: 'sample-product', name: 'Sample product', selections: { size: 'Large' }, image: null, unitPrice: 2500, quantity: 2, lineTotal: 5000 },
    { id: 'sample-2', productId: 'sample-2', slug: 'another-product', name: 'Another product', selections: {}, image: null, unitPrice: 2500, quantity: 1, lineTotal: 2500 },
  ],
});
