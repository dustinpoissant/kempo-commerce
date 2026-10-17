import { SETTING_NAMES } from './settings.js';

/*
  What the settings screen may save, checked strictly. The normalisers in settings.js are forgiving
  on purpose — a bad stored value falls back to the default rather than breaking checkout — but a
  value somebody is typing in right now gets told what is wrong with it instead.
*/

const KEYS = Object.fromEntries(Object.entries(SETTING_NAMES).map(([key, name]) => [name, key]));

const number = (label, min, max) => value => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? [null, parsed]
    : [{ code: 400, msg: `${label} must be a whole number from ${min} to ${max}` }, null];
};

const flag = label => value => {
  if(typeof value === 'boolean') return [null, value];
  if(value === 'true') return [null, true];
  if(value === 'false') return [null, false];
  return [{ code: 400, msg: `${label} must be on or off` }, null];
};

const text = (label, max) => value => {
  if(typeof value !== 'string') return [{ code: 400, msg: `${label} must be text` }, null];
  if(value.includes('\u0000')) return [{ code: 400, msg: `${label} cannot contain null characters` }, null];
  if(value.length > max) return [{ code: 400, msg: `${label} must be ${max} characters or fewer` }, null];
  return [null, value];
};

const url = label => value => {
  const [error, clean] = text(label, 500)(value);
  if(error) return [error, null];
  try {
    const parsed = new URL(clean.trim());
    if(!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
    return [null, clean.trim().replace(/\/+$/, '')];
  } catch {
    return [{ code: 400, msg: `${label} must be an address such as https://shop.example.com` }, null];
  }
};

export const VALIDATORS = {
  site_url: url('The site address'),
  guest_checkout: flag('Guest checkout'),
  allow_account_creation: flag('Account creation at checkout'),
  cart_expiry_days: number('Cart expiry', 1, 3650),
  cart_purge_days: number('Cart purge', 1, 3650),
  max_lines_per_cart: number('The most lines in a cart', 1, 1000),
  max_quantity_per_line: number('The most of a product on a line', 1, 10000),
  pending_expiry_minutes: number('Pending order expiry', 1, 10080),
  order_number_prefix: text('The order number prefix', 20),
  order_number_padding: number('Order number padding', 0, 12),
  order_number_start: number('The first order number', 0, 1000000000),
  restock_on_refund: flag('Restock on refund'),
  refund_policy: text('The refund policy', 5000),
  mini_cart_side: value => ['left', 'right'].includes(value) ? [null, value] : [{ code: 400, msg: 'The mini-cart side is left or right' }, null],
  mini_cart_open_on_add: flag('Open the mini-cart on add'),
  add_to_cart_toast_action: value => ['mini-cart', 'cart-page', 'none'].includes(value) ? [null, value] : [{ code: 400, msg: 'The View cart button opens the mini-cart or the cart page, or is left off' }, null],
  mini_cart_inject: flag('Show the mini-cart on every page'),
  mini_cart_hide_on_cart_pages: flag('Hide the mini-cart on the cart page'),
  purchase_limit_per_user: number('The per-account limit', 0, 1000000),
  purchase_limit_per_ip: number('The per-address limit', 0, 1000000),
  purchase_limit_global: number('The site-wide limit', 0, 100000000),
  failed_payment_limit: number('The decline limit', 0, 1000),
  failed_payment_cooldown_minutes: number('The decline cool-down', 1, 10080),
  trust_proxy: flag('Trust the proxy'),
};

/*
  `[error, updates]` — the settings in `body` that are known, each validated. Unknown names are an
  error rather than ignored: a typo in a setting name should not look like a save that worked.
*/
export const validateSettings = body => {
  if(!body || typeof body !== 'object' || Array.isArray(body)) return [{ code: 400, msg: 'Send the settings as an object' }, null];

  const updates = {};
  for(const [name, value] of Object.entries(body)){
    if(!KEYS[name] || !VALIDATORS[name]) return [{ code: 400, msg: `"${name}" is not a commerce setting` }, null];
    const [error, clean] = VALIDATORS[name](value);
    if(error) return [error, null];
    updates[name] = clean;
  }

  if(!Object.keys(updates).length) return [{ code: 400, msg: 'Nothing to save' }, null];
  return [null, updates];
};
