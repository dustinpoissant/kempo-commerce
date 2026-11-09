import WidgetSettings from '/kempo-ui/components/pagebuilder/WidgetSettings.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/products/components/ProductPicker.js';
import { getProduct } from '/products/sdk.js';
import { VARIANTS, PRESETS } from '/commerce/utils/addToCartOptions.js';
import { parseSelections, selectionsText, validSelections, missingRequired } from '/commerce/utils/selections.js';

/*
  The settings of the Add to cart widget: a product chosen from the catalogue, with its options chosen here so the button
  adds that exact variation, or (with "detect the parent product") the product and options of the Parent Product it is
  placed in. A preset sets the text, icon and style together, and the style is chosen by looking at the buttons.
*/
export default class AddToCartWidgetSettings extends WidgetSettings {
  static properties = {
    ...WidgetSettings.properties,
    product: { state: true },
    failed: { state: true }
  };

  constructor(){
    super();
    this.product = null;
    this.failed = false;
    this.loadedFor = '';
  }

  /*
    Lifecycle callbacks
  */

  willUpdate(){
    const productId = this.node?.attrs?.['product-id'] || '';
    if(productId === this.loadedFor) return;
    this.loadedFor = productId;
    this.product = null;
    this.failed = false;
    if(productId) this.load(productId);
  }

  /*
    Public methods
  */

  load = async productId => {
    const [error, data] = await getProduct(productId);
    if(this.loadedFor !== productId) return;
    this.failed = !!error;
    this.product = error ? null : data.product;
  };

  /*
    Event handlers
  */

  chooseProduct = productId => {
    this.edit(node => {
      node.attrs = { ...node.attrs, 'product-id': productId, selections: '' };
      return true;
    });
  };

  chooseOption = (option, key) => {
    const picked = parseSelections(this.node.attrs?.selections);
    if(key) picked[option.key] = key; else delete picked[option.key];
    this.edit(node => {
      node.attrs = { ...node.attrs, selections: selectionsText(picked) };
      return true;
    });
  };

  applyPreset(preset){
    this.edit(node => {
      node.attrs = { ...node.attrs, label: preset.label, icon: `src:${preset.icon}`, variant: preset.variant };
      return true;
    });
  }

  /*
    Drawing
  */

  renderProductOptions(){
    if(this.failed) return html`<p class="tc-danger mb">The product's options could not be loaded.</p>`;
    if(!this.product) return this.loadedFor ? html`<p class="tc-muted mb">Loading the product's options</p>` : '';
    const options = this.product.options ?? [];
    if(!options.length) return '';
    const picked = validSelections(this.product, parseSelections(this.node.attrs?.selections));
    const missing = missingRequired(this.product, parseSelections(this.node.attrs?.selections));
    return html`
      <div class="mb">
        <span class="d-b mbq">Options<small class="d-b tc-muted">The choices this button adds. Choose one for each required option, so it always adds the same variation.</small></span>
        ${options.map(option => html`
          <div class="mbq">
            <label class="d-b mbq" for="sb-option-${option.key}">${option.label}${option.required ? '' : ' (optional)'}</label>
            <select id="sb-option-${option.key}" class="full" @change=${event => this.chooseOption(option, event.target.value)}>
              <option value="" ?selected=${!picked[option.key]}>${option.required ? 'Choose…' : 'None'}</option>
              ${option.choices.map(choice => html`<option value=${choice.key} ?disabled=${!choice.available} ?selected=${picked[option.key] === choice.key}>${choice.label}${choice.available ? '' : ' - sold out'}</option>`)}
            </select>
          </div>`)}
        ${missing.length ? html`<p class="tc-danger mbq">Choose ${missing.join(', ')} to finish.</p>` : html`<p class="tc-muted mbq">The button adds the variation chosen above.</p>`}
      </div>
    `;
  }

  render(){
    const productId = this.node.attrs?.['product-id'] || '';
    const detect = this.node.attrs?.['detect-parent'] === true;
    const current = this.node.attrs?.variant || 'primary';
    return html`
      ${detect ? html`<p class="tc-muted mb">This button adds the product of the Parent Product or Product widget it is placed in, with the options chosen there. It has no product of its own.</p>` : html`
        <div class="mb">
          <span class="d-b mbq">Product<small class="d-b tc-muted">The product this button adds to the cart. Products are made under Products in the admin.</small></span>
          <k-products-product-picker .value=${productId} @change=${event => this.chooseProduct(event.detail.value)}></k-products-product-picker>
        </div>
        ${this.renderProductOptions()}
      `}
      <div class="mb">
        <span class="d-b mbq">Presets<small class="d-b tc-muted">Sets the text, icon and style together. Change any of them after.</small></span>
        <div class="d-f">
          ${PRESETS.map(preset => html`<button class="${preset.variant} mrq mbq" @click=${() => this.applyPreset(preset)}><k-icon src=${preset.icon}></k-icon> ${preset.label}</button>`)}
        </div>
      </div>
      ${this.renderFields(['product-id', 'variant', 'selections'])}
      <div class="mb">
        <span class="d-b mbq">Style</span>
        <div class="d-f">
          ${VARIANTS.map(style => html`<button class="${style.value === 'default' ? '' : style.value} mrq mbq" title="${style.label}" aria-pressed="${current === style.value}" @click=${() => this.set('variant', style.value, false)}>${current === style.value ? html`<k-icon name="check"></k-icon>` : ''} ${style.label}</button>`)}
        </div>
      </div>
    `;
  }
}

customElements.define('k-commerce-add-to-cart-settings', AddToCartWidgetSettings);
