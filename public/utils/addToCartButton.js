import { html, nothing } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import { VARIANTS } from '/commerce/utils/addToCartOptions.js';

/*
  The Add to cart button, drawn the same way wherever it appears: on a product card, on a product page, on a page
  built in the page builder, and in the builder's editor. Its text, icon and style come from the widget's settings.
  An icon is the address of an SVG file, and an empty one is no icon. The defaults are the buttons product pages have, which
  fill the width of their place; the widget's `full` setting turns that off.
*/
export default ({ label, icon, variant, full = true, disabled = false, busy = false, reason = '', onClick }) => {
  const style = VARIANTS.some(option => option.value === variant) ? variant : 'primary';
  const classes = [style === 'default' ? '' : style, full ? 'full' : ''].filter(Boolean).join(' ');
  const words = reason || (busy ? 'Adding…' : label || 'Add to cart');
  const src = icon === undefined ? '/commerce/icons/add_shopping_cart.svg' : icon;
  return html`<button class="${classes}" ?disabled=${disabled} @click=${onClick}>${src ? html`<k-icon src=${src}></k-icon> ` : nothing}${words}</button>`;
};
