const fetch = require('node-fetch');

const GRAFANA_URL = 'http://localhost:3000';
const GRAFANA_USER = 'admin';
const GRAFANA_PASS = 'F@Pc3g5qqwJBaT';

async function refreshDashboard() {
  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };

  try {
    // Get the data source
    const dsResponse = await fetch(`${GRAFANA_URL}/api/datasources/name/IDGemz%20PostgreSQL`, { headers });
    const dataSource = await dsResponse.json();
    console.log('Using data source:', dataSource.name, 'with UID:', dataSource.uid);
    
    // Get the dashboard
    const dashResponse = await fetch(`${GRAFANA_URL}/api/dashboards/uid/a7b95b06-5c39-40ee-876c-caa8f856f53b`, {
      headers
    });
    
    if (!dashResponse.ok) {
      console.log('Dashboard not found, searching for it...');
      const searchResponse = await fetch(`${GRAFANA_URL}/api/search?query=IDGemz`, { headers });
      const results = await searchResponse.json();
      if (results.length > 0) {
        console.log('Found dashboard:', results[0].title, 'UID:', results[0].uid);
      }
      return;
    }
    
    const currentDash = await dashResponse.json();
    
    // Update all panels to use the correct data source
    const updatedPanels = currentDash.dashboard.panels.map(panel => ({
      ...panel,
      datasource: {
        type: 'postgres',
        uid: dataSource.uid
      }
    }));
    
    // Update the dashboard
    const updatePayload = {
      dashboard: {
        ...currentDash.dashboard,
        panels: updatedPanels,
        version: currentDash.dashboard.version + 1
      },
      overwrite: true
    };
    
    const updateResponse = await fetch(`${GRAFANA_URL}/api/dashboards/db`, {
      method: 'POST',
      headers,
      body: JSON.stringify(updatePayload)
    });
    
    if (updateResponse.ok) {
      console.log('✅ Dashboard updated with new data source');
      console.log('🔄 Refresh your browser to see the data!');
    } else {
      console.log('Failed to update dashboard:', await updateResponse.text());
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

refreshDashboard();