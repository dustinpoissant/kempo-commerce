/*
  The choices the Add to cart button offers that are not icons (icons are chosen from kempo's icon picker, so any
  icon the site has can be used). No browser imports, so the tests can read the same lists the page builder shows,
  and kempo-config.json must list the same values.
*/
export const VARIANTS = [
  { value: 'default', label: 'Default' },
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'danger', label: 'Danger' }
];

export const PRESETS = [
  { label: 'Add to cart', icon: '/commerce/icons/add_shopping_cart.svg', variant: 'primary' },
  { label: 'Buy now', icon: '/commerce/icons/shopping_cart_checkout.svg', variant: 'success' },
  { label: 'Add to basket', icon: '/commerce/icons/shopping_cart.svg', variant: 'secondary' }
];
