const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function fixDataSource() {
  console.log('🔧 Fixing PostgreSQL data source configuration...\n');
  
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };
  
  try {
    // Get all data sources
    const response = await fetch(`${GRAFANA_URL}/api/datasources`, { headers });
    const dataSources = await response.json();
    
    // Find our PostgreSQL data source
    const pgDataSource = dataSources.find(ds => ds.name === 'IDGemz PostgreSQL');
    
    if (!pgDataSource) {
      console.log('❌ PostgreSQL data source not found. Creating new one...');
      
      // Create new data source with correct settings
      const createPayload = {
        name: 'IDGemz PostgreSQL',
        type: 'postgres',
        access: 'proxy',
        url: 'localhost:5432',
        database: 'idgemz',
        user: 'bbeaudoin',
        basicAuth: false,
        isDefault: true,
        jsonData: {
          sslmode: 'disable',
          postgresVersion: 1600,
          timescaledb: false
        }
      };
      
      const createResponse = await fetch(`${GRAFANA_URL}/api/datasources`, {
        method: 'POST',
        headers,
        body: JSON.stringify(createPayload)
      });
      
      if (createResponse.ok) {
        console.log('✅ Created new PostgreSQL data source');
      } else {
        console.log('❌ Failed to create data source:', await createResponse.text());
      }
      
    } else {
      console.log(`Found data source with ID: ${pgDataSource.id}`);
      console.log(`Current database setting: "${pgDataSource.database}"`);
      
      // Update the existing data source
      const updatePayload = {
        id: pgDataSource.id,
        name: 'IDGemz PostgreSQL',
        type: 'postgres',
        access: 'proxy',
        url: 'localhost:5432',
        database: 'idgemz',  // This is the key field that was missing!
        user: 'bbeaudoin',
        basicAuth: false,
        isDefault: true,
        jsonData: {
          sslmode: 'disable',
          postgresVersion: 1600,
          timescaledb: false
        }
      };
      
      const updateResponse = await fetch(`${GRAFANA_URL}/api/datasources/${pgDataSource.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(updatePayload)
      });
      
      if (updateResponse.ok) {
        console.log('✅ Updated PostgreSQL data source with database: idgemz');
        
        // Test the connection
        const testResponse = await fetch(`${GRAFANA_URL}/api/datasources/${pgDataSource.id}/health`, {
          headers
        });
        
        if (testResponse.ok) {
          const testResult = await testResponse.json();
          console.log('✅ Connection test:', testResult.message || 'Success');
        } else {
          console.log('❌ Connection test failed');
        }
        
      } else {
        console.log('❌ Failed to update data source:', await updateResponse.text());
      }
    }
    
    console.log('\n🔄 Please refresh your Grafana dashboard to see the data!');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

fixDataSource();