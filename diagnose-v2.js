const { SellingPartner } = require('amazon-sp-api');
require('dotenv').config();

const fs = require('fs');
const amazonKeys = fs.readFileSync('/Users/bbeaudoin/.config/amazon_keys.txt', 'utf8').trim().split('\n');
const refreshToken = amazonKeys[2];

console.log('🔍 Amazon SP-API Diagnostic Tool\n');

async function diagnose() {
  try {
    const spClient = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      options: {
        debug_log: true, // Enable debug logging
        auto_request_throttled: true
      }
    });
    
    // Try the authorization endpoint first - this should always work
    console.log('Testing Authorization endpoint...');
    try {
      const auth = await spClient.callAPI({
        endpoint: 'authorization',
        operation: 'getAuthorizationCode',
        query: {
          sellingPartnerId: 'ATVPDKIKX0DER',
          developerId: process.env.SELLING_PARTNER_APP_CLIENT_ID.split('.')[2], // Extract developer ID
          mwsAuthToken: 'dummy' // This will fail but show us if auth is working
        }
      });
    } catch (authError) {
      // This is expected to fail, but it tells us if we can reach the API
      console.log('Auth endpoint response:', authError.message);
    }
    
    // Try grantless operation
    console.log('\nTesting grantless operation (no seller account needed)...');
    try {
      const notifications = await spClient.callAPI({
        endpoint: 'notifications',
        operation: 'getDestinations',
        options: {
          grantless: true
        }
      });
      console.log('✅ Grantless operation worked!');
    } catch (grantlessError) {
      console.log('❌ Grantless failed:', grantlessError.message);
    }
    
    // Try seller-specific operation
    console.log('\nTesting seller-specific operation...');
    try {
      const participation = await spClient.callAPI({
        endpoint: 'sellers',
        operation: 'getMarketplaceParticipations'
      });
      console.log('✅ SUCCESS! Your app is properly connected.');
      console.log('\nYour marketplaces:');
      participation.forEach(p => {
        console.log(`- ${p.marketplace.name} (${p.marketplace.id})`);
      });
    } catch (sellerError) {
      console.log('❌ Seller API failed:', sellerError.message);
      
      if (sellerError.code === 'Unauthorized') {
        console.log('\n⚠️  This usually means:');
        console.log('1. Your app needs to be published (not in draft status)');
        console.log('2. You need to wait 5-10 minutes after authorization');
        console.log('3. Your app needs the right permissions (Orders, Product Listing, etc.)');
      }
    }
    
  } catch (error) {
    console.error('Unexpected error:', error);
  }
  
  console.log('\n\n📋 Action Items:');
  console.log('1. Go to Seller Central → Partner Network → Develop Apps');
  console.log('2. Find "IDGemz Data Sync" and click "Edit App"'); 
  console.log('3. Check these under "Roles"/"Data Access":');
  console.log('   ✓ Product Listing (to read your catalog)');
  console.log('   ✓ Orders (to read order data)');
  console.log('   ✓ Inventory (to read stock levels)');
  console.log('   ✓ Buyer Communication (if you want to manage messages)');
  console.log('4. Make sure "App Status" shows "Published" not "Draft"');
  console.log('5. If you just made changes, wait 10 minutes and try again');
}

diagnose().catch(console.error);