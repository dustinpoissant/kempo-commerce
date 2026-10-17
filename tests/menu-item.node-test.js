import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { findNavItems } from 'kempo/server/sdk.js';

/*
  The cart button is offered to kempo's Menus page as an item an admin adds to the navigation, instead
  of a script putting it there. These keep the file kempo reads well-formed (a malformed one is skipped
  silently, which would just make "Cart" vanish from the list) and keep the script from placing the button.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default {
  'kempo finds the Cart item, named for this extension, with the element and the script it needs': async ({ pass, fail }) => {
    const [error, items] = await findNavItems({ extensionDirs: [path.join(root, 'public')] });
    if(error) return fail(error.msg);
    const cart = items.find(item => item.key === 'kempo-commerce:cart');
    if(!cart) return fail(`not offered: ${JSON.stringify(items.map(item => item.key))}`);
    if(cart.label !== 'Cart' || cart.iconSrc !== '/commerce/icons/shopping_cart.svg' || !cart.description) return fail(JSON.stringify(cart));
    if(!cart.markup.includes('<k-commerce-cart-button></k-commerce-cart-button>') || !cart.markup.includes('/commerce/components/CartButton.js')) return fail(cart.markup);
    pass('');
  },

  'the Cart item is a real link to the cart page, so a nav styles it like its other links and it works before any script runs': async ({ pass, fail }) => {
    const [, items] = await findNavItems({ extensionDirs: [path.join(root, 'public')] });
    const cart = items.find(item => item.key === 'kempo-commerce:cart');
    if(!/^<a href="\/cart\/">\s*<k-commerce-cart-button><\/k-commerce-cart-button>\s*<\/a>/.test(cart.markup)) return fail(cart.markup);
    const source = await readFile(path.join(root, 'public/components/CartButton.js'), 'utf8');
    if(!source.includes("this.closest('a')") || !source.includes('event.preventDefault()')) return fail('the button does not enhance the link around it');
    if(!source.includes('event.ctrlKey') || !source.includes('event.metaKey')) return fail('a Ctrl or Cmd click should still follow the link');
    if(/<button/.test(source)) return fail('it renders its own button again, which a nav cannot style like a link');
    if(/#[0-9a-f]{3,6}\b|rgb\(/i.test(source)) return fail('a colour is hard-coded, which would ignore the theme');
    pass('');
  },

  'the storefront script no longer puts the cart button into the navigation': async ({ pass, fail }) => {
    const script = await readFile(path.join(root, 'public/components/Storefront.js'), 'utf8');
    if(/createElement\(['"]k-commerce-cart-button/.test(script) || /#main-nav|querySelector\(['"]nav/.test(script)) return fail('it still places the button itself');
    if(!script.includes('k-commerce-mini-cart')) return fail('the mini-cart should still be placed');
    pass('');
  },
};
