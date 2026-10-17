import { getSetting } from 'kempo/server/sdk.js';

/*
  Every setting, read and made safe to use in one place.

  Each is editable on the settings screen, so everything the rest of the extension sees has been
  through a normaliser here, with the declared default behind it. A value that is not usable falls
  back rather than breaking checkout.
*/

export const OWNER = 'kempo-commerce';

/* The same values kempo-config.json declares, as the real types. A static test checks they agree. */
export const DEFAULTS = {
  siteUrl: 'http://localhost:3000',
  guestCheckout: true,
  allowAccountCreation: true,
  cartExpiryDays: 30,
  cartPurgeDays: 90,
  maxLinesPerCart: 100,
  maxQuantityPerLine: 99,
  pendingExpiryMinutes: 60,
  orderNumberPrefix: '#',
  orderNumberPadding: 0,
  orderNumberStart: 1000,
  restockOnRefund: true,
  refundPolicy: '',
  miniCartSide: 'right',
  miniCartOpenOnAdd: false,
  addToCartAction: 'mini-cart',
  miniCartInject: true,
  miniCartHideOnCartPages: true,
  purchaseLimitPerUser: 10,
  purchaseLimitPerIp: 20,
  purchaseLimitGlobal: 500,
  failedPaymentLimit: 3,
  failedPaymentCooldownMinutes: 60,
  trustProxy: false,
};

export const SETTING_NAMES = {
  siteUrl: 'site_url',
  guestCheckout: 'guest_checkout',
  allowAccountCreation: 'allow_account_creation',
  cartExpiryDays: 'cart_expiry_days',
  cartPurgeDays: 'cart_purge_days',
  maxLinesPerCart: 'max_lines_per_cart',
  maxQuantityPerLine: 'max_quantity_per_line',
  pendingExpiryMinutes: 'pending_expiry_minutes',
  orderNumberPrefix: 'order_number_prefix',
  orderNumberPadding: 'order_number_padding',
  orderNumberStart: 'order_number_start',
  restockOnRefund: 'restock_on_refund',
  refundPolicy: 'refund_policy',
  miniCartSide: 'mini_cart_side',
  miniCartOpenOnAdd: 'mini_cart_open_on_add',
  addToCartAction: 'add_to_cart_toast_action',
  miniCartInject: 'mini_cart_inject',
  miniCartHideOnCartPages: 'mini_cart_hide_on_cart_pages',
  purchaseLimitPerUser: 'purchase_limit_per_user',
  purchaseLimitPerIp: 'purchase_limit_per_ip',
  purchaseLimitGlobal: 'purchase_limit_global',
  failedPaymentLimit: 'failed_payment_limit',
  failedPaymentCooldownMinutes: 'failed_payment_cooldown_minutes',
  trustProxy: 'trust_proxy',
};

/* A count that must be a whole number, at least `min`. Anything else is the default. */
const count = (key, min = 0) => value => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= min ? number : DEFAULTS[key];
};

const flag = key => value => {
  if(typeof value === 'boolean') return value;
  if(value === 'true') return true;
  if(value === 'false') return false;
  return DEFAULTS[key];
};

const text = key => value => typeof value === 'string' ? value : DEFAULTS[key];

export const NORMALISE = {
  siteUrl: value => typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : DEFAULTS.siteUrl,
  guestCheckout: flag('guestCheckout'),
  allowAccountCreation: flag('allowAccountCreation'),
  cartExpiryDays: count('cartExpiryDays', 1),
  cartPurgeDays: count('cartPurgeDays', 1),
  maxLinesPerCart: count('maxLinesPerCart', 1),
  maxQuantityPerLine: count('maxQuantityPerLine', 1),
  pendingExpiryMinutes: count('pendingExpiryMinutes', 1),
  orderNumberPrefix: text('orderNumberPrefix'),
  orderNumberPadding: count('orderNumberPadding', 0),
  orderNumberStart: count('orderNumberStart', 0),
  restockOnRefund: flag('restockOnRefund'),
  refundPolicy: text('refundPolicy'),
  miniCartSide: value => value === 'left' ? 'left' : 'right',
  miniCartOpenOnAdd: flag('miniCartOpenOnAdd'),
  addToCartAction: value => ['mini-cart', 'cart-page', 'none'].includes(value) ? value : 'mini-cart',
  miniCartInject: flag('miniCartInject'),
  miniCartHideOnCartPages: flag('miniCartHideOnCartPages'),
  purchaseLimitPerUser: count('purchaseLimitPerUser'),
  purchaseLimitPerIp: count('purchaseLimitPerIp'),
  purchaseLimitGlobal: count('purchaseLimitGlobal'),
  failedPaymentLimit: count('failedPaymentLimit'),
  failedPaymentCooldownMinutes: count('failedPaymentCooldownMinutes', 1),
  trustProxy: flag('trustProxy'),
};

export const readConfig = async () => {
  const keys = Object.keys(DEFAULTS);

  const values = await Promise.all(keys.map(async key => {
    const [error, value] = await getSetting(OWNER, SETTING_NAMES[key], DEFAULTS[key]);
    return NORMALISE[key](error ? DEFAULTS[key] : value);
  }));

  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
};

/* The public part: what a page may be told without being an administrator. */
export const publicConfig = config => ({
  guestCheckout: config.guestCheckout,
  allowAccountCreation: config.allowAccountCreation,
  refundPolicy: config.refundPolicy,
  maxQuantityPerLine: config.maxQuantityPerLine,
  miniCartSide: config.miniCartSide,
  miniCartOpenOnAdd: config.miniCartOpenOnAdd,
  addToCartAction: config.addToCartAction,
  miniCartInject: config.miniCartInject,
  miniCartHideOnCartPages: config.miniCartHideOnCartPages,
});
