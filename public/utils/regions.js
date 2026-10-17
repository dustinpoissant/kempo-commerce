/*
  The lists behind the country and state pickers, as the page shows them. The data itself comes from the
  server (/commerce/api/regions: { countries, subdivisions }); this only names and orders it. No imports,
  so it can be tested on its own. Served at /commerce/utils/regions.js.
*/

/* [{ code, name }] for every country, named in the visitor's language (English where that has no name for it) and in that language's order. */
export const countryOptions = (regions, language = 'en') => {
  const names = new Intl.DisplayNames([language, 'en'], { type: 'region' });
  return (regions?.countries ?? [])
    .map(code => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, language));
};

/* [{ code, name }] for the states or regions of a country, by name; empty when the country has none listed (the field is free text then). */
export const subdivisionOptions = (regions, country, language = 'en') => Object.entries(regions?.subdivisions?.[country] ?? {})
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, language));
