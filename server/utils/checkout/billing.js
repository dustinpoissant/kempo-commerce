import { addressOf, addressRequirements, taxEnabled } from './tax.js';
import { isCountry, subdivisionsOf, matchSubdivision } from './regions.js';

/*
  Checks the contact and billing details a checkout form sends. Returns [error, billing] with every
  field trimmed and bounded. The street address is always required (an order cannot be sent, or a card checked, against
  only a postal code). The rest of the address is optional unless tax is on: kempo-tax needs a country to say what to
  charge, and asking for it only then keeps the form short for a store that does not need it.
*/

const FIELDS = { name: 200, phone: 50, line1: 200, line2: 200, city: 100, state: 100, postalCode: 30 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const cleanBilling = async ({ billing, accountEmail = null }) => {
  if(!billing || typeof billing !== 'object' || Array.isArray(billing)) return [{ code: 400, msg: 'Billing details are required' }, null];

  const clean = {};
  for(const [field, max] of Object.entries(FIELDS)){
    const value = billing[field];
    if(value === undefined || value === null || value === '') continue;
    if(typeof value !== 'string') return [{ code: 400, msg: `${field} must be text` }, null];
    if(value.includes('\u0000')) return [{ code: 400, msg: `${field} cannot contain null characters` }, null];
    const trimmed = value.trim();
    if(trimmed.length > max) return [{ code: 400, msg: `${field} must be ${max} characters or fewer` }, null];
    if(trimmed) clean[field] = trimmed;
  }

  if(!clean.name) return [{ code: 400, msg: 'Please give your name' }, null];
  if(!clean.line1) return [{ code: 400, msg: 'Please give your street address' }, null];

  const email = String(billing.email || accountEmail || '').trim().toLowerCase();
  if(!EMAIL.test(email) || email.length > 254) return [{ code: 400, msg: 'Please give a valid email address' }, null];
  clean.email = email;

  const country = typeof billing.country === 'string' ? billing.country.trim().toUpperCase() : '';
  if(country){
    if(!isCountry(country)) return [{ code: 400, msg: 'Please choose your country from the list' }, null];
    clean.country = country;
    /* A country with states listed takes one of them, stored as its code (VT); one without takes whatever was typed. */
    if(clean.state && subdivisionsOf(country)){
      const state = matchSubdivision(country, clean.state);
      if(!state) return [{ code: 400, msg: 'Please choose your state or region from the list' }, null];
      clean.state = state;
    }
  } else if(await taxEnabled()){
    return [{ code: 400, msg: 'Please choose your country so tax can be calculated' }, null];
  }

  const needs = await addressRequirements(clean);
  if(needs.state && !clean.state) return [{ code: 400, msg: 'Please choose your state or region so tax can be calculated' }, null];
  if(needs.postalCode && !clean.postalCode) return [{ code: 400, msg: 'Please enter your postal code so tax can be calculated' }, null];

  return [null, { ...clean, ...addressOf(clean), email }];
};
