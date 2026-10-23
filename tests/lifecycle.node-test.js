import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { permission, groupPermission } from 'kempo/server/db/schema.js';
import install from '../install.js';
import update from '../update.js';
import uninstall from '../uninstall.js';
import { INDEXES } from '../server/db/indexes.js';
import { kempoCommerceOrder, kempoCommerceTender } from '../server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { purge, makeProduct, key } from './helpers/shop.js';
import { installFakeCard, restoreCard } from './helpers/fakeCard.js';
import { resolveCart, addToCart } from '../server/utils/carts/cart.js';
import { placeOrder } from '../server/utils/checkout/place.js';

/*
  What kempo runs when this extension is installed, updated and removed.

  The test database already has every index, because drizzle-kit made them from the schema, which is
  exactly why a mistake in install.js would never show. So they are dropped first, and install.js has to
  put them back. The unique ones are then proved to work by trying to break them.
*/

const existingIndexes = async () => new Set((await db.execute(sql`select indexname from pg_indexes where tablename like 'kempoCommerce%'`)).map(row => row.indexname));

const quietly = async run => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await quietly(install);
  await purge();
  restoreCard();
};

export default {
  'install creates every index, and the unique ones hold': async ({ pass, fail }) => {
    for(const { name } of INDEXES) await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
    const before = await existingIndexes();
    if(INDEXES.some(({ name }) => before.has(name))) return fail('the indexes were not dropped, so this proves nothing');

    await quietly(install);
    const after = await existingIndexes();
    const missing = INDEXES.filter(({ name }) => !after.has(name)).map(({ name }) => name);
    if(missing.length) return fail(`install left out: ${missing.join(', ')}`);

    installFakeCard();
    const item = await makeProduct({ price: 100, quantity: 9 });
    const made = async () => {
      const { cart } = (await resolveCart({}))[1];
      await addToCart({ cartId: cart.id, productId: item.id });
      return cart.id;
    };
    const checkoutKey = key().slice(0, 30);
    const [, first] = await placeOrder({ cartId: await made(), checkoutKey, billing: { name: 'A', email: 'a@example.test', line1: '1 Test St' } });
    const dup = await db.insert(kempoCommerceOrder).values({ ...first.order, id: 'ord_dup', number: 999999, orderKey: 'another-key' }).then(() => 'inserted', () => 'refused');
    if(dup !== 'refused') return fail('two orders with one checkout key were accepted');
    const sameNumber = await db.insert(kempoCommerceOrder).values({ ...first.order, id: 'ord_dup2', checkoutKey: null, orderKey: 'yet-another' }).then(() => 'inserted', () => 'refused');
    if(sameNumber !== 'refused') return fail('two orders with one number were accepted');
    const [tender] = await db.select().from(kempoCommerceTender).where(eq(kempoCommerceTender.orderId, first.order.id));
    const sameKey = await db.insert(kempoCommerceTender).values({ ...tender, id: 'tdr_dup' }).then(() => 'inserted', () => 'refused');
    if(sameKey !== 'refused') return fail('one tender key was recorded twice');
    pass(`${INDEXES.length} indexes`);
  },

  'install and update are safe to run again and again': async ({ pass, fail }) => {
    await quietly(install);
    await quietly(install);
    await quietly(update);
    await quietly(update);
    const after = await existingIndexes();
    if(INDEXES.some(({ name }) => !after.has(name))) return fail('an index went missing');
    pass('');
  },

  'checkout is given to every signed-in user on the first install only': async ({ pass, fail }) => {
    await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'commerce:checkout'));
    await db.delete(permission).where(eq(permission.name, 'commerce:checkout'));
    await quietly(install);
    const granted = async () => (await db.select().from(groupPermission).where(eq(groupPermission.permissionName, 'commerce:checkout'))).some(row => row.groupName === 'system:Users');
    if(!await granted()) return fail('a first install should give system:Users commerce:checkout');

    await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'commerce:checkout'));
    await quietly(install);
    if(await granted()) return fail('a reinstall handed back a permission the site had taken away');
    await quietly(update);
    if(await granted()) return fail('update must never grant it');
    pass('');
  },

  'uninstall says what is at stake and deletes nothing': async ({ pass, fail }) => {
    const lines = [];
    const { log, warn } = console;
    console.log = text => lines.push(String(text));
    console.warn = text => lines.push(String(text));
    try {
      await uninstall();
    } finally {
      console.log = log;
      console.warn = warn;
    }
    if(!lines.some(line => /Removing/.test(line))) return fail(`it said: ${lines.join(' | ')}`);
    const [{ total }] = await db.select({ total: sql`count(*)::int` }).from(kempoCommerceOrder);
    if(total < 1) return fail('uninstalling deleted orders');
    pass('');
  },
};
