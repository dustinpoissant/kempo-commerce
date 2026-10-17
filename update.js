import { createIndexes, ensureColumns } from './server/db/indexes.js';

/*
  Updating makes sure the indexes and columns exist — every statement is `IF NOT EXISTS`, so this is
  safe from any version to any other. kempo's declarative diff adds new settings, permissions, groups,
  hooks and jobs and never overwrites a value.
*/
export default async () => {
  await ensureColumns();
  await createIndexes();
};
