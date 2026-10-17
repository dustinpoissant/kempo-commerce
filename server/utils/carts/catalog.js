import { getProducts, computePrice, unavailableReason, UNLIMITED, creditQuote, getCreditsPerUnit, getPrice } from 'kempo-products/sdk';
import { getSetting } from 'kempo/server/sdk.js';

/*
  What the catalog says about the products in a cart, and the notices that come of it.

  A cart is never trusted. Each time it is read, every line is looked up again and re-priced, and
  anything wrong is reported as a notice for the customer to see rather than silently fixed. A notice
  is `{ type, lineId, productId, message, blocking }`; a blocking one stops checkout.

    unavailable          the product is no longer for sale (blocks)
    out_of_stock         none left (blocks); or fewer than asked for, and the quantity is reduced
    option_unavailable   a chosen option is out of stock or gone (blocks)
    price_changed        the price differs from when it was added; the new price is used
    quantity_limit       over the per-line limit; the quantity is reduced
*/

const NOT_STOCK = reason => reason && reason !== 'Out of stock';

export const readCurrency = async () => {
  const [error, currency] = await getSetting('kempo-products', 'currency', 'usd');
  return error || typeof currency !== 'string' || !currency ? 'usd' : currency;
};

/* The products, by id. */
export const loadProducts = async ids => {
  const unique = [...new Set(ids)];
  if(!unique.length) return new Map();
  const [error, found] = await getProducts({ ids: unique, limit: unique.length });
  if(error) return new Map();
  return new Map(found.items.map(product => [product.id, product]));
};

/*
  Works out one line against the catalog. Returns `{ line, notices, change }`: the line as it will be
  shown (priced, with its product's name and picture), any notices, and `change` — the quantity or
  price to save back when the catalog made a correction.
*/
export const checkLine = ({ row, product, limits, credits }) => {
  const notices = [];
  const base = { id: row.id, productId: row.productId, selections: row.selections, data: row.data, quantity: row.quantity };
  const notice = (type, message, blocking = false) => notices.push({ type, lineId: row.id, productId: row.productId, message, blocking });

  if(!product){
    notice('unavailable', 'This product is no longer available', true);
    return { line: { ...base, name: 'Unavailable product', slug: '', unitPrice: row.unitPrice ?? 0, lineTotal: (row.unitPrice ?? 0) * row.quantity, blocked: true, optionLines: [] }, notices, change: null };
  }

  const identity = { ...base, name: product.name, slug: product.slug, images: product.images ?? [], quantity: product.quantity };
  const reason = unavailableReason(product);
  if(NOT_STOCK(reason)){
    notice('unavailable', `${reason}`, true);
    return { line: { ...identity, unitPrice: row.unitPrice ?? product.price ?? 0, lineTotal: (row.unitPrice ?? product.price ?? 0) * row.quantity, blocked: true, optionLines: [] }, notices, change: null };
  }

  const [priceError, priced] = computePrice(product, product.options, row.selections);
  if(priceError){
    notice('option_unavailable', priceError.msg, true);
    return { line: { ...identity, unitPrice: row.unitPrice ?? product.price ?? 0, lineTotal: (row.unitPrice ?? product.price ?? 0) * row.quantity, blocked: true, optionLines: [] }, notices, change: null };
  }

  let quantity = row.quantity;
  if(product.quantity === 0){
    notice('out_of_stock', 'This product is out of stock', true);
    return { line: { ...identity, unitPrice: priced.unit, lineTotal: priced.unit * quantity, blocked: true, optionLines: priced.lines }, notices, change: null };
  }
  if(product.quantity !== UNLIMITED && quantity > product.quantity){
    quantity = product.quantity;
    notice('out_of_stock', `Only ${product.quantity} left, so the quantity was reduced`);
  }
  if(quantity > limits.maxQuantityPerLine){
    quantity = limits.maxQuantityPerLine;
    notice('quantity_limit', `You can buy at most ${limits.maxQuantityPerLine} of one product at a time, so the quantity was reduced`);
  }
  if(row.unitPrice !== null && row.unitPrice !== undefined && row.unitPrice !== priced.unit){
    notice('price_changed', `The price changed from ${row.unitPrice} to ${priced.unit}`);
  }

  const quote = product.creditPercent && credits.enabled
    ? creditQuote({ percent: product.creditPercent, unitPrice: priced.unit, currency: limits.currency, perUnit: credits.perUnit })
    : null;

  return {
    line: {
      ...identity,
      quantity,
      unitPrice: priced.unit,
      lineTotal: priced.unit * quantity,
      optionLines: priced.lines,
      selections: priced.selections,
      blocked: false,
      minimumPrice: product.minimumPrice ?? null,
      creditsGranted: credits.enabled ? product.creditsGranted || 0 : 0,
      creditsOnly: credits.enabled ? Boolean(product.creditsOnly) : false,
      credits: quote,
    },
    notices,
    change: quantity !== row.quantity || priced.unit !== row.unitPrice ? { quantity, unitPrice: priced.unit } : null,
  };
};

/* The price of one unit of a product with these choices, straight from kempo-products. */
export const priceOf = (productId, selections) => getPrice(productId, selections);

export { getCreditsPerUnit };
