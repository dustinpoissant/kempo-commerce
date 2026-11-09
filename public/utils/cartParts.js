import { html, nothing, live } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';
import '/commerce/components/CartQty.js';
import { optionsText, itemNames } from '/commerce/utils/format.js';

/*
  The pieces of the cart page, drawn from a host that holds the cart (the Cart element): `host.cart`, `host.money(minor)`,
  `host.config`, `host.busy`, `host.error` and `host.change(line, quantity)`. The whole cart draws all of them in one layout,
  and each piece widget draws one, so both look the same.
*/

/* A table with no header row has no top border or rounded top corners of its own, so its first row draws them. */
const TOP_LEFT = 'border-top: 1px solid var(--c_border); border-top-left-radius: var(--radius);';
const TOP_RIGHT = 'border-top: 1px solid var(--c_border); border-top-right-radius: var(--radius);';

/* The cart shows one row per kind of discount or fee, adding up what it took across the lines, and which lines. */
export const adjustmentRows = adjustments => {
  const rows = new Map();
  for(const adjustment of adjustments){
    const key = `${adjustment.type}|${adjustment.label}`;
    const row = rows.get(key);
    rows.set(key, { ...adjustment, amount: (row?.amount ?? 0) + adjustment.amount, lineIds: [...(row?.lineIds ?? []), ...(adjustment.lineId ? [adjustment.lineId] : [])] });
  }
  return [...rows.values()];
};

/* What went wrong or changed for the cart as a whole: an error, and the notices that belong to no line. */
export const renderNotices = host => {
  const general = host.cart.notices.filter(notice => !notice.lineId);
  return html`
    <div aria-live="polite">
      ${host.error ? html`<p class="tc-danger" role="alert">${host.error}</p>` : nothing}
      ${general.map(notice => html`<p class=${notice.blocking ? 'tc-danger' : 'tc-warning'}>${notice.message}</p>`)}
    </div>
  `;
};

const renderLine = (host, line) => {
  const notices = host.cart.notices.filter(notice => notice.lineId === line.id);
  return html`
    <tr>
      <td>
        <div class="d-f" style="align-items: center; gap: var(--spacer_h);">
          ${line.image ? html`<img src=${line.image.thumbnail ?? line.image.path} alt="" width="64" height="64" loading="lazy">` : nothing}
          <div>
            <a href=${`/products/${encodeURIComponent(line.slug)}/`} class="no-link"><strong>${line.name}</strong></a>
            ${optionsText(line) ? html`<div class="tc-muted small">${optionsText(line)}</div>` : nothing}
            ${notices.map(notice => html`<div class=${notice.blocking ? 'tc-danger small' : 'tc-warning small'}>${notice.message}</div>`)}
          </div>
        </div>
      </td>
      <td>${host.money(line.unitPrice)}</td>
      <td>
        <k-commerce-cart-qty .value=${live(line.quantity)} label=${line.name} ?disabled=${host.busy} @change=${event => host.change(line, event.detail.value)} @qty-remove=${() => host.change(line, 0)}></k-commerce-cart-qty>
      </td>
      <td>${host.money(line.lineTotal)}</td>
    </tr>
  `;
};

/* Every line with its picture, choices, unit price, quantity and total. */
export const renderLines = host => html`
  <div class="table-wrapper mb">
    <table>
      <thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Total</th></tr></thead>
      <tbody>${host.cart.lines.map(line => renderLine(host, line))}</tbody>
    </table>
  </div>
`;

/* The subtotal, a row for each discount or fee, the total, and the note a lowest price leaves. */
export const renderTotals = host => {
  const { cart, config } = host;
  return html`
    <table class="mb">
      <tbody>
        <tr><td style=${`background-color: var(--c_bg__alt); ${TOP_LEFT}`}><strong>Subtotal</strong></td><td class="ta-right" style=${TOP_RIGHT}>${host.money(cart.totals.subtotal)}</td></tr>
        ${adjustmentRows(cart.adjustments).map(adjustment => html`<tr><td style="background-color: var(--c_bg__alt);"><strong>${adjustment.label}</strong>${itemNames(adjustment.lineIds, cart.lines) ? html`<small class="d-b tc-muted">${itemNames(adjustment.lineIds, cart.lines)}</small>` : nothing}</td><td class="ta-right">${host.money(adjustment.amount)}</td></tr>`)}
        <tr><td style="background-color: var(--c_bg__alt);"><strong>Total</strong></td><td class="ta-right"><strong>${host.money(cart.totals.total)}</strong></td></tr>
      </tbody>
    </table>
    ${cart.adjustments.some(adjustment => adjustment.data?.limited) && config?.priceFloorNotice ? html`<p class="tc-muted">${config.priceFloorNotice}</p>` : nothing}
    <p class="tc-muted small">Taxes and credits calculated at checkout.</p>
  `;
};

/* Continue shopping, and the way on to checkout (a button that does nothing while a line cannot be bought). */
export const renderActions = host => html`
  <div class="d-g cols-2" style="gap: var(--spacer_h);">
    <a class="btn ta-center" href="/products/"><k-icon name="arrow" direction="left"></k-icon> Continue shopping</a>
    ${host.cart.blocked
      ? html`<button class="primary" disabled><k-icon src="/commerce/icons/shopping_cart_checkout.svg"></k-icon> Proceed to checkout</button>`
      : html`<a class="btn primary ta-center" href="/checkout/"><k-icon src="/commerce/icons/shopping_cart_checkout.svg"></k-icon> Proceed to checkout</a>`}
  </div>
`;
