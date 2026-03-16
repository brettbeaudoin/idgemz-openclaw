const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Prefer .env.local (developer secrets), fall back to .env
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config();

const app = express();

const PORT = process.env.SHOPIFY_OAUTH_PORT || 8088;
const SHOP = process.env.SHOPIFY_SHOP; // e.g. your-store.myshopify.com
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';
const SCOPES = process.env.SHOPIFY_SCOPES || 'read_orders,read_products,read_inventory,read_customers';
const REDIRECT_URI = process.env.SHOPIFY_REDIRECT_URI || `http://localhost:${PORT}/shopify/callback`;

const ENV_LOCAL_PATH = path.resolve(__dirname, '.env.local');

function requireEnv(name, val) {
  if (!val) {
    throw new Error(`Missing required env var ${name}`);
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyHmac(query, clientSecret) {
  // Shopify HMAC verification for OAuth callback
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return `${key}=${value}`;
    })
    .join('&');

  const digest = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  return timingSafeEqual(digest, hmac);
}

function upsertEnvVar(contents, key, value) {
  const line = `${key}=${JSON.stringify(value)}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(contents)) return contents.replace(re, line);
  const suffix = contents.endsWith('\n') || contents.length === 0 ? '' : '\n';
  return contents + suffix + line + '\n';
}

function saveToEnvLocal(kv) {
  let contents = '';
  if (fs.existsSync(ENV_LOCAL_PATH)) contents = fs.readFileSync(ENV_LOCAL_PATH, 'utf8');

  for (const [k, v] of Object.entries(kv)) {
    contents = upsertEnvVar(contents, k, v);
  }

  fs.writeFileSync(ENV_LOCAL_PATH, contents, 'utf8');
}

let lastState = null;

app.get('/', (req, res) => {
  res.type('html').send(`
    <h1>Shopify OAuth Setup</h1>
    <p><b>Shop:</b> ${SHOP || '(set SHOPIFY_SHOP)'}<br/>
       <b>Scopes:</b> ${SCOPES}<br/>
       <b>Redirect:</b> ${REDIRECT_URI}</p>
    <p><a href="/shopify/auth">Authorize Shopify</a></p>
  `);
});

app.get('/shopify/auth', (req, res) => {
  try {
    requireEnv('SHOPIFY_SHOP', SHOP);
    requireEnv('SHOPIFY_CLIENT_ID', CLIENT_ID);
    requireEnv('SHOPIFY_CLIENT_SECRET', CLIENT_SECRET);

    lastState = crypto.randomBytes(16).toString('hex');
    const authorizeUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${encodeURIComponent(lastState)}`;

    res.redirect(authorizeUrl);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.get('/shopify/callback', async (req, res) => {
  try {
    requireEnv('SHOPIFY_SHOP', SHOP);
    requireEnv('SHOPIFY_CLIENT_ID', CLIENT_ID);
    requireEnv('SHOPIFY_CLIENT_SECRET', CLIENT_SECRET);

    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    if (!state || !lastState || state !== lastState) {
      return res.status(400).send('Invalid state');
    }

    if (!verifyHmac(req.query, CLIENT_SECRET)) {
      return res.status(400).send('HMAC verification failed');
    }

    const tokenResp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code
      })
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) return res.status(400).send(`No access_token in response: ${JSON.stringify(tokenData)}`);

    saveToEnvLocal({
      SHOPIFY_SHOP: SHOP,
      SHOPIFY_ACCESS_TOKEN: accessToken,
      SHOPIFY_API_VERSION: API_VERSION,
      SHOPIFY_SCOPES: SCOPES,
      SHOPIFY_REDIRECT_URI: REDIRECT_URI
    });

    // Probe shop endpoint
    const shopResp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    const shopJson = await shopResp.json();

    res.type('html').send(`
      <h1>Success</h1>
      <p>Saved SHOPIFY_ACCESS_TOKEN to <code>.env.local</code>.</p>
      <pre>${JSON.stringify(shopJson, null, 2)}</pre>
      <p>You can close this window.</p>
    `);

  } catch (e) {
    res.status(500).send(e.stack || e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Shopify OAuth server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to authorize.`);
});
