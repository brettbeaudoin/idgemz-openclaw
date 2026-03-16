const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'admin';

async function configureGrafana() {
  console.log('🔧 Configuring Grafana with PostgreSQL...\n');
  
  // Basic auth header
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };
  
  try {
    // 1. First, check if we can connect
    const healthCheck = await fetch(`${GRAFANA_URL}/api/health`, { headers });
    if (healthCheck.ok) {
      console.log('✅ Connected to Grafana');
    } else {
      console.log('❌ Could not connect to Grafana. Make sure it\'s running on port 3000');
      return;
    }
    
    // 2. Add PostgreSQL data source
    console.log('\n📊 Adding PostgreSQL data source...');
    
    const dataSourcePayload = {
      name: 'IDGemz PostgreSQL',
      type: 'postgres',
      access: 'proxy',
      url: 'localhost:5432',
      database: 'idgemz',
      user: 'bbeaudoin',
      secureJsonFields: {},
      jsonData: {
        sslmode: 'disable',
        postgresVersion: 1600, // PostgreSQL 16
        timescaledb: false
      },
      readOnly: false
    };
    
    const createDataSource = await fetch(`${GRAFANA_URL}/api/datasources`, {
      method: 'POST',
      headers,
      body: JSON.stringify(dataSourcePayload)
    });
    
    if (createDataSource.ok) {
      const result = await createDataSource.json();
      console.log(`✅ PostgreSQL data source created with ID: ${result.id}`);
      
      // Test the connection
      const testConnection = await fetch(`${GRAFANA_URL}/api/datasources/${result.id}/health`, {
        headers
      });
      
      if (testConnection.ok) {
        console.log('✅ PostgreSQL connection test successful!');
      } else {
        console.log('⚠️  PostgreSQL connection test failed - check your database settings');
      }
      
    } else if (createDataSource.status === 409) {
      console.log('ℹ️  PostgreSQL data source already exists');
    } else {
      const error = await createDataSource.text();
      console.log('❌ Failed to create data source:', error);
    }
    
    // 3. Create a sample dashboard
    console.log('\n📈 Creating IDGemz dashboard...');
    
    const dashboardPayload = {
      dashboard: {
        title: 'IDGemz Sales Dashboard',
        tags: ['idgemz', 'sales'],
        timezone: 'America/New_York',
        panels: [
          {
            id: 1,
            title: 'Today\'s Revenue',
            type: 'stat',
            gridPos: { x: 0, y: 0, w: 6, h: 4 },
            targets: [{
              rawSql: "SELECT SUM(order_total) FROM orders WHERE order_date::date = CURRENT_DATE",
              format: "table"
            }]
          },
          {
            id: 2,
            title: 'Orders by Day (Last 30 Days)',
            type: 'timeseries',
            gridPos: { x: 6, y: 0, w: 18, h: 8 },
            targets: [{
              rawSql: "SELECT date_trunc('day', order_date) as time, COUNT(*) as \"Orders\", SUM(order_total) as \"Revenue\" FROM orders WHERE order_date >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1",
              format: "time_series"
            }]
          },
          {
            id: 3,
            title: 'Top Products by Revenue',
            type: 'table',
            gridPos: { x: 0, y: 8, w: 12, h: 8 },
            targets: [{
              rawSql: "SELECT p.title as \"Product\", p.internal_sku as \"SKU\", SUM(oi.quantity) as \"Units Sold\", SUM(oi.total) as \"Revenue\" FROM order_items oi JOIN channel_listings cl ON oi.channel_listing_id = cl.id JOIN products p ON cl.product_id = p.id JOIN orders o ON oi.order_id = o.id WHERE o.order_date >= NOW() - INTERVAL '30 days' GROUP BY p.id, p.title, p.internal_sku ORDER BY \"Revenue\" DESC LIMIT 10",
              format: "table"
            }]
          },
          {
            id: 4,
            title: 'Sales by Channel',
            type: 'piechart',
            gridPos: { x: 12, y: 8, w: 12, h: 8 },
            targets: [{
              rawSql: "SELECT c.name as \"Channel\", SUM(o.order_total) as \"Revenue\" FROM orders o JOIN channels c ON o.channel_id = c.id WHERE o.order_date >= NOW() - INTERVAL '30 days' GROUP BY c.name",
              format: "table"
            }]
          }
        ],
        schemaVersion: 16,
        version: 0
      },
      overwrite: true
    };
    
    const createDashboard = await fetch(`${GRAFANA_URL}/api/dashboards/db`, {
      method: 'POST',
      headers,
      body: JSON.stringify(dashboardPayload)
    });
    
    if (createDashboard.ok) {
      const result = await createDashboard.json();
      console.log('✅ Dashboard created successfully!');
      console.log(`🔗 View it at: ${GRAFANA_URL}${result.url}`);
    } else {
      const error = await createDashboard.text();
      console.log('❌ Failed to create dashboard:', error);
    }
    
    console.log('\n✨ Grafana configuration complete!');
    console.log('\n📝 Next steps:');
    console.log('1. Visit http://localhost:3000');
    console.log('2. Login with admin/admin');
    console.log('3. You\'ll be prompted to change the password');
    console.log('4. Your IDGemz dashboard will be on the home screen');
    
  } catch (error) {
    console.error('Error configuring Grafana:', error.message);
    console.log('\n💡 Tip: Make sure Grafana is running (brew services start grafana)');
  }
}

// Run if called directly
if (require.main === module) {
  configureGrafana();
}

module.exports = { configureGrafana };