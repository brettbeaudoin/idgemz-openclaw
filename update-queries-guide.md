# How to Update Your Dashboard SQL Queries

## 📝 Edit SQL in Grafana UI (Recommended)

1. Go to http://localhost:3000
2. Click the panel title → **Edit**
3. Edit the SQL in the query editor
4. Click **Run Query** to test
5. Click **Apply** to save

## 🔧 Common SQL Edits You Might Want:

### Change Time Ranges
```sql
-- Change from 7 days to 30 days
WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'

-- This month only
WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE)

-- Custom date range
WHERE order_date BETWEEN '2026-01-01' AND '2026-01-31'
```

### Filter by Channel
```sql
-- Add to any query to filter by channel
JOIN channels c ON o.channel_id = c.id
WHERE c.name = 'Amazon US'

-- Or multiple channels
WHERE c.name IN ('Amazon US', 'Shopify')
```

### Add More Metrics
```sql
-- Add average order value to stats
SELECT 
  COUNT(*) as orders,
  SUM(order_total) as revenue,
  AVG(order_total) as avg_order_value
FROM orders
```

### Group by Different Time Periods
```sql
-- By week instead of day
SELECT 
  DATE_TRUNC('week', order_date) as time,
  SUM(order_total) as revenue
FROM orders
GROUP BY 1

-- By hour of day (see patterns)
SELECT 
  EXTRACT(HOUR FROM order_date) as hour,
  COUNT(*) as orders
FROM orders
GROUP BY 1
ORDER BY 1
```

## 💡 Useful Queries to Add:

### Inventory Alerts Panel
```sql
SELECT 
  p.internal_sku as "SKU",
  p.title as "Product",
  COALESCE(i.quantity_available, 0) as "Stock",
  COALESCE(
    ROUND(i.quantity_available::numeric / NULLIF(
      (SELECT AVG(daily_sold) 
       FROM (
         SELECT SUM(oi.quantity) as daily_sold
         FROM order_items oi
         JOIN orders o ON oi.order_id = o.id
         WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days'
         GROUP BY DATE(o.order_date)
       ) daily_sales
      ), 0)
    ), 0
  ) as "Days Supply"
FROM products p
LEFT JOIN inventory i ON p.id = i.product_id
WHERE i.quantity_available < 20
ORDER BY "Days Supply" ASC;
```

### B2B Customer Identification
```sql
SELECT 
  shipping_address->>'name' as "Company",
  COUNT(*) as "Orders",
  SUM(order_total) as "Revenue",
  MAX(order_date) as "Last Order"
FROM orders
WHERE 
  shipping_address->>'name' ~* '(inc|llc|corp|company)'
  OR customer_email LIKE '%.gov'
  OR customer_email LIKE '%.edu'
GROUP BY 1
HAVING COUNT(*) > 2
ORDER BY 3 DESC;
```

## 🚀 Quick Actions:

1. **View/Edit queries**: Open `idgemz-dashboard-queries.sql`
2. **Test queries**: Use `psql -d idgemz` and paste queries
3. **Update in Grafana**: Edit panel → paste new query → Apply

Your main dashboard queries are in:
`/Users/bbeaudoin/clawd/idgemz-sync/idgemz-dashboard-queries.sql`