import crypto from 'crypto';

/* Sorted keys all the way down, so two objects with the same content always give the same text. */
export const canonical = value => {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};

/*
  A cart line is its product, the option choices made and whatever data an extension attached. The
  same key is the same line (adding it again raises the quantity); a different gift message or
  engraving is a different line.
*/
export default ({ productId, selections = {}, data = {} }) => crypto
  .createHash('sha1')
  .update(`${productId}|${canonical(selections)}|${canonical(data)}`)
  .digest('hex');
