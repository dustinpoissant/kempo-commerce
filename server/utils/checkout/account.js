import { createUser, requestPasswordReset, getSetting } from 'kempo/server/sdk.js';

/*
  The optional account step of a checkout. Someone who is not signed in can ask for an account (or
  must, when the cart has credits for sale in it, because a guest cannot receive credits). It is made
  with kempo's own `createUser` and a password nobody knows, and the email they get is a link to set
  their own: kempo's password reset, worded for this.

  The account's email is not verified by this. It is the address they typed at checkout, which is
  exactly why guest orders are only attached to an account whose email is verified (see link.js).
*/
export const createCheckoutAccount = async ({ name, email }) => {
  const [settingError, allowed] = await getSetting('system', 'allow_registration', true);
  if(!settingError && allowed === false) return [{ code: 409, msg: 'New accounts cannot be made on this site right now' }, null];

  const [error, created] = await createUser({ name, email });
  if(error){
    return error.code === 409
      ? [{ code: 409, msg: 'An account with that email already exists. Please sign in to continue.', existing: true }, null]
      : [error, null];
  }

  const [resetError] = await requestPasswordReset({ email, subject: 'Set your password', template: 'kempo-commerce/set-password' });
  if(resetError) console.error(`[kempo-commerce] Could not send the set-password email to a new account: ${resetError.msg}`);
  return [null, { userId: created.user.id, emailSent: !resetError }];
};
