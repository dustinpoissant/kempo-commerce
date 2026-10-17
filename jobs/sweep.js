import { runSweep } from '../server/utils/sweeps.js';

/* Every minute: expire unpaid orders, finish stalled ones, abandon old carts. See server/utils/sweeps.js. */
export default async () => {
  await runSweep();
};
