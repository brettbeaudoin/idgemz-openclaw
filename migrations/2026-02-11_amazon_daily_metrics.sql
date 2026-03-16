-- 2026-02-11
-- Persist Amazon Seller-app-aligned daily metrics (Sales API orderMetrics)

BEGIN;

CREATE TABLE IF NOT EXISTS amazon_daily_metrics (
  date_pt date PRIMARY KEY,
  marketplace_id varchar(20) NOT NULL DEFAULT 'ATVPDKIKX0DER',
  total_sales numeric(12,2) NOT NULL DEFAULT 0,
  currency varchar(10) NOT NULL DEFAULT 'USD',
  order_count integer NOT NULL DEFAULT 0,
  order_item_count integer NOT NULL DEFAULT 0,
  unit_count integer NOT NULL DEFAULT 0,
  interval text,
  source text NOT NULL DEFAULT 'spapi_sales_orderMetrics',
  raw jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_daily_metrics_fetched_at
  ON amazon_daily_metrics (fetched_at DESC);

COMMIT;
