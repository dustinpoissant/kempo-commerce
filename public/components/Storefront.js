import { getConfig } from '/commerce/sdk.js';

/*
  Loaded on every public page by storefront.global.html. With the site's `mini_cart_inject` on (the
  default), it puts the mini-cart on the page.

  "Add to cart" on products is not done here: product-actions.global.html puts it into kempo-products'
  product cards and product page, and loads its script on those pages only.

  It does not place the cart button. That is a menu item the admin adds to the site's navigation on
  kempo's Menus page (cart.menu-item.html), like any other link. A site with no menu places
  `<k-commerce-cart-button>` itself, and one that wants to place the mini-cart too turns
  `mini_cart_inject` off and uses `<k-commerce-mini-cart>`.
*/

const [error, data] = await getConfig();

if(!error && data.config.miniCartInject){
  await import('/commerce/components/MiniCart.js');

  if(!document.querySelector('k-commerce-mini-cart')) document.body.append(document.createElement('k-commerce-mini-cart'));
}
