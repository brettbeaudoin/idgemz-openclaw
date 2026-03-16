-- 2026-02-09
-- Goals:
-- - Create a customer identity graph for cross-channel correlation
-- - Store raw contact info (email/phone) when available
-- - Link orders -> customers via orders.customer_id

BEGIN;

-- Enable uuid generation if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Canonical customer record
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Simple updated_at trigger (reuse existing function if present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_customers_updated_at'
  ) THEN
    CREATE TRIGGER update_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Identities (raw). Keep kind flexible.
-- kind examples: 'email', 'phone'
CREATE TABLE IF NOT EXISTS customer_identities (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Avoid duplicates (case-insensitive for emails); enforce uniqueness by (kind, lower(value))
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_identities_kind_value_ci
  ON customer_identities (kind, lower(value));

CREATE INDEX IF NOT EXISTS idx_customer_identities_customer
  ON customer_identities (customer_id);

-- Addresses (raw + fingerprint for matching)
CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address jsonb NOT NULL,
  fingerprint text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_addresses_fingerprint
  ON customer_addresses (fingerprint);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON customer_addresses (customer_id);

-- Link orders -> customers
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON orders(customer_id);

COMMIT;
