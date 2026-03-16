const { SellingPartner } = require('amazon-sp-api');
require('dotenv').config();

const fs = require('fs');
const amazonKeys = fs.readFileSync('/Users/bbeaudoin/.config/amazon_keys.txt', 'utf8').trim().split('\n');
const refreshToken = amazonKeys[2];

console.log('🔍 Amazon SP-API Diagnostic Tool\n');
console.log('Credentials Check:');
console.log('✅ Client ID:', process.env.SELLING_PARTNER_APP_CLIENT_ID);
console.log('✅ Client Secret:', process.env.SELLING_PARTNER_APP_CLIENT_SECRET ? 'Set' : 'Missing');
console.log('✅ Refresh Token:', refreshToken ? 'Set' : 'Missing');

async function diagnose() {
  // Test different regions
  const regions = ['na', 'eu', 'fe'];
  
  for (const region of regions) {
    console.log(`\n\nTesting region: ${region.toUpperCase()}`);
    console.log('=' .repeat(30));
    
    try {
      const spClient = new SellingPartner({
        region: region,
        refresh_token: refreshToken
      });
      
      // Try to get an access token first
      console.log('1. Requesting access token...');
      const accessToken = await spClient.getAccessToken();
      console.log('✅ Access token obtained');
      
      // Try different endpoints
      const endpoints = [
        {
          name: 'Marketplace Participations',
          config: {
            endpoint: 'sellers',
            operation: 'getMarketplaceParticipations'
          }
        },
        {
          name: 'Notifications (Grantless)',
          config: {
            endpoint: 'notifications',
            operation: 'getDestinations',
            options: {
              grantless: true
            }
          }
        }
      ];
      
      for (const ep of endpoints) {
        try {
          console.log(`\n2. Testing ${ep.name}...`);
          const result = await spClient.callAPI(ep.config);
          console.log(`✅ ${ep.name} - Success`);
          if (result) {
            console.log('   Response:', JSON.stringify(result).substring(0, 100) + '...');
          }
        } catch (error) {
          console.log(`❌ ${ep.name} - Failed: ${error.message}`);
        }
      }
      
    } catch (error) {
      console.log(`❌ Region ${region} failed:`, error.message);
    }
  }
  
  console.log('\n\n📋 Next Steps:');
  console.log('1. Check in Seller Central → Apps & Services → Develop Apps');
  console.log('2. Click on your app "IDGemz Data Sync"');
  console.log('3. Make sure these are checked under "API Permissions":');
  console.log('   - Product Listing');
  console.log('   - Orders');  
  console.log('   - Inventory');
  console.log('   - Reports');
  console.log('4. Make sure the app status is "Published" (not "Draft")');
  console.log('5. If you just authorized, wait 5-10 minutes for propagation');
}

diagnose().catch(console.error);