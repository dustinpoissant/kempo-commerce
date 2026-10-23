import db from 'kempo/server/db/index.js';
import { seedDatabase } from './helpers/db.js';
import { purge } from './helpers/shop.js';
import { takeOrderNumber, formatOrderNumber } from '../server/utils/orders/number.js';

/*
  Order numbers: in order by default, and with `order_number_random` an 8-digit number that is not the next one and does not repeat.
*/

const take = config => db.transaction(tx => takeOrderNumber(tx, config));

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export default {
  'in order, each number is one more than the last, from the first number': async ({ pass, fail }) => {
    const config = { orderNumberStart: 5000, orderNumberRandom: false };
    const first = await take(config);
    const second = await take(config);
    if(second !== first + 1) return fail(`${first} then ${second}`);
    pass('');
  },

  'random numbers have 8 digits, do not run in order and are not the same twice': async ({ pass, fail }) => {
    const config = { orderNumberStart: 1000, orderNumberRandom: true };
    const numbers = [];
    for(let count = 0; count < 200; count++) numbers.push(await take(config));
    if(numbers.some(number => !Number.isInteger(number) || number < 10000000 || number > 99999999)) return fail('a number was not 8 digits');
    if(new Set(numbers).size !== numbers.length) return fail('a number repeated');
    const inOrder = numbers.filter((number, index) => index && number === numbers[index - 1] + 1).length;
    if(inOrder > 3) return fail(`${inOrder} numbers followed the one before`);
    pass('');
  },

  'the prefix and padding are applied to either kind': async ({ pass, fail }) => {
    if(formatOrderNumber(42, { orderNumberPrefix: 'INV-', orderNumberPadding: 6 }) !== 'INV-000042') return fail('padding');
    if(formatOrderNumber(48213907, { orderNumberPrefix: '#', orderNumberPadding: 0 }) !== '#48213907') return fail('a random number');
    pass('');
  },
};
