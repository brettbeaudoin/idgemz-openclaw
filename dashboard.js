const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function showDashboard() {
  console.log('\n=== IDGemz Multi-Channel Dashboard ===\n');
  
  // Channel status
  const channels = await pool.query(`
    SELECT name, platform, api_connected, last_sync_at
    FROM channels
    ORDER BY name
  `);
  
  console.log('📡 Channel Status:');
  console.table(channels.rows.map(ch => ({
    Channel: ch.name,
    Platform: ch.platform,
    'API Connected': ch.api_connected ? '✅' : '❌',
    'Last Sync': ch.last_sync_at ? new Date(ch.last_sync_at).toLocaleString() : 'Never'
  })));
  
  // Sales summary (last 30 days)
  const salesSummary = await pool.query(`
    SELECT 
      c.name as channel,
      COUNT(DISTINCT o.id) as total_orders,
      SUM(o.order_total) as total_revenue,
      AVG(o.order_total) as avg_order_value
    FROM orders o
    JOIN channels c ON o.channel_id = c.id
    WHERE o.order_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY c.name
    ORDER BY total_revenue DESC
  `);
  
  console.log('\n💰 Sales Summary (Last 30 Days):');
  console.table(salesSummary.rows.map(row => ({
    Channel: row.channel,
    Orders: row.total_orders,
    Revenue: `$${parseFloat(row.total_revenue || 0).toFixed(2)}`,
    'Avg Order': `$${parseFloat(row.avg_order_value || 0).toFixed(2)}`
  })));
  
  // Top products
  const topProducts = await pool.query(`
    SELECT 
      p.title,
      p.internal_sku,
      COUNT(DISTINCT oi.order_id) as units_sold,
      SUM(oi.total) as revenue
    FROM order_items oi
    JOIN channel_listings cl ON oi.channel_listing_id = cl.id
    JOIN products p ON cl.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE o.order_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY p.id, p.title, p.internal_sku
    ORDER BY revenue DESC
    LIMIT 10
  `);
  
  console.log('\n🏆 Top Products (Last 30 Days):');
  console.table(topProducts.rows.map(row => ({
    Product: row.title ? row.title.substring(0, 40) + '...' : 'Unknown',
    SKU: row.internal_sku,
    'Units Sold': row.units_sold,
    Revenue: `$${parseFloat(row.revenue || 0).toFixed(2)}`
  })));
  
  // Recent orders
  const recentOrders = await pool.query(`
    SELECT 
      c.name as channel,
      o.channel_order_id,
      o.order_date,
      o.order_total,
      o.status
    FROM orders o
    JOIN channels c ON o.channel_id = c.id
    ORDER BY o.order_date DESC
    LIMIT 10
  `);
  
  console.log('\n📦 Recent Orders:');
  console.table(recentOrders.rows.map(row => ({
    Channel: row.channel,
    'Order ID': row.channel_order_id,
    Date: new Date(row.order_date).toLocaleDateString(),
    Total: `$${parseFloat(row.order_total || 0).toFixed(2)}`,
    Status: row.status
  })));
  
  // Inventory levels
  const inventory = await pool.query(`
    SELECT 
      p.title,
      p.internal_sku,
      SUM(i.quantity_available) as available,
      SUM(i.quantity_reserved) as reserved,
      SUM(i.quantity_inbound) as inbound
    FROM inventory i
    JOIN products p ON i.product_id = p.id
    WHERE i.quantity_available > 0 OR i.quantity_reserved > 0 OR i.quantity_inbound > 0
    GROUP BY p.id, p.title, p.internal_sku
    ORDER BY available DESC
    LIMIT 10
  `);
  
  console.log('\n📊 Current Inventory:');
  console.table(inventory.rows.map(row => ({
    Product: row.title ? row.title.substring(0, 40) + '...' : 'Unknown',
    SKU: row.internal_sku,
    Available: row.available || 0,
    Reserved: row.reserved || 0,
    Inbound: row.inbound || 0
  })));
  
  await pool.end();
}

if (require.main === module) {
  showDashboard().catch(console.error);
}

module.exports = { showDashboard };