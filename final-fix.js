const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function finalFix() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  console.log('🔧 Final fix for Grafana PostgreSQL connection...\n');

  // Delete all existing postgres data sources
  const dsListResponse = await fetch(`${GRAFANA_URL}/api/datasources`, { headers });
  const dataSources = await dsListResponse.json();
  
  for (const ds of dataSources) {
    if (ds.type === 'postgres') {
      console.log(`Deleting data source: ${ds.name}`);
      await fetch(`${GRAFANA_URL}/api/datasources/${ds.id}`, {
        method: 'DELETE',
        headers
      });
    }
  }

  // Create new data source with explicit settings
  const dataSourceConfig = {
    name: 'IDGemz DB',
    type: 'postgres',
    access: 'proxy',
    url: '127.0.0.1:5432',  // Use explicit IP instead of localhost
    user: 'bbeaudoin',
    database: 'idgemz',
    basicAuth: false,
    withCredentials: false,
    isDefault: true,
    jsonData: {
      sslmode: 'disable',
      maxOpenConns: 0,
      maxIdleConns: 2,
      connMaxLifetime: 14400,
      postgresVersion: 1600,
      timescaledb: false
    },
    readOnly: false
  };

  console.log('Creating data source with config:');
  console.log('  URL:', dataSourceConfig.url);
  console.log('  Database:', dataSourceConfig.database);
  console.log('  User:', dataSourceConfig.user);

  const createResponse = await fetch(`${GRAFANA_URL}/api/datasources`, {
    method: 'POST',
    headers,
    body: JSON.stringify(dataSourceConfig)
  });

  if (!createResponse.ok) {
    console.error('Failed to create data source:', await createResponse.text());
    return;
  }

  const newDataSource = await createResponse.json();
  console.log('\n✅ Created data source with ID:', newDataSource.id);

  // Test the connection
  const testResponse = await fetch(`${GRAFANA_URL}/api/datasources/proxy/${newDataSource.id}/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'q=' + encodeURIComponent('SELECT 1')
  });

  console.log('Connection test response:', testResponse.status);

  // Create a super simple dashboard
  const simpleDashboard = {
    dashboard: {
      title: 'IDGemz Simple Dashboard',
      panels: [
        {
          datasource: {
            type: 'postgres',
            uid: newDataSource.uid
          },
          fieldConfig: {
            defaults: {
              custom: {
                align: 'auto',
                displayMode: 'auto'
              },
              mappings: [],
              thresholds: {
                mode: 'absolute',
                steps: [
                  {
                    color: 'green',
                    value: null
                  }
                ]
              }
            },
            overrides: []
          },
          gridPos: {
            h: 8,
            w: 12,
            x: 0,
            y: 0
          },
          id: 2,
          options: {
            showHeader: true
          },
          pluginVersion: '9.1.0',
          targets: [
            {
              datasource: {
                type: 'postgres',
                uid: newDataSource.uid
              },
              format: 'table',
              group: [],
              metricColumn: 'none',
              rawQuery: true,
              rawSql: 'SELECT channel_id, COUNT(*) as order_count, SUM(order_total) as total_revenue FROM orders GROUP BY channel_id',
              refId: 'A',
              select: [
                [
                  {
                    params: [
                      'value'
                    ],
                    type: 'column'
                  }
                ]
              ],
              table: 'orders',
              timeColumn: 'time',
              where: [
                {
                  name: '$__timeFilter',
                  params: [],
                  type: 'macro'
                }
              ]
            }
          ],
          title: 'Orders by Channel',
          type: 'table'
        }
      ],
      schemaVersion: 37,
      style: 'dark',
      tags: [],
      templating: {
        list: []
      },
      time: {
        from: 'now-30d',
        to: 'now'
      },
      timepicker: {},
      timezone: '',
      uid: 'simple-idgemz',
      version: 0,
      weekStart: ''
    }
  };

  const dashboardResponse = await fetch(`${GRAFANA_URL}/api/dashboards/db`, {
    method: 'POST',
    headers,
    body: JSON.stringify(simpleDashboard)
  });

  if (dashboardResponse.ok) {
    const dashResult = await dashboardResponse.json();
    console.log('\n✅ Created simple dashboard');
    console.log(`\n🔗 Open this URL to test: ${GRAFANA_URL}${dashResult.url}`);
    console.log('\nThis dashboard should show a simple table of orders by channel.');
    console.log('If this works, we can rebuild your main dashboard.');
  } else {
    console.error('Failed to create dashboard:', await dashboardResponse.text());
  }
}

finalFix().catch(console.error);