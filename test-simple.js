const { SellingPartner } = require('amazon-sp-api');
require('dotenv').config();

// Read the refresh token directly from the file
const fs = require('fs');
const amazonKeys = fs.readFileSync('/Users/bbeaudoin/.config/amazon_keys.txt', 'utf8').trim();
// Extract refresh token (it's after "Refresh token:" line)
const refreshTokenMatch = amazonKeys.match(/Refresh token:\s*\n(.+)/);
const refreshToken = refreshTokenMatch ? refreshTokenMatch[1].trim() : null;

console.log('Using credentials:');
console.log('Client ID:', process.env.SELLING_PARTNER_APP_CLIENT_ID);
console.log('Client Secret:', process.env.SELLING_PARTNER_APP_CLIENT_SECRET ? '***' + process.env.SELLING_PARTNER_APP_CLIENT_SECRET.slice(-4) : 'NOT SET');
console.log('Refresh Token:', refreshToken ? refreshToken.substring(0, 20) + '...' : 'NOT SET');

async function test() {
  try {
    const spClient = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken
      // Let the library read credentials from env vars automatically
    });
    
    // Try the simplest possible call
    const result = await spClient.callAPI({
      endpoint: 'sellers',
      operation: 'getMarketplaceParticipations'
    });
    
    console.log('Success!', result);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response && error.response.data) {
      console.error('Details:', JSON.stringify(error.response.data, null, 2));
    }
    if (error.errors) {
      console.error('Errors:', error.errors);
    }
  }
}

test();