import crypto from 'crypto';
import path from 'path';
import { existsSync, mkdirSync, symlinkSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { like, eq, sql } from 'drizzle-orm';
import { createProduct, updateProduct } from 'kempo-products/sdk';
import { setting, extension, user, permission, group, groupPermission, userGroup } from 'kempo/server/db/schema.js';
import { createSession } from 'kempo/server/sdk.js';
import {
  kempoCommerceCart, kempoCommerceCartLine, kempoCommerceOrder, kempoCommerceOrderLine, kempoCommerceOrderAdjustment,
  kempoCommerceTender, kempoCommerceEvent, kempoCommerceNote, kempoCommerceRefund, kempoCommerceCounter, kempoCommerceAttempt,
} from '../../server/db/schema.js';
import { db } from './db.js';

/*
  What the suites share: fresh users and products, a reset, and a way to make the optional extensions
  look installed (kempo finds them in the extension table).
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const freshUser = () => `test-user-${crypto.randomBytes(6).toString('hex')}`;

export const key = () => crypto.randomUUID();

const OWN_TABLES = [
  kempoCommerceAttempt, kempoCommerceRefund, kempoCommerceNote, kempoCommerceEvent, kempoCommerceTender,
  kempoCommerceOrderAdjustment, kempoCommerceOrderLine, kempoCommerceOrder, kempoCommerceCartLine, kempoCommerceCart, kempoCommerceCounter,
];

/* The other extensions' tables, emptied by name: they are reached through their SDKs everywhere else. */
const FOREIGN_TABLES = [
  'kempoPaymentRefund', 'kempoPayment', 'kempoCreditEntry', 'kempoCreditLot', 'kempoStoreCreditEntry', 'kempoStoreCreditBalance',
  'kempoProductLedger', 'kempoProductOption', 'kempoProduct',
];

/*
  Email templates are found in the extension's own package under node_modules. In these suites the
  extension is this checkout, so its emails folder is linked there (a junction, which is removed
  without touching what it points at). Nothing else of the package is linked.
*/
const linkEmails = () => {
  const folder = path.join(root, 'node_modules', 'kempo-commerce');
  const link = path.join(folder, 'emails');
  if(existsSync(link)) return;
  mkdirSync(folder, { recursive: true });
  symlinkSync(path.join(root, 'emails'), link, 'junction');
};

/*
  Empties this extension's tables and puts its settings back to their defaults, so no suite runs on what
  another left behind (on a real database the rows outlive the run). Products are the suites' own.
*/
export const purge = async () => {
  linkEmails();
  for(const table of OWN_TABLES) await db.delete(table);
  for(const name of FOREIGN_TABLES) await db.execute(sql.raw(`delete from "${name}"`)).catch(() => {});
  /* The users the suites made (by id prefix), with what hangs off them, so a database that outlives the run starts clean. */
  for(const name of ['session', 'userGroup']) await db.execute(sql.raw(`delete from "${name}" where "userId" like 'test-user-%'`)).catch(() => {});
  await db.delete(user).where(like(user.id, 'test-user-%'));
  await db.delete(setting).where(like(setting.name, 'kempo-commerce:%'));
  await db.delete(setting).where(like(setting.name, 'kempo-credits:%'));
  await db.delete(setting).where(like(setting.name, 'kempo-store-credit:%'));
};

/* A published product with a price, for the suites to sell. */
export const makeProduct = async (overrides = {}) => {
  const [error, product] = await createProduct({ name: `Test product ${crypto.randomBytes(3).toString('hex')}`, price: 1000, status: 'published', ...overrides });
  if(error) throw new Error(`could not make a product: ${error.msg}`);
  return product;
};

export const changeProduct = async (id, changes) => {
  const [error, product] = await updateProduct(id, changes);
  if(error) throw new Error(`could not change the product: ${error.msg}`);
  return product;
};

/*
  Makes an optional extension look installed and enabled, which is all kempo's getExtension needs, and
  returns a function that removes it again.
*/
export const pretendInstalled = async name => {
  const now = new Date();
  await db.insert(extension).values({ name, version: '0.0.0', enabled: true, kempo: {}, installedAt: now, updatedAt: now }).onConflictDoNothing();
  return () => db.delete(extension).where(eq(extension.name, name));
};

export const makeUser = async (id = freshUser(), { email = `${id}@example.test`, name = 'Test User' } = {}) => {
  const now = new Date();
  await db.insert(user).values({ id, email, name, passwordHash: 'x', emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
  return id;
};

/*
  The permissions and groups kempo-config.json declares, created the way kempo's installer creates
  them, so the permission contract can be tested for each audience. Idempotent.
*/
export const declareAccess = async () => {
  const config = JSON.parse(readFileSync(path.join(root, 'kempo-config.json'), 'utf8'));
  const now = new Date();
  for(const { name, description } of config.permissions) await db.insert(permission).values({ name, description, owner: 'kempo-commerce', createdAt: now }).onConflictDoNothing();
  for(const { name, description, permissions } of config.groups){
    await db.insert(group).values({ name, description, owner: 'kempo-commerce', createdAt: now }).onConflictDoNothing();
    for(const permissionName of permissions){
      await db.insert(groupPermission).values({ id: crypto.randomUUID(), groupName: name, permissionName, createdAt: now }).onConflictDoNothing();
    }
  }
  await db.insert(groupPermission).values({ id: crypto.randomUUID(), groupName: 'system:Users', permissionName: 'commerce:checkout', createdAt: now }).onConflictDoNothing();
};

/* A signed-in user, in a group if given, with a real session: returns { userId, cookies }. */
export const signedIn = async (groupName = null, options = {}) => {
  const userId = await makeUser(freshUser(), options);
  await db.insert(userGroup).values({ id: crypto.randomUUID(), userId, groupName: 'system:Users', createdAt: new Date() }).onConflictDoNothing();
  if(groupName) await db.insert(userGroup).values({ id: crypto.randomUUID(), userId, groupName, createdAt: new Date() }).onConflictDoNothing();
  const [error, created] = await createSession(userId);
  if(error) throw new Error(`could not make a session: ${error.msg}`);
  return { userId, cookies: { session_token: created.sessionToken } };
};

/*
  Calls a route handler the way kempo-server does, with the parts of the request and response the
  routes use, and returns what it answered: `{ status, json, headers, cookies }`.
*/
export const call = async (handler, { method = 'GET', params = {}, query = {}, body = null, cookies = {}, headers = {} } = {}) => {
  const out = { status: 200, json: undefined, headers: {}, cookies: {} };
  const response = {
    status(code){ out.status = code; return response; },
    json(data){ out.json = data; return response; },
    set(name, value){ out.headers[name] = value; return response; },
    setHeader(name, value){ out.headers[name] = value; return response; },
    cookie(name, value, options){ out.cookies[name] = { value, options }; return response; },
  };
  await handler({ method, params, query, body, cookies, headers, path: '/' }, response);
  return out;
};

export { db };
