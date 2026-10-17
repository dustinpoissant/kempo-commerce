import { getRegions } from '../../../server/utils/checkout/regions.js';

/* The countries, and the states or regions of each, for the checkout's pickers. The same for everyone, so it can be kept. */
export default async (request, response) => {
  response.setHeader('Cache-Control', 'public, max-age=86400');
  response.json(getRegions());
};
