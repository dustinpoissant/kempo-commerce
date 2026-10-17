import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/*
  Builds server/data/regions.json: the countries a customer can pick, and for each the states, provinces or
  regions they can pick once they have. It is data, not code, so it is made here once and committed.

    npm pack iso3166-2-db                      # MIT; its i18n/en.json is the source
    node scripts/build-regions.js path/to/en.json

  Countries are ISO 3166-1 alpha-2. The source misses some of them (Aruba, the Åland Islands, ...), so
  those are added from the codes the platform itself knows, minus the codes that are retired or are not
  countries (EU, UN, the old USSR). Kosovo (XK) is not an ISO code but is what every checkout uses.

  A subdivision is the first level of ISO 3166-2, by the part of its code after the dash (US-VT is VT, JP-19
  is 19), with its English name. Entries the source gives without a code are left out.
*/

const NOT_COUNTRIES = new Set([
  'AC', 'AN', 'BU', 'CP', 'CQ', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'QO', 'RH', 'SU',
  'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ',
]);

const source = process.argv[2];
if(!source){
  console.error('Usage: node scripts/build-regions.js path/to/iso3166-2-db/i18n/en.json');
  process.exit(2);
}

const data = JSON.parse(await readFile(source, 'utf8'));
const names = new Intl.DisplayNames(['en'], { type: 'region' });

const countries = new Set(Object.keys(data));
for(let first = 65; first <= 90; first++){
  for(let second = 65; second <= 90; second++){
    const code = String.fromCharCode(first, second);
    let known = false;
    try {
      const name = names.of(code);
      known = Boolean(name) && name !== code;
    } catch { /* not a region code at all */ }
    if(known && !NOT_COUNTRIES.has(code)) countries.add(code);
  }
}

const subdivisions = {};
for(const [country, entry] of Object.entries(data)){
  const list = {};
  for(const region of entry.regions ?? []){
    if(region.iso && region.name) list[region.iso] = region.name;
  }
  if(Object.keys(list).length) subdivisions[country] = Object.fromEntries(Object.entries(list).sort(([a], [b]) => a.localeCompare(b)));
}

const output = { countries: [...countries].sort(), subdivisions: Object.fromEntries(Object.entries(subdivisions).sort(([a], [b]) => a.localeCompare(b))) };
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data', 'regions.json');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(output)}\n`);

const total = Object.values(subdivisions).reduce((sum, list) => sum + Object.keys(list).length, 0);
console.log(`${output.countries.length} countries, ${Object.keys(subdivisions).length} with ${total} states or regions, written to ${path.relative(process.cwd(), target)}`);
