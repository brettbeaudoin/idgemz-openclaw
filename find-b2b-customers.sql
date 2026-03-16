-- IDGemz B2B Customer Finder
-- Identifies potential business customers from Amazon order data

-- Find orders that look like B2B based on multiple criteria
WITH b2b_indicators AS (
  SELECT 
    o.id,
    o.channel_order_id,
    o.order_date,
    o.customer_name,
    o.customer_email,
    o.shipping_address,
    o.order_total,
    
    -- B2B Scoring Criteria
    CASE 
      WHEN o.customer_email LIKE '%.gov' THEN 100
      WHEN o.customer_email LIKE '%.mil' THEN 100  
      WHEN o.customer_email LIKE '%.edu' THEN 80
      WHEN o.customer_email LIKE '%.org' THEN 60
      ELSE 0
    END as email_score,
    
    CASE
      WHEN o.shipping_address::text ~* '(suite|ste|floor|fl|building|bldg)' THEN 40
      WHEN o.shipping_address::text ~* '(department|dept|unit|division)' THEN 60
      ELSE 0
    END as address_score,
    
    -- Check for bulk orders (multiple of same item)
    CASE
      WHEN EXISTS (
        SELECT 1 FROM order_items oi 
        WHERE oi.order_id = o.id 
        AND oi.quantity >= 5
      ) THEN 50
      WHEN EXISTS (
        SELECT 1 FROM order_items oi 
        WHERE oi.order_id = o.id 
        AND oi.quantity >= 3
      ) THEN 30
      ELSE 0
    END as bulk_order_score,
    
    -- Total items in order
    (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) as total_items
    
  FROM orders o
  WHERE o.channel_id = (SELECT id FROM channels WHERE platform = 'amazon')
),
scored_customers AS (
  SELECT 
    *,
    (email_score + address_score + bulk_order_score) as b2b_score,
    CASE 
      WHEN (email_score + address_score + bulk_order_score) >= 100 THEN 'Very Likely B2B'
      WHEN (email_score + address_score + bulk_order_score) >= 60 THEN 'Likely B2B'
      WHEN (email_score + address_score + bulk_order_score) >= 30 THEN 'Possible B2B'
      ELSE 'Likely B2C'
    END as b2b_classification
  FROM b2b_indicators
)

-- Final results: Potential B2B customers
SELECT 
  customer_name,
  customer_email,
  shipping_address->>'name' as ship_to_name,
  shipping_address->>'addressLine1' as address,
  shipping_address->>'city' as city,
  shipping_address->>'stateOrRegion' as state,
  COUNT(DISTINCT id) as order_count,
  SUM(order_total) as lifetime_value,
  MAX(order_date) as last_order,
  STRING_AGG(DISTINCT b2b_classification, ', ') as classification,
  MAX(b2b_score) as max_b2b_score,
  SUM(total_items) as total_units_purchased
FROM scored_customers
WHERE b2b_score > 0
GROUP BY 
  customer_name, 
  customer_email,
  shipping_address->>'name',
  shipping_address->>'addressLine1',
  shipping_address->>'city',
  shipping_address->>'stateOrRegion'
ORDER BY max_b2b_score DESC, lifetime_value DESC
LIMIT 50;

-- Additional query: Find company names from shipping addresses
SELECT DISTINCT
  shipping_address->>'name' as company_name,
  COUNT(*) as order_count,
  SUM(order_total) as total_spent
FROM orders
WHERE channel_id = (SELECT id FROM channels WHERE platform = 'amazon')
  AND shipping_address->>'name' IS NOT NULL
  AND shipping_address->>'name' NOT LIKE '%,%' -- Filter out "Last, First" names
  AND LENGTH(shipping_address->>'name') > 10  -- Likely company names are longer
  AND shipping_address->>'name' ~* '(inc|llc|corp|company|associates|group|services|solutions|systems|technologies)'
GROUP BY shipping_address->>'name'
ORDER BY total_spent DESC;