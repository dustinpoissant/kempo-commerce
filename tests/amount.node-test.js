import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/*
  The numbers typed into the payment section: money as a person writes it, counts, and the limits
  they are kept inside. Pure functions, so no server and no database.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { toMinor, fromMinor, toCount, clamp } = await import(pathToFileURL(path.join(root, 'public', 'utils', 'amount.js')).href);

export default {
  'money typed by a person becomes the smallest unit': async ({ pass, fail }) => {
    const cases = [['12.5', 1250], ['12.50', 1250], ['0.99', 99], ['.5', 50], ['5', 500], ['1,000.00', 100000], [' 7.1 ', 710], ['9.999', 1000]];
    for(const [text, expected] of cases){
      const got = toMinor(text, 2);
      if(got !== expected) return fail(`${JSON.stringify(text)} gave ${got}, expected ${expected}`);
    }
    if(toMinor('7', 0) !== 7 || toMinor('7.5', 0) !== 8) return fail('a currency with no decimals');
    pass('');
  },

  'what is not an amount of money is null, never a guess': async ({ pass, fail }) => {
    for(const text of ['', 'abc', '-5', '1.2.3', '12 dollars', '$5', null, undefined]){
      if(toMinor(text, 2) !== null) return fail(`${JSON.stringify(text)} was accepted`);
    }
    pass('');
  },

  'the smallest unit shows as the box wants it': async ({ pass, fail }) => {
    if(fromMinor(1250, 2) !== '12.50' || fromMinor(5, 2) !== '0.05' || fromMinor(0, 2) !== '0.00' || fromMinor(7, 0) !== '7') return fail(`${fromMinor(1250, 2)} ${fromMinor(5, 2)} ${fromMinor(0, 2)} ${fromMinor(7, 0)}`);
    if(fromMinor(null, 2) !== '0.00') return fail('nothing should show as zero');
    for(const minor of [0, 1, 99, 1250, 100000]) if(toMinor(fromMinor(minor, 2), 2) !== minor) return fail(`${minor} did not survive a round trip`);
    pass('');
  },

  'counts are whole numbers only': async ({ pass, fail }) => {
    if(toCount('3') !== 3 || toCount(' 40 ') !== 40 || toCount('0') !== 0) return fail('whole numbers');
    for(const text of ['', '1.5', '-1', 'two', null]) if(toCount(text) !== null) return fail(`${JSON.stringify(text)} was accepted`);
    pass('');
  },

  'an amount is kept between none and the most that can be used': async ({ pass, fail }) => {
    if(clamp(500, 998) !== 500 || clamp(2000, 998) !== 998 || clamp(-5, 998) !== 0 || clamp(0, 0) !== 0) return fail('clamp');
    pass('');
  },
};
