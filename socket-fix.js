const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function socketFix() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  console.log('🔧 Trying Unix socket connection for PostgreSQL...\n');

  // Delete existing data sources
  const dsListResponse = await fetch(`${GRAFANA_URL}/api/datasources`, { headers });
  const dataSources = await dsListResponse.json();
  
  for (const ds of dataSources) {
    if (ds.type === 'postgres') {
      await fetch(`${GRAFANA_URL}/api/datasources/${ds.id}`, {
        method: 'DELETE',
        headers
      });
    }
  }

  // Try different connection methods
  const configs = [
    {
      name: 'IDGemz PostgreSQL (Socket)',
      url: '/tmp:5432',
      jsonData: { sslmode: 'disable', host: '/tmp' }
    },
    {
      name: 'IDGemz PostgreSQL (Host)',  
      url: 'host.docker.internal:5432',
      jsonData: { sslmode: 'disable' }
    },
    {
      name: 'IDGemz PostgreSQL (Local)',
      url: 'localhost:5432',
      jsonData: { sslmode: 'require' }
    }
  ];

  // First, let's check if PostgreSQL requires a password
  console.log('Testing PostgreSQL authentication...');
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);
  
  try {
    const { stdout } = await execPromise('export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH" && psql -d idgemz -c "SELECT 1;" 2>&1');
    console.log('✅ Local PostgreSQL connection works without password\n');
  } catch (error) {
    console.log('❌ Local PostgreSQL connection failed:', error.message);
  }

  // Try the simplest possible configuration
  const dataSourceConfig = {
    name: 'IDGemz PostgreSQL',
    type: 'postgres',
    access: 'proxy',
    url: 'localhost:5432',
    user: 'bbeaudoin',
    password: '', // No password
    database: 'idgemz',
    basicAuth: false,
    withCredentials: false,
    isDefault: true,
    jsonData: {
      sslmode: 'disable',
      postgresVersion: 1600,
      timescaledb: false,
      maxOpenConns: 0,
      maxIdleConns: 2,
      connMaxLifetime: 14400
    }
  };

  const createResponse = await fetch(`${GRAFANA_URL}/api/datasources`, {
    method: 'POST',
    headers,
    body: JSON.stringify(dataSourceConfig)
  });

  if (createResponse.ok) {
    const newDs = await createResponse.json();
    console.log('✅ Created data source:', newDs.id);
    
    // Test with direct query API
    console.log('\nTesting query execution...');
    const queryPayload = {
      queries: [
        {
          datasourceId: newDs.id,
          format: 'table',
          rawSql: 'SELECT version()',
          refId: 'A'
        }
      ]
    };

    const queryResponse = await fetch(`${GRAFANA_URL}/api/ds/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(queryPayload)
    });

    if (queryResponse.ok) {
      const result = await queryResponse.json();
      console.log('✅ Query test successful');
      
      // Now let's check the logs
      console.log('\nChecking Grafana logs for errors...');
      console.log('Run this command in another terminal to see logs:');
      console.log('  tail -f /opt/homebrew/var/log/grafana/grafana.log | grep -i postgres');
      
    } else {
      console.log('❌ Query failed:', queryResponse.status, await queryResponse.text());
    }
  }

  console.log('\n💡 Troubleshooting steps:');
  console.log('1. Check if PostgreSQL is configured to accept TCP connections');
  console.log('2. Edit /opt/homebrew/var/postgresql@16/postgresql.conf');
  console.log('   Add: listen_addresses = \'*\'');
  console.log('3. Edit /opt/homebrew/var/postgresql@16/pg_hba.conf');
  console.log('   Add: host all all 127.0.0.1/32 trust');
  console.log('4. Restart PostgreSQL: brew services restart postgresql@16');
}

socketFix().catch(console.error);