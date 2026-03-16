const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function testConnection() {
  try {
    // Get refresh token from database
    const result = await pool.query(`
      SELECT api_credentials 
      FROM channels 
      WHERE platform = 'amazon' AND api_connected = true
    `);
    
    if (!result.rows.length) {
      throw new Error('No Amazon connection found');
    }
    
    const { refreshToken } = result.rows[0].api_credentials;
    console.log('Found refresh token:', refreshToken.substring(0, 20) + '...');
    console.log('Client ID:', process.env.SELLING_PARTNER_APP_CLIENT_ID);
    
    // Initialize with correct configuration
    const spClient = new SellingPartner({
      region: 'na', // North America
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
      },
      options: {
        auto_request_throttled: true
      }
    });
    
    // Test with a simple API call - get seller account info
    console.log('\nTesting connection...');
    const sellerInfo = await spClient.callAPI({
      endpoint: 'sellers',
      operation: 'getMarketplaceParticipations'
    });
    
    console.log('\n✅ Success! Connected to Amazon SP-API');
    console.log('\nMarketplaces:');
    
    if (sellerInfo && Array.isArray(sellerInfo)) {
      sellerInfo.forEach(participation => {
        if (participation.marketplace) {
          console.log(`- ${participation.marketplace.name} (${participation.marketplace.id})`);
          console.log(`  Country: ${participation.marketplace.countryCode}`);
          console.log(`  Currency: ${participation.marketplace.defaultCurrencyCode}`);
        }
      });
    }
    
    // Try to get recent orders
    console.log('\nFetching recent orders...');
    const orders = await spClient.callAPI({
      endpoint: 'orders',
      operation: 'getOrders',
      query: {
        MarketplaceIds: ['ATVPDKIKX0DER'], // US marketplace
        CreatedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
    
    console.log(`\nFound ${orders.Orders ? orders.Orders.length : 0} orders in the last 7 days`);
    
  } catch (error) {
    console.error('\n❌ Connection test failed:', error.message);
    if (error.response) {
      console.error('API Response:', JSON.stringify(error.response.data, null, 2));
    }
    if (error.code) {
      console.error('Error code:', error.code);
    }
  } finally {
    await pool.end();
  }
}

testConnection();