const express = require('express');
const { SellingPartnerAPI } = require('amazon-sp-api');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Store this in a secure way in production
let refreshToken = null;

// Step 1: Generate OAuth URL
app.get('/', (req, res) => {
  const oauthUrl = `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${process.env.SELLING_PARTNER_APP_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}`;
  
  res.send(`
    <h1>IDGemz Amazon SP-API Setup</h1>
    <p>Click the link below to authorize the app in your Amazon Seller Central account:</p>
    <a href="${oauthUrl}" target="_blank">Authorize Amazon Access</a>
    <br><br>
    <p>After authorizing, you'll be redirected back here with your credentials.</p>
  `);
});

// Step 2: Handle OAuth callback
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization failed: No code received');
  }

  try {
    // Exchange authorization code for refresh token
    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI,
        client_id: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        client_secret: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
      })
    });

    const tokenData = await tokenResponse.json();
    
    if (tokenData.refresh_token) {
      refreshToken = tokenData.refresh_token;
      
      // Save to database
      await pool.query(`
        UPDATE channels 
        SET api_connected = true, 
            api_credentials = $1,
            last_sync_at = CURRENT_TIMESTAMP
        WHERE platform = 'amazon'
      `, [JSON.stringify({ refreshToken: tokenData.refresh_token })]);
      
      res.send(`
        <h1>Success!</h1>
        <p>Amazon SP-API has been connected successfully.</p>
        <p>Refresh Token saved to database.</p>
        <br>
        <a href="/test">Test API Connection</a>
      `);
    } else {
      res.status(400).send('Failed to get refresh token: ' + JSON.stringify(tokenData));
    }
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('OAuth error: ' + error.message);
  }
});

// Step 3: Test the API connection
app.get('/test', async (req, res) => {
  try {
    // Get refresh token from database
    const result = await pool.query(`
      SELECT api_credentials 
      FROM channels 
      WHERE platform = 'amazon' AND api_connected = true
    `);
    
    if (!result.rows.length) {
      return res.status(400).send('No Amazon connection found. Please authorize first.');
    }
    
    const { refreshToken } = result.rows[0].api_credentials;
    
    // Initialize SP-API client
    const sellingPartner = new SellingPartnerAPI({
      region: 'na', // North America
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SELLING_PARTNER_ROLE: process.env.AWS_SELLING_PARTNER_ROLE
      }
    });
    
    // Test with a simple API call
    const orders = await sellingPartner.callAPI({
      operation: 'getOrders',
      query: {
        MarketplaceIds: ['ATVPDKIKX0DER'], // US marketplace
        CreatedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // Last 7 days
      }
    });
    
    res.json({
      success: true,
      message: 'API connection successful!',
      ordersFound: orders.Orders ? orders.Orders.length : 0
    });
    
  } catch (error) {
    console.error('API test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`OAuth server running at http://localhost:${port}`);
  console.log(`Visit http://localhost:${port} to start the authorization process`);
});