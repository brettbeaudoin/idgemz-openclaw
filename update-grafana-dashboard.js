const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function updateDashboard() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  // First get the existing dashboard
  const getDash = await fetch(`${GRAFANA_URL}/api/dashboards/uid/a7b95b06-5c39-40ee-876c-caa8f856f53b`, {
    headers
  });
  
  const currentDash = await getDash.json();
  
  // Update the dashboard with better queries
  const dashboardPayload = {
    dashboard: {
      ...currentDash.dashboard,
      panels: [
        {
          id: 1,
          title: "Last 7 Days Revenue",
          type: 'stat',
          gridPos: { x: 0, y: 0, w: 6, h: 4 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: "SELECT COALESCE(SUM(order_total), 0) as value FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '7 days'",
            format: "table"
          }],
          fieldConfig: {
            defaults: {
              unit: 'currencyUSD',
              decimals: 2
            }
          }
        },
        {
          id: 2,
          title: "Last 7 Days Orders",
          type: 'stat',
          gridPos: { x: 6, y: 0, w: 6, h: 4 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: "SELECT COUNT(*) as value FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '7 days'",
            format: "table"
          }]
        },
        {
          id: 7,
          title: "Latest Order Date",
          type: 'stat',
          gridPos: { x: 12, y: 0, w: 6, h: 4 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: "SELECT MAX(order_date) as value FROM orders",
            format: "table"
          }],
          fieldConfig: {
            defaults: {
              unit: 'dateTimeAsLocal'
            }
          }
        },
        {
          id: 8,
          title: "Total Revenue (All Time)",
          type: 'stat',
          gridPos: { x: 18, y: 0, w: 6, h: 4 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: "SELECT COALESCE(SUM(order_total), 0) as value FROM orders",
            format: "table"
          }],
          fieldConfig: {
            defaults: {
              unit: 'currencyUSD',
              decimals: 2
            }
          }
        },
        {
          id: 3,
          title: 'Daily Revenue (Last 30 Days)',
          type: 'timeseries',
          gridPos: { x: 0, y: 4, w: 24, h: 8 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: `SELECT 
              DATE(order_date) AS time,
              COALESCE(SUM(order_total), 0) AS revenue
            FROM orders 
            WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(order_date)
            ORDER BY 1`,
            format: "time_series",
            refId: "A"
          }],
          fieldConfig: {
            defaults: {
              unit: 'currencyUSD',
              custom: {
                drawStyle: 'bars',
                barAlignment: 0,
                lineWidth: 2,
                fillOpacity: 80,
                gradientMode: 'none',
                spanNulls: false,
                showPoints: 'never',
                pointSize: 5,
                stacking: {
                  mode: 'none',
                  group: 'A'
                },
                thresholdsStyle: {
                  mode: 'off'
                }
              }
            }
          },
          options: {
            legend: {
              displayMode: 'list',
              placement: 'bottom',
              showLegend: false
            },
            tooltip: {
              mode: 'single',
              sort: 'none'
            }
          }
        },
        {
          id: 4,
          title: 'Top Products by Revenue',
          type: 'table',
          gridPos: { x: 0, y: 12, w: 12, h: 8 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: `SELECT 
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
            LIMIT 10`,
            format: "table"
          }],
          options: {
            showHeader: true,
            cellHeight: 'sm'
          },
          fieldConfig: {
            overrides: [
              {
                matcher: { id: 'byName', options: 'Revenue' },
                properties: [{
                  id: 'unit',
                  value: 'currencyUSD'
                }]
              }
            ]
          }
        },
        {
          id: 5,
          title: 'Sales by Channel',
          type: 'piechart',
          gridPos: { x: 12, y: 12, w: 12, h: 8 },
          datasource: 'IDGemz PostgreSQL',
          targets: [{
            rawSql: `SELECT 
              c.name as channel,
              CAST(SUM(o.order_total) as NUMERIC(10,2)) as revenue
            FROM orders o 
            JOIN channels c ON o.channel_id = c.id 
            GROUP BY c.name
            ORDER BY revenue DESC`,
            format: "table"
          }],
          options: {
            reduceOptions: {
              values: false,
              calcs: ['lastNotNull']
            },
            pieType: 'donut',
            displayLabels: ['name', 'percent'],
            legendDisplayMode: 'list',
            legendPlacement: 'right',
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
              DATE(o.order_date) as "Date",
              CAST(o.order_total as NUMERIC(10,2)) as "Total",
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
          },
          fieldConfig: {
            overrides: [
              {
                matcher: { id: 'byName', options: 'Total' },
                properties: [{
                  id: 'unit',
                  value: 'currencyUSD'
                }]
              }
            ]
          }
        }
      ]
    },
    overwrite: true
  };

  const updateDashboard = await fetch(`${GRAFANA_URL}/api/dashboards/db`, {
    method: 'POST',
    headers,
    body: JSON.stringify(dashboardPayload)
  });

  if (updateDashboard.ok) {
    console.log('✅ Dashboard updated successfully!');
    console.log('\nChanges made:');
    console.log('- Changed "Today\'s Revenue/Orders" to "Last 7 Days" metrics');
    console.log('- Added "Latest Order Date" to show when data was last synced');
    console.log('- Added "Total Revenue (All Time)" metric');
    console.log('- Fixed SQL queries to return data in proper format');
    console.log('- Changed revenue trend to bar chart for better daily visibility');
    console.log('\nRefresh your browser to see the updated dashboard!');
  } else {
    console.error('Failed to update dashboard:', await updateDashboard.text());
  }
}

updateDashboard().catch(console.error);