import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import { html, css, live } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';

/*
  The shared body of the two quantity pickers, served at /commerce/components/QtyPicker.js. It defines
  no element itself: <k-commerce-cart-qty> and <k-commerce-add-qty> extend it.

  One bordered control: a "-" button, a number input you can type into (so 100 is not 99 clicks) and a
  "+" button. A whole number from `min` (1) up, with no maximum: the server decides what is available.

  Attributes and properties: `value`, `min` (default 1), `label` (the product's name, for screen
  readers) and `disabled`. It fires `change` ({ detail: { value } }) when the number changes, from a
  button or from typing once the field is left or Enter is pressed. Subclasses choose what "-" does at
  the minimum.
*/
export default class QtyPicker extends ShadowComponent {
  static properties = {
    value: { type: Number },
    min: { type: Number },
    label: { type: String },
    disabled: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: inline-block;
    }
    .group {
      display: inline-flex;
      align-items: stretch;
      background: var(--input_bg);
      border: 1px solid var(--c_input_border);
      border-radius: var(--radius);
      overflow: hidden;
      transition: box-shadow var(--animation_ms);
    }
    .group:focus-within {
      box-shadow: var(--focus_shadow);
    }
    .group button {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacer_h);
      border-radius: 0;
    }
    .group button:not(:disabled):hover {
      background: var(--btn_bg);
    }
    .group button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    input {
      width: 3rem !important;
      font: inherit !important;
      padding: var(--spacer_h) 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      background: transparent !important;
      text-align: center;
      appearance: textfield;
      -moz-appearance: textfield;
    }
    input::-webkit-inner-spin-button, input::-webkit-outer-spin-button {
      appearance: none;
      margin: 0;
    }
  `;

  constructor(){
    super();
    this.value = 1;
    this.min = 1;
    this.label = '';
    this.disabled = false;
  }

  /*
    What "-" does at the minimum: a picker that can remove the line says so here, and the rest just
    disable the button.
  */

  get removes(){
    return false;
  }

  get atMin(){
    return this.value <= this.min;
  }

  /*
    Public methods
  */

  setValue = next => {
    if(next === this.value) return;
    this.value = next;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: next }, bubbles: true, composed: true }));
  };

  /* A typed number below the minimum: the base picker holds at the minimum, a removing one asks to remove. */
  belowMin(){
    this.setValue(this.min);
  }

  /*
    Event handlers
  */

  decrease = () => {
    if(!this.atMin) this.setValue(this.value - 1);
    else if(this.removes) this.belowMin();
  };

  increase = () => this.setValue(this.value + 1);

  typed = event => {
    const parsed = Math.floor(Number(event.target.value));
    if(!Number.isFinite(parsed)){
      event.target.value = String(this.value);
      return;
    }
    if(parsed < this.min){
      event.target.value = String(this.value);
      this.belowMin();
      return;
    }
    event.target.value = String(parsed);
    this.setValue(parsed);
  };

  /*
    Rendering
  */

  get minusIcon(){
    return this.removes && this.atMin ? '/commerce/icons/remove_shopping_cart.svg' : '/commerce/icons/remove.svg';
  }

  get minusLabel(){
    if(this.removes && this.atMin) return this.label ? `Remove ${this.label} from your cart` : 'Remove from your cart';
    return this.label ? `One fewer ${this.label}` : 'Decrease quantity';
  }

  render(){
    const removing = this.removes && this.atMin;
    return html`
      <div class="group" role="group" aria-label=${this.label ? `Quantity of ${this.label}` : 'Quantity'}>
        <button type="button" class=${removing ? 'no-btn tc-danger' : 'no-btn'} aria-label=${this.minusLabel} ?disabled=${this.disabled || (this.atMin && !this.removes)} @click=${this.decrease}>
          <k-icon src=${this.minusIcon}></k-icon>
        </button>
        <input type="number" inputmode="numeric" min=${this.min} step="1" aria-label="Quantity" .value=${live(String(this.value))} ?disabled=${this.disabled} @change=${this.typed}>
        <button type="button" class="no-btn" aria-label=${this.label ? `One more ${this.label}` : 'Increase quantity'} ?disabled=${this.disabled} @click=${this.increase}>
          <k-icon name="add"></k-icon>
        </button>
      </div>
    `;
  }
}
