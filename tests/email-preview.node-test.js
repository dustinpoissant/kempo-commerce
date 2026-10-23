import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedDatabase } from './helpers/db.js';
import { purge } from './helpers/shop.js';
import previewEmail from '../server/utils/orders/previewEmail.js';

/*
  The preview on the settings Emails tab draws every template with data: a made-up order when there are no orders, and nothing is
  sent. Whatever a template uses must be filled, so a new template with a variable the preview does not know shows up here.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export default {
  'every template previews with a made-up order, with nothing left unfilled': async ({ pass, fail }) => {
    const names = (await readdir(path.join(root, 'emails'))).map(file => file.replace('.page.html', ''));
    for(const name of names){
      const [error, html] = await previewEmail({ template: `kempo-commerce/${name}` });
      if(error) return fail(`${name}: ${error.msg}`);
      if(!html.includes('<html')) return fail(`${name} is not a full page`);
      if(html.includes('{{')) return fail(`${name} has an unfilled {{...}}`);
    }
    pass(`${names.length} templates`);
  },

  'the preview has the sample order, its items and a note': async ({ pass, fail }) => {
    const [, processing] = await previewEmail({ template: 'kempo-commerce/order-processing' });
    if(!processing.includes('Sample product') || !processing.includes('#1001')) return fail('the sample order is missing');
    const [, note] = await previewEmail({ template: 'kempo-commerce/order-note' });
    if(!note.includes('sample note')) return fail('the sample note is missing');
    const [, slip] = await previewEmail({ template: 'kempo-commerce/packing-slip' });
    if(!slip.includes('123 Main Street') || !slip.includes('Sample product')) return fail('the packing slip has no sample address and items');
    pass('');
  },

  'only this extension\'s templates are previewed, and a missing one is a 404': async ({ pass, fail }) => {
    for(const template of ['verify-email', 'other/thing', '', undefined, 'kempo-commerce/']){
      const [error] = await previewEmail({ template });
      if(error?.code !== 400) return fail(`${template} gave ${error?.code}`);
    }
    const [missing] = await previewEmail({ template: 'kempo-commerce/no-such-email' });
    if(missing?.code !== 404) return fail(`a missing template gave ${missing?.code}`);
    pass('');
  },
};
