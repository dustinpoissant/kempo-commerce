import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderExternalPage } from 'kempo-server/templating';
import { DEFAULTS, NORMALISE, publicConfig } from '../server/utils/config/settings.js';
import { VALIDATORS } from '../server/utils/config/validate.js';

/*
  "Add to cart" reaches kempo-products' cards and product page by composition: this extension's
  product-actions.global.html fills locations those pages carry. This renders the real products pages with
  the real file, as a site does, so a renamed location on either side fails here instead of the button
  silently going missing.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productsPublic = path.join(root, 'node_modules', 'kempo-products', 'public');
const commercePublic = path.join(root, 'public');

const render = async page => {
  const base = await mkdtemp(path.join(tmpdir(), 'kempo-commerce-actions-'));
  const site = path.join(base, 'site');
  try {
    await mkdir(site);
    await writeFile(path.join(site, 'default.template.html'), '<!DOCTYPE html><html><body><main><location /></main><location name="scripts" /></body></html>');
    return await renderExternalPage(path.join(productsPublic, page), site, site, {}, {}, 10, [commercePublic, productsPublic], [productsPublic, commercePublic]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

const ADD = '<k-commerce-add-to-cart slot="actions"></k-commerce-add-to-cart>';
const SCRIPT = '<script type="module" src="/commerce/components/AddToCart.js"></script>';

export default {
  'the product list\'s one card template holds the add-to-cart element, and its script loads outside it': async ({ pass, fail }) => {
    const html = await render('index.page.html');
    const template = html.match(/<template data-products-card>([\s\S]*?)<\/template>/)?.[1];
    if(!template || !template.includes(ADD)) return fail(`template: ${template}`);
    if(template.includes('<script')) return fail('a script is inside the template');
    if(html.split(SCRIPT).length - 1 !== 1 || html.indexOf(SCRIPT) < html.indexOf('</template>')) return fail('the script should load once, after the template');
    pass('');
  },

  'the product page carries add-to-cart in its actions slot': async ({ pass, fail }) => {
    const html = (await render('[slug]/index.page.html')).split(/>\s+</).join('><');
    if(!html.includes(`<k-products-detail>${ADD}`)) return fail(html);
    if(html.split(SCRIPT).length - 1 !== 1) return fail('the script should load once');
    pass('');
  },

  'an add is confirmed by a toast naming the product, with the name escaped, not by a message in the page': async ({ pass, fail }) => {
    const source = await readFile(path.join(commercePublic, 'components/AddToCart.js'), 'utf8');
    if(!source.includes('Toast.success(')) return fail('no toast');
    if(!source.includes(' to your cart')) return fail('the toast does not name the product');
    if(!source.includes(".replace(/&/g, '&amp;').replace(/</g, '&lt;')")) return fail('the name is put into HTML unescaped');
    if(!source.includes("position: 'bottom center'")) return fail('the toast would cover the mini-cart');
    if(source.includes('tc-success') || /this.message/.test(source)) return fail('there is still an inline message');
    pass('');
  },

  'the View cart button on the add confirmation is a setting: mini-cart by default, or the cart page, or none': async ({ pass, fail }) => {
    if(DEFAULTS.addToCartAction !== 'mini-cart') return fail(`default: ${DEFAULTS.addToCartAction}`);
    for(const value of ['mini-cart', 'cart-page', 'none']){
      const [error, kept] = VALIDATORS.add_to_cart_toast_action(value);
      if(error || kept !== value) return fail(`refused ${value}`);
      if(NORMALISE.addToCartAction(value) !== value) return fail(`normalised ${value}`);
    }
    const [refused] = VALIDATORS.add_to_cart_toast_action('popup');
    if(refused?.code !== 400) return fail('an unknown choice was accepted');
    if(NORMALISE.addToCartAction('popup') !== 'mini-cart' || NORMALISE.addToCartAction(undefined) !== 'mini-cart') return fail('an unknown stored value should fall back to the default');
    if(publicConfig({ ...DEFAULTS, addToCartAction: 'none' }).addToCartAction !== 'none') return fail('the page is not told');
    const source = await readFile(path.join(commercePublic, 'components/AddToCart.js'), 'utf8');
    if(!source.includes("action: 'View cart'") || !source.includes('miniCart.open()') || !source.includes("location.href = '/cart/'")) return fail('the button does not offer both places');
    pass('');
  },

  'the mini-cart does not open on add unless a site turns it on': async ({ pass, fail }) => {
    const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
    const declared = config.settings.find(setting => setting.name === 'mini_cart_open_on_add');
    if(declared?.value !== 'false') return fail(`declared default: ${declared?.value}`);
    const settings = await readFile(path.join(root, 'server/utils/config/settings.js'), 'utf8');
    if(!/miniCartOpenOnAdd: false,/.test(settings)) return fail('the built-in default is not false');
    const mini = await readFile(path.join(commercePublic, 'components/MiniCart.js'), 'utf8');
    if(!mini.includes('miniCartOpenOnAdd === true')) return fail('it opens unless told not to');
    pass('');
  },

  'the element finds its card or product page itself, and does not register with the old registry': async ({ pass, fail }) => {
    const source = await readFile(path.join(commercePublic, 'components/AddToCart.js'), 'utf8');
    if(/registerProductAction\(/.test(source)) return fail('it still registers');
    if(!source.includes("closest('k-products-card, k-products-detail')") || !source.includes("addEventListener('selection-change'")) return fail('it does not look for its host');
    const storefront = await readFile(path.join(commercePublic, 'components/Storefront.js'), 'utf8');
    if(storefront.includes('AddToCart')) return fail('the storefront script should not load it on every page');
    pass('');
  },
};
