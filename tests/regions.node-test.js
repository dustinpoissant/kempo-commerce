import path from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import { seedDatabase } from './helpers/db.js';

/*
  The country and state pickers: the data behind them, how the page names and orders it, and the
  server refusing what is not on the lists.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => import(pathToFileURL(path.join(root, file)).href);

const { isCountry, subdivisionsOf, matchSubdivision, fitToLists, getRegions } = await load('server/utils/checkout/regions.js');
const { countryOptions, subdivisionOptions } = await load('public/utils/regions.js');
const { cleanBilling } = await load('server/utils/checkout/billing.js');

const BILLING = { name: 'Grace Hopper', email: 'grace@example.test', line1: '1 Test St' };

export const beforeAll = async () => {
  await seedDatabase();
};

export default {
  'the data names real countries, and only real ones': async ({ pass, fail }) => {
    const { countries } = JSON.parse(await readFile(path.join(root, 'server', 'data', 'regions.json'), 'utf8'));
    if(countries.length < 240 || countries.length > 260) return fail(`${countries.length} countries`);
    if(new Set(countries).size !== countries.length || countries.some(code => !/^[A-Z]{2}$/.test(code))) return fail('codes are not unique two-letter codes');
    for(const code of ['US', 'CA', 'GB', 'DE', 'JP', 'AU', 'AW', 'AX', 'XK']) if(!countries.includes(code)) return fail(`${code} is missing`);
    for(const code of ['UK', 'EU', 'UN', 'SU', 'ZZ', 'AN']) if(countries.includes(code)) return fail(`${code} is not a country`);
    pass('');
  },

  'the data gives each country its own states, by code and name': async ({ pass, fail }) => {
    const { subdivisions } = getRegions();
    if(Object.keys(subdivisionsOf('US')).length !== 51 || subdivisionsOf('US').VT !== 'Vermont' || subdivisionsOf('US').DC !== 'District of Columbia') return fail('US');
    if(Object.keys(subdivisionsOf('CA')).length !== 13 || subdivisionsOf('CA').ON !== 'Ontario') return fail('CA');
    if(subdivisionsOf('JP')['19'] !== 'Yamanashi Prefecture') return fail('a numeric code, JP-19');
    if(subdivisionsOf('AW') !== null) return fail('a country with no states listed must say so');
    for(const [country, list] of Object.entries(subdivisions)){
      if(!isCountry(country)) return fail(`${country} has states but is not a country`);
      for(const [code, name] of Object.entries(list)) if(!code || !name) return fail(`${country} has a blank entry`);
    }
    pass('');
  },

  'a state is found by its code or its name, in any case': async ({ pass, fail }) => {
    for(const input of ['VT', 'vt', ' Vt ', 'Vermont', 'VERMONT']) if(matchSubdivision('US', input) !== 'VT') return fail(`${JSON.stringify(input)} did not find VT`);
    if(matchSubdivision('US', 'Narnia') !== null || matchSubdivision('US', '') !== null || matchSubdivision('AW', 'anything') !== null) return fail('something that is not a state was found');
    pass('');
  },

  'an old saved address is fitted to the lists, dropping what no longer fits': async ({ pass, fail }) => {
    const a = fitToLists({ country: 'US', state: 'Vermont', city: 'Burlington' });
    if(a.state !== 'VT' || a.city !== 'Burlington') return fail(`typed name: ${JSON.stringify(a)}`);
    if('state' in fitToLists({ country: 'US', state: 'Narnia' })) return fail('a state that is not one was kept');
    if('country' in fitToLists({ country: 'ZZ' })) return fail('a country that is not listed was kept');
    if(fitToLists({ country: 'AW', state: 'Oranjestad' }).state !== 'Oranjestad') return fail('a country with no list must keep what was typed');
    if('state' in fitToLists({ state: 'VT' })) return fail('a state with no country was kept');
    pass('');
  },

  'the page names countries in its own language and puts them in order': async ({ pass, fail }) => {
    const regions = getRegions();
    const english = countryOptions(regions, 'en');
    if(english.length !== regions.countries.length) return fail('not every country is offered');
    if(english.find(option => option.code === 'US')?.name !== 'United States' || english.find(option => option.code === 'DE')?.name !== 'Germany') return fail('names');
    if(english.some((option, index) => index && english[index - 1].name.localeCompare(option.name, 'en') > 0)) return fail('not in order by name');
    if(countryOptions(regions, 'de').find(option => option.code === 'DE')?.name !== 'Deutschland') return fail('another language');
    if(countryOptions(null).length !== 0) return fail('nothing loaded yet should offer nothing');
    pass('');
  },

  'the state picker offers the chosen country\'s states, by name, and nothing for one with none': async ({ pass, fail }) => {
    const regions = getRegions();
    const us = subdivisionOptions(regions, 'US', 'en');
    if(us.length !== 51 || us[0].name !== 'Alabama' || us.find(option => option.code === 'VT')?.name !== 'Vermont') return fail(`US ${us.length} ${us[0]?.name}`);
    if(us.some((option, index) => index && us[index - 1].name.localeCompare(option.name, 'en') > 0)) return fail('not in order by name');
    if(subdivisionOptions(regions, 'AW').length !== 0 || subdivisionOptions(regions, '').length !== 0 || subdivisionOptions(null, 'US').length !== 0) return fail('there should be none');
    pass('');
  },

  'checkout stores a state as its code and refuses what is not on the lists': async ({ pass, fail }) => {
    const ok = async billing => {
      const [error, clean] = await cleanBilling({ billing: { ...BILLING, ...billing } });
      if(error) throw new Error(`${error.code} ${error.msg}`);
      return clean;
    };
    const refused = async billing => (await cleanBilling({ billing: { ...BILLING, ...billing } }))[0];

    const typed = await ok({ country: 'us', state: 'vermont' });
    if(typed.country !== 'US' || typed.state !== 'VT') return fail(`stored ${typed.country}/${typed.state}`);
    if((await ok({ country: 'AW', state: 'Oranjestad' })).state !== 'Oranjestad') return fail('free text for a country with no list');
    if((await ok({ country: 'GB' })).state !== undefined) return fail('a state is optional');

    const notCountry = await refused({ country: 'XX' });
    if(notCountry?.code !== 400 || !/country/i.test(notCountry.msg)) return fail(`unknown country: ${JSON.stringify(notCountry)}`);
    const notState = await refused({ country: 'US', state: 'Narnia' });
    if(notState?.code !== 400 || !/state or region/i.test(notState.msg)) return fail(`unknown state: ${JSON.stringify(notState)}`);
    const wrongCountry = await refused({ country: 'CA', state: 'VT' });
    if(wrongCountry?.code !== 400) return fail('a US state was accepted for Canada');
    pass('');
  },
};
