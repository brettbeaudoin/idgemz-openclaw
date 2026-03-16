-- Verification: recreate the legacy Amazon SKU -> NerdWidgets sheet header mapping
-- from normalized tables.
--
-- Expectation:
-- - For each amazon_sku identifier, there exists exactly one product.
-- - For that product, there exists exactly one google_sheet_sku identifier.

WITH amazon AS (
  SELECT pi.product_id, pi.id_value AS amazon_sku
  FROM public.product_identifiers pi
  WHERE pi.id_type='amazon_sku' AND pi.active=true
), sheet AS (
  SELECT pi.product_id, pi.id_value AS google_sheet_sku
  FROM public.product_identifiers pi
  WHERE pi.id_type='google_sheet_sku' AND pi.active=true
)
SELECT a.amazon_sku, s.google_sheet_sku
FROM amazon a
JOIN sheet s ON s.product_id=a.product_id
ORDER BY a.amazon_sku;
