import { setSetting } from 'kempo/server/sdk.js';
import { descriptionOf, typeOf } from '../../../server/utils/config/declared.js';
import { OWNER, SETTING_NAMES, readConfig } from '../../../server/utils/config/settings.js';
import { validateSettings } from '../../../server/utils/config/validate.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Saves settings, each as an ordinary kempo setting with its declared type and description — they also
  appear on kempo's own /admin/settings screen, and passing null for a description there would erase it.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'commerce:settings:manage');
  if(gateError) return refuse(response, gateError);

  const [error, updates] = validateSettings(request.body);
  if(error) return refuse(response, error);

  for(const [name, value] of Object.entries(updates)){
    const [saveError] = await setSetting(OWNER, name, value, typeOf(name), false, descriptionOf(name));
    if(saveError) return refuse(response, saveError);
  }

  const config = await readConfig();
  response.json({ settings: Object.fromEntries(Object.entries(SETTING_NAMES).map(([key, name]) => [name, config[key]])) });
};
