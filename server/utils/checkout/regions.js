import { readFileSync } from 'fs';

/*
  The countries a customer can pick, and for each the states, provinces or regions they can pick in it.
  The list is data (server/data/regions.json, made by scripts/build-regions.js): ISO 3166-1 countries,
  and the first level of ISO 3166-2 by the part of its code after the dash (US-VT is VT).

  A customer picks from these on the checkout page; the server checks the same lists, so a form that
  was not filled in by that page (an API client, an old saved address) cannot store something that is not
  a place.
*/

const regions = JSON.parse(readFileSync(new URL('../../data/regions.json', import.meta.url), 'utf8'));

const countries = new Set(regions.countries);

export const getRegions = () => regions;

export const isCountry = code => countries.has(code);

/* The states of a country, as { code: name }, or null when the country has none listed (the field is free text then). */
export const subdivisionsOf = country => regions.subdivisions[country] ?? null;

/*
  The code of the subdivision `input` names, as a code ("vt" or "Vermont" is VT), or null when it is none of them.
  Names are accepted so an address typed before this list existed still lines up.
*/
export const matchSubdivision = (country, input) => {
  const list = subdivisionsOf(country);
  const wanted = String(input ?? '').trim().toLowerCase();
  if(!list || !wanted) return null;
  return Object.keys(list).find(code => code.toLowerCase() === wanted || list[code].toLowerCase() === wanted) ?? null;
};

/*
  An address as the pickers can show it: a country that is not listed is dropped, a state becomes its code
  ("Vermont" is VT), and a state that is not one of its country's states is dropped. A country with no states
  listed keeps whatever was typed. Used for an address saved before the lists existed.
*/
export const fitToLists = address => {
  const fitted = { ...address };
  if(fitted.country && !isCountry(fitted.country)) delete fitted.country;
  if(fitted.state){
    const listed = fitted.country ? subdivisionsOf(fitted.country) : null;
    if(listed){
      const code = matchSubdivision(fitted.country, fitted.state);
      if(code) fitted.state = code;
      else delete fitted.state;
    } else if(!fitted.country){
      delete fitted.state;
    }
  }
  return fitted;
};
