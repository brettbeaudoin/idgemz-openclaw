const fetch = require('node-fetch');
const fs = require('fs');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function exportDashboard() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  // Search for the dashboard
  const searchResponse = await fetch(`${GRAFANA_URL}/api/search?query=IDGemz`, { headers });
  const dashboards = await searchResponse.json();
  
  for (const dash of dashboards) {
    console.log(`Found dashboard: ${dash.title} (UID: ${dash.uid})`);
    
    // Get the full dashboard
    const dashResponse = await fetch(`${GRAFANA_URL}/api/dashboards/uid/${dash.uid}`, { headers });
    const fullDash = await dashResponse.json();
    
    // Extract all SQL queries
    const queries = [];
    fullDash.dashboard.panels.forEach(panel => {
      if (panel.targets) {
        panel.targets.forEach(target => {
          if (target.rawSql) {
            queries.push({
              panelTitle: panel.title,
              panelId: panel.id,
              sql: target.rawSql
            });
          }
        });
      }
    });
    
    // Save dashboard JSON
    const filename = `dashboard-${dash.uid}.json`;
    fs.writeFileSync(filename, JSON.stringify(fullDash.dashboard, null, 2));
    console.log(`\n✅ Exported dashboard to: ${filename}`);
    
    // Save SQL queries separately
    const sqlFilename = `dashboard-queries.sql`;
    let sqlContent = `-- IDGemz Dashboard SQL Queries\n-- Dashboard: ${dash.title}\n-- Exported: ${new Date().toISOString()}\n\n`;
    
    queries.forEach(q => {
      sqlContent += `-- Panel: ${q.panelTitle} (ID: ${q.panelId})\n`;
      sqlContent += q.sql + ';\n\n';
    });
    
    fs.writeFileSync(sqlFilename, sqlContent);
    console.log(`✅ Exported SQL queries to: ${sqlFilename}`);
    
    // Also create an editable SQL file with better formatting
    const editableSqlFile = 'idgemz-dashboard-queries.sql';
    const editableContent = `-- IDGemz Dashboard SQL Queries
-- Edit these queries and update them in Grafana

-- ============================================
-- STAT PANELS (Top row metrics)
-- ============================================

-- Panel: Last 7 Days Revenue
SELECT COALESCE(SUM(order_total), 0) as value 
FROM orders 
WHERE order_date >= CURRENT_DATE - INTERVAL '7 days';

-- Panel: Last 7 Days Orders
SELECT COUNT(*) as value 
FROM orders 
WHERE order_date >= CURRENT_DATE - INTERVAL '7 days';

-- Panel: Latest Order Date
SELECT MAX(order_date) as value 
FROM orders;

-- Panel: Total Revenue (All Time)
SELECT COALESCE(SUM(order_total), 0) as value 
FROM orders;

-- ============================================
-- TIME SERIES CHART
-- ============================================

-- Panel: Daily Revenue (Last 30 Days)
SELECT 
  DATE(order_date) AS time,
  COALESCE(SUM(order_total), 0) AS revenue
FROM orders 
WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(order_date)
ORDER BY 1;

-- ============================================
-- TABLES
-- ============================================

-- Panel: Top Products by Revenue
SELECT 
  SUBSTRING(p.title FROM 1 FOR 40) || '...' as "Product",
  p.internal_sku as "SKU",
  SUM(oi.quantity) as "Units Sold",
  CAST(SUM(oi.total) as NUMERIC(10,2)) as "Revenue"
FROM order_items oi 
JOIN channel_listings cl ON oi.channel_listing_id = cl.id 
JOIN products p ON cl.product_id = p.id 
JOIN orders o ON oi.order_id = o.id 
GROUP BY p.id, p.title, p.internal_sku 
ORDER BY SUM(oi.total) DESC 
LIMIT 10;

-- Panel: Recent Orders
SELECT 
  c.name as "Channel",
  o.channel_order_id as "Order ID",
  DATE(o.order_date) as "Date",
  CAST(o.order_total as NUMERIC(10,2)) as "Total",
  o.status as "Status"
FROM orders o 
JOIN channels c ON o.channel_id = c.id 
ORDER BY o.order_date DESC 
LIMIT 20;

-- ============================================
-- PIE CHART
-- ============================================

-- Panel: Sales by Channel
SELECT 
  c.name as channel,
  CAST(SUM(o.order_total) as NUMERIC(10,2)) as revenue
FROM orders o 
JOIN channels c ON o.channel_id = c.id 
GROUP BY c.name
ORDER BY revenue DESC;

-- ============================================
-- USEFUL ADDITIONAL QUERIES
-- ============================================

-- Daily orders and revenue with running total
SELECT 
  DATE(order_date) as date,
  COUNT(*) as daily_orders,
  SUM(order_total) as daily_revenue,
  SUM(SUM(order_total)) OVER (ORDER BY DATE(order_date)) as running_total
FROM orders
WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(order_date)
ORDER BY 1;

-- Product performance by week
SELECT 
  DATE_TRUNC('week', o.order_date) as week,
  p.internal_sku,
  p.title,
  SUM(oi.quantity) as units,
  SUM(oi.total) as revenue
FROM order_items oi
JOIN orders o ON oi.order_id = o.id
JOIN channel_listings cl ON oi.channel_listing_id = cl.id
JOIN products p ON cl.product_id = p.id
WHERE o.order_date >= CURRENT_DATE - INTERVAL '4 weeks'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 5 DESC;

-- Hourly order distribution (find best times)
SELECT 
  EXTRACT(HOUR FROM order_date) as hour,
  COUNT(*) as order_count,
  AVG(order_total) as avg_order_value
FROM orders
GROUP BY 1
ORDER BY 1;

-- Customer repeat purchase analysis
WITH customer_orders AS (
  SELECT 
    customer_email,
    COUNT(*) as order_count,
    SUM(order_total) as lifetime_value,
    MIN(order_date) as first_order,
    MAX(order_date) as last_order
  FROM orders
  WHERE customer_email IS NOT NULL
  GROUP BY customer_email
)
SELECT 
  CASE 
    WHEN order_count = 1 THEN 'One-time'
    WHEN order_count = 2 THEN 'Two orders'
    WHEN order_count >= 3 THEN '3+ orders'
  END as customer_type,
  COUNT(*) as customer_count,
  AVG(lifetime_value) as avg_lifetime_value
FROM customer_orders
GROUP BY 1
ORDER BY 3 DESC;
`;
    
    fs.writeFileSync(editableSqlFile, editableContent);
    console.log(`✅ Created editable SQL file: ${editableSqlFile}\n`);
  }
}

exportDashboard().catch(console.error);