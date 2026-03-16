-- 2026-02-06
-- Goals:
-- 1) Make orders.order_date timezone-aware (timestamptz) while preserving the correct instant.
--    Existing data was inserted from ISO-8601 Z strings into a timestamp *without* timezone.
--    Postgres parsed it in the session timezone and stored local wall time.
--    Convert by interpreting the stored value as being in the current DB timezone.
-- 2) Add fields needed for robust Amazon syncing + idempotency.

BEGIN;

-- 1) orders.order_date -> timestamptz
ALTER TABLE orders
  ALTER COLUMN order_date TYPE timestamptz
  USING (order_date AT TIME ZONE current_setting('TimeZone'));

-- Keep consistent types for audit timestamps too (optional but recommended)
ALTER TABLE orders
  ALTER COLUMN created_at TYPE timestamptz
  USING (created_at AT TIME ZONE current_setting('TimeZone')),
  ALTER COLUMN updated_at TYPE timestamptz
  USING (updated_at AT TIME ZONE current_setting('TimeZone'));

ALTER TABLE channels
  ALTER COLUMN last_sync_at TYPE timestamptz
  USING (last_sync_at AT TIME ZONE current_setting('TimeZone')),
  ALTER COLUMN created_at TYPE timestamptz
  USING (created_at AT TIME ZONE current_setting('TimeZone')),
  ALTER COLUMN updated_at TYPE timestamptz
  USING (updated_at AT TIME ZONE current_setting('TimeZone'));

ALTER TABLE order_items
  ALTER COLUMN created_at TYPE timestamptz
  USING (created_at AT TIME ZONE current_setting('TimeZone'));

-- 2) general: channel-provided last-updated timestamp
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS external_updated_at timestamptz;

-- 3) amazon-specific detail table (normalized)
CREATE TABLE IF NOT EXISTS amazon_orders (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  amazon_order_id varchar(100) NOT NULL,
  marketplace_id varchar(20),
  last_update_date timestamptz,
  sales_channel text,
  order_channel text,
  ship_service_level text,
  is_prime boolean,
  is_business_order boolean,
  is_premium_order boolean,
  order_type text,
  payment_method_details jsonb,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_orders_amazon_order_id ON amazon_orders(amazon_order_id);

-- 4) order_items: idempotency + extra fields
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS channel_line_item_id text,
  ADD COLUMN IF NOT EXISTS quantity_shipped integer,
  ADD COLUMN IF NOT EXISTS raw jsonb;

-- Ensure we can upsert/dedupe line items by their channel-provided line item id (OrderItemId for Amazon)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_items_order_line
  ON order_items(order_id, channel_line_item_id)
  WHERE channel_line_item_id IS NOT NULL;

COMMIT;
