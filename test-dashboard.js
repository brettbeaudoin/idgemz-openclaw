const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function createTestDashboard() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  // Get the data source
  const dsResponse = await fetch(`${GRAFANA_URL}/api/datasources/name/IDGemz%20PostgreSQL`, { headers });
  const dataSource = await dsResponse.json();
  
  const testDashboard = {
    dashboard: {
      title: 'IDGemz Test Dashboard',
      tags: ['test'],
      timezone: 'browser',
      panels: [
        {
          id: 1,
          title: 'Simple Order Count',
          type: 'stat',
          gridPos: { x: 0, y: 0, w: 12, h: 8 },
          datasource: {
            type: 'postgres',
            uid: dataSource.uid
          },
          targets: [{
            datasource: {
              type: 'postgres',
              uid: dataSource.uid
            },
            format: 'table',
            rawQuery: true,
            rawSql: 'SELECT COUNT(*) as count FROM orders',
            refId: 'A'
          }],
          options: {
            reduceOptions: {
              values: false,
              calcs: ['last'],
              fields: ''
            },
            orientation: 'auto',
            textMode: 'value',
            colorMode: 'value',
            graphMode: 'none',
            justifyMode: 'center'
          },
          fieldConfig: {
            defaults: {
              mappings: [],
              thresholds: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null }
                ]
              }
            },
            overrides: []
          }
        },
        {
          id: 2,
          title: 'Total Revenue',
          type: 'stat',
          gridPos: { x: 12, y: 0, w: 12, h: 8 },
          datasource: {
            type: 'postgres',
            uid: dataSource.uid
          },
          targets: [{
            datasource: {
              type: 'postgres',
              uid: dataSource.uid
            },
            format: 'table',
            rawQuery: true,
            rawSql: 'SELECT SUM(order_total) as total FROM orders',
            refId: 'A'
          }],
          options: {
            reduceOptions: {
              values: false,
              calcs: ['last'],
              fields: ''
            },
            orientation: 'auto',
            textMode: 'value',
            colorMode: 'value',
            graphMode: 'none',
            justifyMode: 'center'
          },
          fieldConfig: {
            defaults: {
              mappings: [],
              thresholds: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null }
                ]
              },
              unit: 'currencyUSD'
            },
            overrides: []
          }
        }
      ],
      schemaVersion: 38,
      version: 0
    },
    overwrite: true
  };

  const response = await fetch(`${GRAFANA_URL}/api/dashboards/db`, {
    method: 'POST',
    headers,
    body: JSON.stringify(testDashboard)
  });

  if (response.ok) {
    const result = await response.json();
    console.log('✅ Test dashboard created!');
    console.log(`🔗 Open: ${GRAFANA_URL}${result.url}`);
  } else {
    console.log('Failed:', await response.text());
  }
}

createTestDashboard();