import { getExtension } from 'kempo/server/sdk.js';

/*
  The extensions checkout can use but does not need: kempo-tax, kempo-store-credit and kempo-credits.

  Each is an optional peer. They are looked up at run time with `getExtension` and imported on demand,
  never statically, so a site without one never loads it; and an extension that is installed but
  switched off counts as absent, the same as it does everywhere else in kempo.
*/

export const TAX = 'kempo-tax';
export const STORE_CREDIT = 'kempo-store-credit';
export const CREDITS = 'kempo-credits';

export const isEnabled = async name => {
  const [error, extension] = await getExtension({ name });
  return !error && extension?.enabled === true;
};

const load = async (name, specifier) => {
  if(!(await isEnabled(name))) return null;
  try {
    return await import(specifier);
  } catch {
    return null;
  }
};

export const loadTax = () => load(TAX, 'kempo-tax/sdk');
export const loadStoreCredit = () => load(STORE_CREDIT, 'kempo-store-credit/sdk');
export const loadCredits = () => load(CREDITS, 'kempo-credits/sdk');
