import crypto from 'crypto';

/*
  Ids carry a prefix saying what they are, so one pasted into a support ticket or a log line can be
  read without looking it up: `cart_`, `cl_`, `ord_`, `ol_`, `adj_`, `tdr_`, `note_`, `ref_`.
*/
export default prefix => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;

/* A secret to hand to a browser: a cart token, an order key. Only its hash is stored for a cart. */
export const secret = () => crypto.randomBytes(24).toString('base64url');

export const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/* Compares two strings in constant time, for order keys. */
export const sameSecret = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
