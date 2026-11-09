import { access, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { VARIANTS, PRESETS } from '../public/utils/addToCartOptions.js';
import { parseSelections, selectionsText, validSelections, missingRequired } from '../public/utils/selections.js';
import iconSource from '../public/utils/iconSource.js';

/*
  The two page widgets the page builder offers. kempo's own registry code cleans each declaration (so a
  declaration it would refuse fails here and not in somebody's editor), and kempo-ui's page renderer takes a page
  through each widget. The kempo-ui modules are loaded from kempo's own copy, so they are the ones kempo's registry
  adds the widgets to.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async file => import(pathToFileURL(file).href);
const kempo = relative => load(path.join(root, 'node_modules', 'kempo', relative));
const ui = relative => load(path.join(root, 'node_modules', 'kempo', 'node_modules', 'kempo-ui', 'src', relative));

const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
const { normalizeExtensionWidget } = await kempo('server/utils/sitebuilder/registry.js');
const validateTree = (await kempo('server/utils/sitebuilder/validateTree.js')).default;
const { widgets, addWidget, registryOf } = await ui('utils/pageWidgets.js');
const { renderPage, collectModules } = await ui('utils/renderPage.js');
const { createNode } = await ui('utils/pageTree.js');

const declared = config.page_widgets.map(definition => normalizeExtensionWidget('kempo-commerce', definition));
const errors = declared.filter(([error]) => error).map(([error]) => error.msg);
declared.filter(([error]) => !error).forEach(([, widget]) => addWidget(widget));
const registry = registryOf(widgets);
const cartName = 'kempo-commerce-cart-button';
const addName = 'kempo-commerce-add-to-cart';
const productId = '9f2c1e0a44b7d3a1';

/* What the server keeps of a page's widgets, which is what is written to the page. */
const written = nodes => renderPage(validateTree(nodes, registry)[1], registry);

export default {
  'every declaration is one kempo accepts': async ({ pass, fail }) => {
    if(errors.length) return fail(errors.join('; '));
    if(config.page_widgets.length !== 16) return fail(`expected 16 commerce widgets, found ${config.page_widgets.length}`);
    pass('');
  },

  'the files the declarations point at exist': async ({ pass, fail }) => {
    const files = {};
    for(const definition of config.page_widgets){
      const { page_component, editor_component, settings_component, iconSrc } = definition;
      files[page_component] = `public/${page_component.replace(/^\/commerce\//, '')}`;
      if(editor_component) files[editor_component] = `admin/${editor_component.split('/kempo-commerce/')[1]}`;
      if(settings_component) files[settings_component] = `admin/${settings_component.split('/kempo-commerce/')[1]}`;
      if(iconSrc) files[iconSrc] = iconSrc.startsWith('/admin/extension/kempo-commerce/') ? `admin/${iconSrc.split('/kempo-commerce/')[1]}` : `public/${iconSrc.replace(/^\/commerce\//, '')}`;
    }
    for(const [url, file] of Object.entries(files)){
      try {
        await access(path.join(root, file));
      } catch {
        return fail(`${url} should be ${file}, which does not exist`);
      }
    }
    pass('');
  },

  'the cart button is written as its element, and loads its component': async ({ pass, fail }) => {
    const nodes = [createNode(cartName, {})];
    const html = renderPage(nodes, registry);
    if(!html.startsWith('<k-commerce-cart-button-widget') || /icon=|text=|counter=/.test(html)) return fail(html);
    if(!collectModules(nodes, registry).includes('/commerce/components/CartButtonWidget.js')) return fail('the component is not loaded');
    pass('');
  },

  'the add to cart button is written with its product': async ({ pass, fail }) => {
    const html = renderPage([createNode(addName, { 'product-id': productId })], registry);
    if(!html.startsWith('<k-commerce-add-to-cart-widget') || !html.includes(`product-id="${productId}"`)) return fail(html);
    pass('');
  },

  'an add to cart button with no product is written with no attribute': async ({ pass, fail }) => {
    const html = renderPage([createNode(addName, {})], registry);
    if(!html.startsWith('<k-commerce-add-to-cart-widget') || /product-id|label=|variant=/.test(html)) return fail(html);
    pass('');
  },

  'the add to cart button is full width only when asked, and hides the styles its own settings replace': async ({ pass, fail }) => {
    const plain = renderPage([createNode(addName, { 'product-id': productId })], registry);
    const wide = renderPage([createNode(addName, { 'product-id': productId, full: true })], registry);
    if(/\sfull/.test(plain) || !/\sfull[\s>]/.test(wide)) return fail(`${plain} | ${wide}`);
    const hidden = registry.get(addName).hideStyles ?? [];
    if(!['background', 'textColour'].every(part => hidden.includes(part))) return fail(`hidden: ${hidden.join()}`);
    const styled = renderPage([createNode(addName, { 'product-id': productId, styles: { background: 'danger', textColour: 'inv', align: 'center' } })], registry);
    if(/bg-danger|tc-inv/.test(styled) || !styled.includes('ta-center')) return fail(styled);
    pass('');
  },

  'the editor shows the button, and the add to cart widget has its own settings': async ({ pass, fail }) => {
    const nodes = [createNode(addName, { 'product-id': productId })];
    const html = renderPage(nodes, registry, { editor: true });
    if(!html.startsWith('<k-commerce-add-to-cart-editor')) return fail(html);
    const widget = registry.get(addName);
    if(widget.settingsTag !== 'k-commerce-add-to-cart-settings' || widget.settings !== '/admin/extension/kempo-commerce/components/sitebuilder/AddToCartWidgetSettings.js') return fail(JSON.stringify([widget.settings, widget.settingsTag]));
    pass('');
  },

  'the settings the declarations offer are the ones the button draws': async ({ pass, fail }) => {
    const byName = (name, widgetKey) => config.page_widgets.find(widget => widget.key === widgetKey).attributes.find(attribute => attribute.name === name);
    const sameValues = (options, expected) => JSON.stringify(options.map(option => option.value)) === JSON.stringify(expected.map(option => option.value));
    if(!sameValues(byName('variant', 'add-to-cart').options, VARIANTS)) return fail('add to cart styles differ from VARIANTS');
    if(byName('icon', 'add-to-cart').type !== 'icon' || byName('icon', 'cart-button').type !== 'icon') return fail('the icon settings should use the icon picker');
    for(const preset of PRESETS){
      if(!VARIANTS.some(option => option.value === preset.variant)) return fail(`preset ${preset.label} uses a style that is not offered`);
      const [, kept] = validateTree([createNode(addName, { icon: `src:${preset.icon}` })], registry);
      if(kept?.[0]?.attrs?.icon !== `src:${preset.icon}`) return fail(`preset ${preset.label} uses an icon path that is not allowed`);
    }
    pass('');
  },

  'an icon setting reaches the button as the address of the file': async ({ pass, fail }) => {
    if(iconSource('src:/commerce/icons/shopping_cart.svg') !== '/commerce/icons/shopping_cart.svg') return fail('a src: value should become its address');
    if(iconSource('/commerce/icons/shopping_cart.svg') !== '/commerce/icons/shopping_cart.svg') return fail('an address should be kept');
    if(iconSource('add') !== '/kempo-ui/icons/add.svg') return fail('a name should become the address of kempo-ui\'s icon');
    if(iconSource('') !== '' || iconSource(undefined) !== '') return fail('no icon should stay no icon');
    for(const definition of config.page_widgets.filter(widget => widget.attributes)){
      const icon = definition.attributes.find(attribute => attribute.name === 'icon');
      if(icon && !icon.default.startsWith('src:/commerce/icons/')) return fail(`${definition.key}'s default icon should be a src: value: ${icon.default}`);
    }
    pass('');
  },

  'a styled add to cart button is written with its text, icon and style': async ({ pass, fail }) => {
    const html = written([createNode(addName, { 'product-id': productId, label: 'Buy now', icon: 'src:/commerce/icons/shopping_cart_checkout.svg', variant: 'success' })]);
    for(const part of ['label="Buy now"', 'icon="src:/commerce/icons/shopping_cart_checkout.svg"', 'variant="success"']){
      if(!html.includes(part)) return fail(`${part} is missing: ${html}`);
    }
    pass('');
  },

  'a cart button with its text and icon changed and the count turned off is written': async ({ pass, fail }) => {
    const html = written([createNode(cartName, { text: 'Basket', icon: '', counter: false })]);
    if(!html.includes('text="Basket"') || !html.includes('counter="false"')) return fail(html);
    pass('');
  },

  'a cart button and an add to cart button set to inline are written inline, and block ones are written with no inline attribute': async ({ pass, fail }) => {
    for(const name of [cartName, addName]){
      const inline = written([createNode(name, { inline: true })]);
      const block = written([createNode(name, {})]);
      if(!inline.includes('inline="true"')) return fail(inline);
      if(block.includes('inline=')) return fail(block);
    }
    pass('');
  },

  'a variation of a product is written with the same choices': async ({ pass, fail }) => {
    const selections = selectionsText({ size: 'large', colour: 'blue' });
    const html = written([createNode(addName, { 'product-id': productId, selections })]);
    const match = /selections="([^"]*)"/.exec(html);
    const read = parseSelections((match?.[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    if(read.size !== 'large' || read.colour !== 'blue') return fail(html);
    pass('');
  },

  'the choices a button sends are only the ones the product has and can sell': async ({ pass, fail }) => {
    const product = { options: [
      { key: 'size', label: 'Size', required: true, choices: [{ key: 'small', available: true }, { key: 'large', available: false }] },
      { key: 'colour', label: 'Colour', required: false, choices: [{ key: 'blue', available: true }] }
    ] };
    if(JSON.stringify(validSelections(product, { size: 'large', colour: 'blue', extra: 'x' })) !== JSON.stringify({ colour: 'blue' })) return fail('sold out or unknown choices were kept');
    if(JSON.stringify(validSelections(product, { size: 'small' })) !== JSON.stringify({ size: 'small' })) return fail('a valid choice was dropped');
    if(JSON.stringify(missingRequired(product, { colour: 'blue' })) !== JSON.stringify(['Size'])) return fail(JSON.stringify(missingRequired(product, { colour: 'blue' })));
    if(missingRequired(product, { size: 'small' }).length) return fail('nothing should be missing');
    pass('');
  },

  'the selections text is stable and survives a bad value': async ({ pass, fail }) => {
    if(selectionsText({ colour: 'blue', size: 'large' }) !== selectionsText({ size: 'large', colour: 'blue' })) return fail('the order of the choices changed the text');
    if(selectionsText({}) !== '') return fail('no choices should be an empty text');
    if(Object.keys(parseSelections('not json')).length !== 0 || Object.keys(parseSelections('[1,2]')).length !== 0) return fail('a bad value should give no choices');
    pass('');
  },

  'a button that detects its parent product is written with no product of its own': async ({ pass, fail }) => {
    const html = renderPage([createNode(addName, { 'detect-parent': true, label: 'Buy now' })], registry);
    if(!html.startsWith('<k-commerce-add-to-cart-widget')) return fail(html);
    if(!/ detect-parent(?=[ >=])/.test(html)) return fail(`detect-parent should be written: ${html}`);
    if(/product-id/.test(html)) return fail(`no product should be written: ${html}`);
    pass('');
  },

  'a button that detects its parent finds a Product widget as well as a Parent Product, and follows it': async ({ pass, fail }) => {
    const widget = await readFile(path.join(root, 'public/components/AddToCartWidget.js'), 'utf8');
    const button = await readFile(path.join(root, 'public/components/AddToCart.js'), 'utf8');
    if(!widget.includes("closest('k-products-parent-widget, k-products-product-widget')")) return fail('the widget does not look for a Product widget');
    if(!button.includes("'k-products-product-widget'].includes(host.localName)")) return fail('the button does not read the choices of a Product widget');
    if(!button.includes('k-products-parent-widget, k-products-product-widget')) return fail('a button placed straight in a Product widget is not attached');
    pass('');
  },

  'the cart button and add to cart are in the Products group, as the product widgets are, and the rest are in Cart and checkout': async ({ pass, fail }) => {
    for(const definition of config.page_widgets){
      const products = ['cart-button', 'add-to-cart'].includes(definition.key);
      const wanted = products ? ['products', 'Products'] : ['checkout', 'Cart and checkout'];
      if(definition.category !== wanted[0] || definition.category_title !== wanted[1]) return fail(`${definition.key} is not in the ${wanted[1]} group`);
    }
    pass('');
  },

  'the cart and the checkout are widgets with the tags of their elements, so their pages open in the builder, with a place for their pieces': async ({ pass, fail }) => {
    for(const [key, tag, slot] of [['cart', 'k-commerce-cart', 'default'], ['checkout', 'k-commerce-checkout', 'default']]){
      const definition = config.page_widgets.find(widget => widget.key === key);
      if(definition?.tag !== tag) return fail(`${key} should be written as <${tag}>`);
      if(definition.slots?.[0]?.name !== slot) return fail(`${key}'s first place, where the builder's Add goes, should be its pieces`);
    }
    if(!config.page_widgets.find(widget => widget.key === 'cart').slots.some(entry => entry.name === 'before') || !config.page_widgets.find(widget => widget.key === 'cart').slots.some(entry => entry.name === 'after')) return fail('the cart keeps its before and after places');
    pass('');
  },

  'every piece is a widget whose element its component file defines, and finds its parent on the page and in the builder': async ({ pass, fail }) => {
    const pieces = config.page_widgets.filter(widget => !['cart', 'checkout', 'cart-button', 'add-to-cart', 'orders'].includes(widget.key));
    if(pieces.length !== 11) return fail(`expected 11 pieces, found ${pieces.length}`);
    for(const piece of pieces){
      const source = await readFile(path.join(root, `public/${piece.page_component.replace(/^\/commerce\//, '')}`), 'utf8');
      if(!source.includes(`customElements.define('${piece.tag}'`)) return fail(`${piece.tag} is not defined by ${piece.page_component}`);
      const parent = piece.key.startsWith('cart') ? "closest('k-commerce-cart, k-commerce-cart-editor')" : "closest('k-commerce-checkout, k-commerce-checkout-editor')";
      if(!source.includes(parent)) return fail(`${piece.key} does not look for ${parent}`);
    }
    pass('');
  },

  'pieces placed in a cart or a checkout are written inside it, with no slot attribute, and the whole ones are written as their own elements': async ({ pass, fail }) => {
    const cart = renderPage([createNode('kempo-commerce-cart', {}, { default: [createNode('kempo-commerce-cart-lines', {}), createNode('kempo-commerce-cart-totals', {})] })], registry);
    if(!cart.startsWith('<k-commerce-cart') || !/<k-commerce-cart-lines-widget(?![^>]*slot=)/.test(cart) || !/<k-commerce-cart-totals-widget(?![^>]*slot=)/.test(cart)) return fail(cart);
    const checkout = renderPage([createNode('kempo-commerce-checkout', {}, { default: [createNode('kempo-commerce-checkout-contact', {}), createNode('kempo-commerce-checkout-place', {})] })], registry);
    if(!checkout.startsWith('<k-commerce-checkout') || !/<k-commerce-checkout-contact-widget(?![^>]*slot=)/.test(checkout) || !/<k-commerce-checkout-place-widget(?![^>]*slot=)/.test(checkout)) return fail(checkout);
    const orders = renderPage([createNode('kempo-commerce-orders', {})], registry);
    if(!orders.startsWith('<k-commerce-orders')) return fail(orders);
    pass('');
  },

  'the cart and the checkout draw only their pieces when they have some, and keep their own layout when they have none': async ({ pass, fail }) => {
    const cart = await readFile(path.join(root, 'public/components/Cart.js'), 'utf8');
    const checkout = await readFile(path.join(root, 'public/components/Checkout.js'), 'utf8');
    if(!cart.includes('get layout()') || !cart.includes('if(this.layout) return html`<slot name="before"></slot><slot></slot><slot name="after"></slot>`;')) return fail('the cart does not draw only its pieces');
    if(!checkout.includes('get layout()') || !checkout.includes('return this.layout ? nothing : this.renderForm();')) return fail('the checkout does not draw only its pieces');
    if(!cart.includes("new CustomEvent('cart-change')") || !checkout.includes("new CustomEvent('checkout-change')")) return fail('the pieces are not told when to draw again');
    pass('');
  },

  'the builder copies of the cart, the checkout and the order history use samples and never ask the server for an order': async ({ pass, fail }) => {
    for(const [file, parent] of [['CartEditor', 'extends Cart'], ['CheckoutEditor', 'extends Checkout'], ['OrdersEditor', 'extends Orders']]){
      const source = await readFile(path.join(root, `admin/components/sitebuilder/${file}.js`), 'utf8');
      if(!source.includes(parent) || !/sample/i.test(source)) return fail(`${file} does not draw a sample`);
      if(/placeOrder|startCheckout|validateCheckout|getCart\(|getMyOrders/.test(source.replace(/\/\*[\s\S]*?\*\//g, ''))) return fail(`${file} asks the server for an order`);
    }
    const checkoutEditor = await readFile(path.join(root, 'admin/components/sitebuilder/CheckoutEditor.js'), 'utf8');
    if(!checkoutEditor.includes('place = async') || !checkoutEditor.includes('reprice = async') || checkoutEditor.includes('k-pay-form')) return fail('the checkout editor can send an order or load the card fields');
    pass('');
  }
};
