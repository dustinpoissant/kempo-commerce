import { loadProducts } from '../carts/catalog.js';

/*
  Where a customer can look at what they bought, as it is now. Each line gets `productUrl`: the product's page
  while the product still exists and is published, and null once it was deleted or taken off sale (the order keeps
  the name it was sold under, but there is nothing to link to). The current slug is used, not the one at the
  time of the order, because a renamed product keeps its page under the new address.
*/
export default async order => {
  if(!order?.lines?.length) return order;
  const products = await loadProducts(order.lines.map(line => line.productId));
  return {
    ...order,
    lines: order.lines.map(line => {
      const product = products.get(line.productId);
      return { ...line, productUrl: product && product.status === 'published' && product.slug ? `/products/${encodeURIComponent(product.slug)}/` : null };
    }),
  };
};
