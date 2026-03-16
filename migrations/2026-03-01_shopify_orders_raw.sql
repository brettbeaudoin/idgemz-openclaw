-- Shopify raw/diagnostic table for keeping a copy of the source payload

CREATE TABLE IF NOT EXISTS shopify_orders (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  shopify_order_id bigint NOT NULL,
  name text,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_orders_shopify_order_id_idx
  ON shopify_orders (shopify_order_id);
