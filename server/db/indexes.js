import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  The indexes server/db/schema.js declares, created by hand — kempo's installer makes columns and
  primary keys from a Drizzle schema and nothing else. install.js and update.js both run this, and a
  static test checks the list against the schema.

  The unique ones are correctness guarantees rather than speed, and failing to make one throws, which
  fails the install:

  - the order number and the order key, so two orders can never share either;
  - `checkoutKey`, so placing the same checkout twice (two tabs, a retry) returns one order;
  - a tender's `idempotencyKey`, so a step of a checkout is recorded once;
  - a cart's token and a cart line's key, so one visitor has one cart and one line per product.
*/
export const INDEXES = [
  { name: 'kempoCommerceCart_token_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceCart_token_idx" ON "kempoCommerceCart" ("token")` },
  { name: 'kempoCommerceCart_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceCart_user_idx" ON "kempoCommerceCart" ("userId")` },
  { name: 'kempoCommerceCart_status_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceCart_status_idx" ON "kempoCommerceCart" ("status", "updatedAt")` },
  { name: 'kempoCommerceCartLine_key_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceCartLine_key_idx" ON "kempoCommerceCartLine" ("cartId", "lineKey")` },
  { name: 'kempoCommerceOrder_number_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceOrder_number_idx" ON "kempoCommerceOrder" ("number")` },
  { name: 'kempoCommerceOrder_key_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceOrder_key_idx" ON "kempoCommerceOrder" ("orderKey")` },
  { name: 'kempoCommerceOrder_checkout_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceOrder_checkout_idx" ON "kempoCommerceOrder" ("checkoutKey")` },
  { name: 'kempoCommerceOrder_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceOrder_user_idx" ON "kempoCommerceOrder" ("userId", "placedAt")` },
  { name: 'kempoCommerceOrder_email_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceOrder_email_idx" ON "kempoCommerceOrder" ("email")` },
  { name: 'kempoCommerceOrder_status_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceOrder_status_idx" ON "kempoCommerceOrder" ("status", "placedAt")` },
  { name: 'kempoCommerceOrderLine_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceOrderLine_order_idx" ON "kempoCommerceOrderLine" ("orderId")` },
  { name: 'kempoCommerceOrderAdjustment_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceOrderAdjustment_order_idx" ON "kempoCommerceOrderAdjustment" ("orderId")` },
  { name: 'kempoCommerceTender_key_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoCommerceTender_key_idx" ON "kempoCommerceTender" ("idempotencyKey")` },
  { name: 'kempoCommerceTender_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceTender_order_idx" ON "kempoCommerceTender" ("orderId")` },
  { name: 'kempoCommerceEvent_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceEvent_order_idx" ON "kempoCommerceEvent" ("orderId", "id")` },
  { name: 'kempoCommerceNote_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceNote_order_idx" ON "kempoCommerceNote" ("orderId")` },
  { name: 'kempoCommerceRefund_order_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceRefund_order_idx" ON "kempoCommerceRefund" ("orderId")` },
  { name: 'kempoCommerceAttempt_time_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceAttempt_time_idx" ON "kempoCommerceAttempt" ("createdAt")` },
  { name: 'kempoCommerceAttempt_user_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceAttempt_user_idx" ON "kempoCommerceAttempt" ("userId", "createdAt")` },
  { name: 'kempoCommerceAttempt_ip_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoCommerceAttempt_ip_idx" ON "kempoCommerceAttempt" ("ip", "createdAt")` },
];

/*
  Columns added since a table was first created. kempo's installer makes a table from the schema only
  when it is missing, so a site whose tables predate a column never gets it. Each statement is
  `IF NOT EXISTS`, so this is safe on every install and update, and a failure throws.
*/
export const COLUMNS = [
  /* The column was called itemType while product types were item types: keep what it holds. */
  { name: 'productType rename', sql: sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kempoCommerceOrderLine' AND column_name = 'itemType') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kempoCommerceOrderLine' AND column_name = 'productType') THEN ALTER TABLE "kempoCommerceOrderLine" RENAME COLUMN "itemType" TO "productType"; END IF; END $$` },
  { name: 'productType', sql: sql`ALTER TABLE "kempoCommerceOrderLine" ADD COLUMN IF NOT EXISTS "productType" text NOT NULL DEFAULT 'generic'` },
];

export const ensureColumns = async () => {
  for(const column of COLUMNS){
    try {
      await db.execute(column.sql);
    } catch(error) {
      throw new Error(`[kempo-commerce] Could not add the column ${column.name}: ${error.message}`);
    }
  }
};

export const createIndexes = async () => {
  for(const index of INDEXES){
    try {
      await db.execute(index.sql);
    } catch(error) {
      if(index.required) throw new Error(`[kempo-commerce] Could not create ${index.name}, which checkout cannot work safely without: ${error.message}`);
      console.warn(`[kempo-commerce] Could not create the index ${index.name}: ${error.message}`);
    }
  }
};
