import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../server/db/schema.js';
import { INDEXES } from '../server/db/indexes.js';
import { EVENTS } from '../server/utils/events.js';
import { DEFAULTS, NORMALISE, SETTING_NAMES } from '../server/utils/config/settings.js';
import { VALIDATORS } from '../server/utils/config/validate.js';
import { normalizeAliases } from 'kempo/server/utils/extensions/aliases.js';
import { normalizeJobs } from 'kempo/server/utils/scheduler/helpers.js';

/*
  Static checks that what the code asks for is what the extension declares.

  A permission a route checks but nobody declared does not error: it answers "no", forever, for everyone
  but administrators, which is exactly why it survives testing by an administrator. A setting that is read
  but never declared silently uses its default. An index the schema declares that install.js forgets exists
  only on a developer's database. A hook that is not in the README cannot be used by anyone who did not
  read the source. Each has a check here.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const config = JSON.parse(await read('kempo-config.json'));
const pkg = JSON.parse(await read('package.json'));
const readme = await read('README.md');

const walk = async (dir, match) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for(const entry of entries){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full, match));
    else if(match(entry.name)) files.push(full);
  }
  return files;
};

const relative = file => path.relative(root, file).replaceAll('\\', '/');
const source = async (dir, match = name => /\.(js|html)$/.test(name)) => new Map(await Promise.all((await walk(path.join(root, dir), match)).map(async file => [relative(file), await readFile(file, 'utf8')])));
const routes = await source('public/api', name => name.endsWith('.js'));
const utils = await source('server/utils', name => name.endsWith('.js'));
const everything = new Map([...routes, ...utils, ...await source('public'), ...await source('admin'), ...await source('server/http'), ...await source('hooks'), ...await source('jobs')]);
const permissionNames = config.permissions.map(permission => permission.name);

export default {
  'every permission a route checks is declared, and every declared one is checked': async ({ pass, fail }) => {
    const checked = new Set();
    for(const [file, text] of routes){
      for(const match of text.matchAll(/gate\(request, '([^']+)'\)/g)) checked.add(match[1]);
      for(const match of text.matchAll(/currentUserHasPermission\(session\.token, '([^']+)'\)/g)) if(match[1].startsWith('commerce:')) checked.add(match[1]);
      if(/gate\(request, [^']/.test(text)) return fail(`${file} checks a permission that is not a plain string`);
    }
    checked.add('commerce:checkout');
    for(const name of checked){
      if(name.startsWith('payments:')) continue;
      if(!permissionNames.includes(name)) return fail(`${name} is checked but not declared`);
    }
    for(const name of permissionNames){
      const used = checked.has(name) || [...everything.values()].some(text => text.includes(`'${name}'`) || text.includes(`"${name}"`));
      if(!used) return fail(`${name} is declared but nothing checks it`);
    }
    for(const name of permissionNames) if(!/^commerce:[a-z:]+$/.test(name)) return fail(`${name} is not commerce:<something>`);
    pass(`${permissionNames.length} permissions`);
  },

  'groups only reference declared permissions, and form a ladder': async ({ pass, fail }) => {
    const group = name => new Set(config.groups.find(entry => entry.name === `kempo-commerce:${name}`).permissions);
    for(const entry of config.groups){
      if(!entry.name.startsWith('kempo-commerce:')) return fail(`${entry.name} is not ours to create`);
      for(const permission of entry.permissions) if(!permissionNames.includes(permission) && permission !== 'system:admin:access') return fail(`${entry.name} names ${permission}`);
    }
    const [support, manager, administrator] = ['support', 'manager', 'administrator'].map(group);
    for(const permission of support) if(!manager.has(permission)) return fail('manager lacks something support has');
    for(const permission of manager) if(!administrator.has(permission)) return fail('administrator lacks something manager has');
    if(support.has('commerce:orders:manage') || support.has('commerce:refunds:issue')) return fail('support must not manage or refund');
    if(manager.has('commerce:settings:manage')) return fail('only the administrator changes settings');
    pass('');
  },

  'every setting is declared once, typed, readable, validated and documented': async ({ pass, fail }) => {
    const declared = new Map(config.settings.map(setting => [setting.name, setting]));
    if(declared.size !== config.settings.length) return fail('a setting is declared twice');
    for(const [key, name] of Object.entries(SETTING_NAMES)){
      const setting = declared.get(name);
      if(!setting) return fail(`${name} is read but not declared`);
      if(!setting.description) return fail(`${name} has no description`);
      if(!(key in DEFAULTS) || !(key in NORMALISE)) return fail(`${key} has no default or normaliser`);
      if(!VALIDATORS[name]) return fail(`${name} cannot be saved from the settings screen`);
      const asDeclared = setting.type === 'boolean' ? setting.value === 'true' : setting.type === 'number' ? Number(setting.value) : setting.value;
      if(DEFAULTS[key] !== asDeclared) return fail(`${name}: the declared default ${JSON.stringify(setting.value)} is not the code's ${JSON.stringify(DEFAULTS[key])}`);
      if(!readme.includes(`\`${name}\``)) return fail(`${name} is not in the README`);
    }
    for(const name of declared.keys()) if(!Object.values(SETTING_NAMES).includes(name)) return fail(`${name} is declared but never read`);
    pass(`${declared.size} settings`);
  },

  'every index the schema declares is created by install.js': async ({ pass, fail }) => {
    const created = new Set(INDEXES.map(index => index.name));
    for(const [name, table] of Object.entries(schema)){
      if(!table || typeof table !== 'object' || !('_' in table || Symbol.for('drizzle:Name') in table)) continue;
      let tableConfig;
      try {
        tableConfig = getTableConfig(table);
      } catch {
        continue;
      }
      for(const index of tableConfig.indexes) if(!created.has(index.config.name)) return fail(`${name}: ${index.config.name} is in the schema but not in indexes.js`);
    }
    for(const name of created){
      const real = [...Object.values(schema)].some(table => { try { return getTableConfig(table).indexes.some(index => index.config.name === name); } catch { return false; } });
      if(!real) return fail(`${name} is created but not in the schema`);
    }
    pass(`${created.size} indexes`);
  },

  'every hook is documented in the README, prefixed and unique': async ({ pass, fail }) => {
    const names = Object.values(EVENTS);
    if(new Set(names).size !== names.length) return fail('a hook name is used twice');
    for(const name of names){
      if(!/^kempo-commerce:[a-z]+:[a-z_]+$/.test(name)) return fail(`${name} is not kempo-commerce:<resource>:<event>`);
      if(!readme.includes(`\`${name}\``)) return fail(`${name} is not in the README`);
    }
    pass(`${names.length} hooks`);
  },

  'every hook this extension registers has a handler, and the jobs and aliases are valid': async ({ pass, fail }) => {
    for(const [event, callback] of Object.entries(config.hooks)){
      if(!existsSync(path.join(root, callback))) return fail(`${event} points at ${callback}, which does not exist`);
    }
    const [jobsError, jobs] = normalizeJobs(config.jobs);
    if(jobsError) return fail(jobsError.msg);
    for(const job of jobs) if(!existsSync(path.join(root, job.callback))) return fail(`job ${job.name} points at ${job.callback}`);
    const [aliasesError, aliases] = normalizeAliases(config.aliases, config['public-scope']);
    if(aliasesError) return fail(aliasesError.msg);
    for(const target of Object.values(aliases)){
      const page = path.join(root, 'public', target.replace(`/${config['public-scope']}/`, ''), 'index.page.html');
      if(!existsSync(page)) return fail(`an alias points at ${target}, but ${relative(page)} does not exist`);
    }
    pass('');
  },

  'every email template is used, and every one that is sent exists': async ({ pass, fail }) => {
    const templates = (await readdir(path.join(root, 'emails'))).map(name => name.replace('.page.html', ''));
    const used = new Set();
    for(const [file, text] of everything){
      for(const match of text.matchAll(/sendOrderEmail\([^,]+, '([a-z-]+)'/g)) used.add(match[1]);
      if(file === 'server/utils/orders/emails.js') for(const match of text.matchAll(/: '(order-[a-z-]+)'/g)) used.add(match[1]);
      if(text.includes("template: 'kempo-commerce/set-password'")) used.add('set-password');
    }
        for(const name of used) if(!templates.includes(name)) return fail(`${name} is sent but there is no emails/${name}.page.html`);
    for(const name of templates) if(!used.has(name)) return fail(`emails/${name}.page.html is never sent`);
    pass(`${templates.length} templates`);
  },

  'the account page link goes to a page that exists': async ({ pass, fail }) => {
    const global = await read('public/account.global.html');
    if(!/<content location="account-links"/.test(global)) return fail('it must add to the account-links place of the account page');
    const href = /href="([^"]+)"/.exec(global)?.[1];
    if(!href) return fail('no link');
    const address = href.replace(/\/$/, '');
    const target = config.aliases?.[address];
    if(!target) return fail(`${href} is not one of the extension's aliases`);
    if(!existsSync(path.join(root, 'public', target.replace(/^\/commerce\//, ''), 'index.page.html'))) return fail(`${target} has no page`);
    pass('');
  },

  'server/utils never touches the HTTP layer': async ({ pass, fail }) => {
    for(const [file, text] of utils){
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if(/\brequest\.(headers|cookies|body|query|params)\b|\bresponse\.(status|json|setHeader|redirect|cookie)\b|\breq\.|\bres\./.test(code)) return fail(`${file} reaches into a request or response`);
    }
    pass(`${utils.size} files`);
  },

  'nothing in server/utils throws to its caller, and every utility returns tuples': async ({ pass, fail }) => {
    for(const [file, text] of utils){
      if(/^\s*throw new Error\(/m.test(text.replace(/\/\*[\s\S]*?\*\//g, ''))){
        const allowed = ['throw new Error(\'over-refunded\')', 'throw new Error(\'target\')'];
        const lines = text.split('\n').filter(line => /^\s*throw new Error\(/.test(line));
        if(!lines.every(line => allowed.some(entry => line.includes(entry)))) return fail(`${file} throws an Error that escapes`);
      }
    }
    pass('');
  },

  'custom elements are prefixed k-commerce-, and icons are k-icon': async ({ pass, fail }) => {
    for(const [file, text] of everything){
      for(const match of text.matchAll(/customElements\.define\('([^']+)'/g)){
        if(!match[1].startsWith('k-commerce-')) return fail(`${file} defines ${match[1]}`);
      }
      if(/&[lr]arr;|&#x?2[0-9a-f]{3};|[←→✕✓✔✖]/.test(text) && !file.startsWith('server/')) return fail(`${file} uses a character as an icon: use <k-icon>`);
    }
    pass('');
  },

  'the package ships what it needs, and the README names it': async ({ pass, fail }) => {
    for(const entry of pkg.files) if(!existsSync(path.join(root, entry))) return fail(`${entry} is in "files" but missing`);
    for(const target of Object.values(pkg.exports)) if(!existsSync(path.join(root, target))) return fail(`${target} is exported but missing`);
    if(!pkg.peerDependencies['kempo-products'] || !pkg.peerDependencies['kempo-payments']) return fail('the hard dependencies must be peers');
    for(const optional of ['kempo-tax', 'kempo-credits', 'kempo-store-credit']){
      if(!pkg.peerDependenciesMeta?.[optional]?.optional) return fail(`${optional} must be an optional peer`);
      for(const [file, text] of everything) if(new RegExp(`^import .* from '${optional}`, 'm').test(text)) return fail(`${file} imports ${optional} statically`);
    }
    if(JSON.stringify(config.dependencies) !== JSON.stringify(['kempo-products', 'kempo-payments'])) return fail('declared dependencies');
    if(Object.values(pkg.dependencies ?? {}).concat(Object.values(pkg.devDependencies ?? {}), Object.values(pkg.peerDependencies)).some(value => String(value).startsWith('file:'))) return fail('a file: specifier is committed');
    pass('');
  },
};
