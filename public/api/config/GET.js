import { readConfig, publicConfig } from '../../../server/utils/config/settings.js';
import { decimalsFor } from 'kempo-products/sdk';
import { readCurrency } from '../../../server/utils/carts/catalog.js';
import { taxEnabled } from '../../../server/utils/checkout/tax.js';

/* What a page needs to render: the currency, whether guests may check out, which side the mini-cart opens from. */
export default async (request, response) => {
  const config = await readConfig();
  const currency = await readCurrency();
  response.json({ config: { ...publicConfig(config), currency, decimals: decimalsFor(currency), taxEnabled: await taxEnabled() } });
};
