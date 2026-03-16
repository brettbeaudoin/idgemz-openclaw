const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function recreateDataSource() {
  console.log('🔧 Recreating PostgreSQL data source...\n');
  
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };
  
  try {
    // Get all data sources
    const response = await fetch(`${GRAFANA_URL}/api/datasources`, { headers });
    const dataSources = await response.json();
    
    // Find and delete existing PostgreSQL data source
    for (const ds of dataSources) {
      if (ds.name === 'IDGemz PostgreSQL' || ds.type === 'postgres') {
        console.log(`Deleting existing data source: ${ds.name} (ID: ${ds.id})`);
        await fetch(`${GRAFANA_URL}/api/datasources/${ds.id}`, {
          method: 'DELETE',
          headers
        });
      }
    }
    
    console.log('\n📊 Creating fresh PostgreSQL data source...');
    
    // Create new data source with all required fields
    const createPayload = {
      name: 'IDGemz PostgreSQL',
      type: 'postgres',
      typeName: 'PostgreSQL',
      access: 'proxy',
      url: 'localhost:5432',
      password: '',
      user: 'bbeaudoin',
      database: 'idgemz',
      basicAuth: false,
      isDefault: true,
      jsonData: {
        database: 'idgemz',
        sslmode: 'disable',
        maxOpenConns: 0,
        maxIdleConns: 2,
        connMaxLifetime: 14400,
        postgresVersion: 1600,
        timescaledb: false
      },
      secureJsonFields: {},
      version: 1,
      readOnly: false
    };
    
    const createResponse = await fetch(`${GRAFANA_URL}/api/datasources`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createPayload)
    });
    
    if (createResponse.ok) {
      const newDs = await createResponse.json();
      console.log('✅ Created new PostgreSQL data source with ID:', newDs.id);
      console.log('   Database:', createPayload.database);
      console.log('   User:', createPayload.user);
      console.log('   Host:', createPayload.url);
      
      // Test the connection
      console.log('\n🧪 Testing connection...');
      const testResponse = await fetch(`${GRAFANA_URL}/api/datasources/${newDs.id}/health`, {
        headers
      });
      
      if (testResponse.ok) {
        const testResult = await testResponse.json();
        console.log('✅ Connection test passed:', testResult.message);
        
        // Let's also run a test query
        console.log('\n📊 Running test query...');
        const testQuery = {
          queries: [{
            datasource: { uid: newDs.uid },
            rawSql: "SELECT COUNT(*) as order_count FROM orders",
            format: "table"
          }]
        };
        
        const queryResponse = await fetch(`${GRAFANA_URL}/api/ds/query`, {
          method: 'POST',
          headers,
          body: JSON.stringify(testQuery)
        });
        
        if (queryResponse.ok) {
          const queryResult = await queryResponse.json();
          console.log('✅ Test query successful');
          if (queryResult.results && queryResult.results.A && queryResult.results.A.frames) {
            const frame = queryResult.results.A.frames[0];
            if (frame && frame.data && frame.data.values) {
              console.log('   Orders in database:', frame.data.values[0][0]);
            }
          }
        }
        
      } else {
        console.log('❌ Connection test failed:', await testResponse.text());
      }
      
    } else {
      console.log('❌ Failed to create data source:', await createResponse.text());
    }
    
    console.log('\n✨ Data source recreation complete!');
    console.log('\n🔄 Please refresh your Grafana dashboard (Ctrl+R or Cmd+R)');
    console.log('   The dashboard should now show your sales data properly.');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

recreateDataSource();