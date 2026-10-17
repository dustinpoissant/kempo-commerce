/*
  Money the way a person types it, and the smallest-unit integers the server works in. No imports, so
  it can be tested on its own. Served at /commerce/utils/amount.js.
*/

/* "12.5" or "1,000.00" as the smallest unit (1250, 100000); null when it is not an amount of money. */
export const toMinor = (text, decimals = 2) => {
  const cleaned = String(text ?? '').trim().replace(/,/g, '');
  if(!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const minor = Math.round(Number(cleaned) * 10 ** decimals);
  return Number.isSafeInteger(minor) ? minor : null;
};

/* 1250 as "12.50", the form a number box wants. */
export const fromMinor = (minor, decimals = 2) => (Number(minor || 0) / 10 ** decimals).toFixed(decimals);

/* A whole count typed in a box ("3"), null when it is not one. */
export const toCount = text => {
  const cleaned = String(text ?? '').trim();
  return /^\d+$/.test(cleaned) && Number.isSafeInteger(Number(cleaned)) ? Number(cleaned) : null;
};

/* Keeps a number between 0 and the most that can be used. */
export const clamp = (value, max) => Math.max(0, Math.min(value, max));
