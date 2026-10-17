import { triggerHook } from 'kempo/server/sdk.js';
import { EVENTS } from './events.js';

export { EVENTS };

/*
  Resolves to null to proceed, or an `{ code, msg }` to stop. A handler that throws anything other
  than `{ code, msg }` is logged and reported generically, so internals never reach the caller.
*/
export const guard = async (event, data) => {
  try {
    await triggerHook(event, data, { bail: true });
    return null;
  } catch(error) {
    if(error && Number.isInteger(error.code) && typeof error.msg === 'string'){
      return { code: error.code, msg: error.msg };
    }
    console.error(`[kempo-commerce] "${event}" hook failed:`, error);
    return { code: 500, msg: 'The change was rejected by an extension' };
  }
};

export const notify = async (event, data) => {
  try {
    await triggerHook(event, data);
  } catch(error) {
    console.error(`[kempo-commerce] "${event}" notification failed:`, error);
  }
};
