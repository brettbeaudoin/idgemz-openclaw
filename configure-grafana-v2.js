const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT'; // From ~/.config/grafana.txt

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
      
      // Get the existing data source
      const dataSources = await fetch(`${GRAFANA_URL}/api/datasources`, { headers });
      const dsList = await dataSources.json();
      const existingDS = dsList.find(ds => ds.name === 'IDGemz PostgreSQL');
      if (existingDS) {
        console.log(`   Using existing data source with ID: ${existingDS.id}`);
      }
    } else {
      const error = await createDataSource.text();
      console.log('❌ Failed to create data source:', error);
    }
    
    // 3. Create the IDGemz dashboard
    console.log('\n📈 Creating IDGemz Sales Dashboard...');
    
    const dashboardPayload = {
      dashboard: {
        title: 'IDGemz Sales Dashboard',
        tags: ['idgemz', 'sales', 'ecommerce'],
        timezone: 'America/New_York',
        panels: [
          {
            id: 1,
            title: "Today's Revenue",
            type: 'stat',
            gridPos: { x: 0, y: 0, w: 6, h: 4 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: "SELECT COALESCE(SUM(order_total), 0) as value FROM orders WHERE order_date::date = CURRENT_DATE",
              format: "time_series"
            }],
            options: {
              textMode: 'value',
              graphMode: 'none',
              colorMode: 'value',
              justifyMode: 'center',
              unit: 'currencyUSD'
            }
          },
          {
            id: 2,
            title: "Today's Orders",
            type: 'stat',
            gridPos: { x: 6, y: 0, w: 6, h: 4 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: "SELECT COUNT(*) as value FROM orders WHERE order_date::date = CURRENT_DATE",
              format: "time_series"
            }],
            options: {
              textMode: 'value',
              graphMode: 'none',
              colorMode: 'value',
              justifyMode: 'center'
            }
          },
          {
            id: 3,
            title: 'Revenue Trend (30 Days)',
            type: 'timeseries',
            gridPos: { x: 0, y: 4, w: 24, h: 8 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: `SELECT 
                date_trunc('day', order_date) as time, 
                SUM(order_total) as "Revenue"
              FROM orders 
              WHERE order_date >= NOW() - INTERVAL '30 days' 
              GROUP BY 1 
              ORDER BY 1`,
              format: "time_series"
            }],
            fieldConfig: {
              defaults: {
                unit: 'currencyUSD',
                custom: {
                  drawStyle: 'line',
                  lineInterpolation: 'smooth',
                  lineWidth: 2,
                  fillOpacity: 10,
                  showPoints: 'always',
                  pointSize: 4
                }
              }
            }
          },
          {
            id: 4,
            title: 'Top Products by Revenue (Last 7 Days)',
            type: 'table',
            gridPos: { x: 0, y: 12, w: 12, h: 8 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: `SELECT 
                p.title as "Product",
                p.internal_sku as "SKU",
                SUM(oi.quantity) as "Units Sold",
                SUM(oi.total) as "Revenue"
              FROM order_items oi 
              JOIN channel_listings cl ON oi.channel_listing_id = cl.id 
              JOIN products p ON cl.product_id = p.id 
              JOIN orders o ON oi.order_id = o.id 
              WHERE o.order_date >= NOW() - INTERVAL '7 days' 
              GROUP BY p.id, p.title, p.internal_sku 
              ORDER BY "Revenue" DESC 
              LIMIT 10`,
              format: "table"
            }],
            options: {
              showHeader: true
            }
          },
          {
            id: 5,
            title: 'Sales by Channel (30 Days)',
            type: 'piechart',
            gridPos: { x: 12, y: 12, w: 12, h: 8 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: `SELECT 
                c.name as metric,
                SUM(o.order_total) as value
              FROM orders o 
              JOIN channels c ON o.channel_id = c.id 
              WHERE o.order_date >= NOW() - INTERVAL '30 days' 
              GROUP BY c.name`,
              format: "time_series"
            }],
            options: {
              legendDisplayMode: 'table',
              legendPlacement: 'right',
              pieType: 'donut',
              unit: 'currencyUSD'
            }
          },
          {
            id: 6,
            title: 'Recent Orders',
            type: 'table',
            gridPos: { x: 0, y: 20, w: 24, h: 8 },
            datasource: 'IDGemz PostgreSQL',
            targets: [{
              rawSql: `SELECT 
                c.name as "Channel",
                o.channel_order_id as "Order ID",
                o.order_date as "Date",
                o.order_total as "Total",
                o.status as "Status"
              FROM orders o 
              JOIN channels c ON o.channel_id = c.id 
              ORDER BY o.order_date DESC 
              LIMIT 20`,
              format: "table"
            }],
            options: {
              showHeader: true,
              cellHeight: 'sm'
            }
          }
        ],
        schemaVersion: 38,
        version: 1,
        weekStart: ''
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
      console.log(`\n🔗 View your dashboard at: ${GRAFANA_URL}${result.url}`);
      
      // Set as home dashboard
      await fetch(`${GRAFANA_URL}/api/user/preferences`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          homeDashboardId: result.id
        })
      });
      console.log('✅ Set as home dashboard');
      
    } else {
      const error = await createDashboard.text();
      console.log('❌ Failed to create dashboard:', error);
    }
    
    console.log('\n✨ Grafana configuration complete!');
    console.log('\n📊 Your IDGemz Sales Dashboard is ready at: http://localhost:3000');
    
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