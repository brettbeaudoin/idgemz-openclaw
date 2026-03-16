// QuickBooks Online OAuth helper (local)
// Redirect URI: http://localhost:3000/callback
//
// Usage:
//   node qbo-oauth-server.js
// Then open the printed auth URL, approve, and the callback will store tokens.

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
const express = require('express');
const crypto = require('crypto');

const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || 'http://localhost:3000/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing QBO_CLIENT_ID or QBO_CLIENT_SECRET in .env.local');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');

const TOKEN_PATH = process.env.QBO_TOKEN_PATH || path.resolve(__dirname, '../memory/qbo-token.enc.json');
const KEY_PATH = process.env.QBO_KEY_PATH || path.resolve(__dirname, '../memory/qbo-token.key');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function ensureKey() {
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  if (fs.existsSync(KEY_PATH)) {
    const b64 = fs.readFileSync(KEY_PATH, 'utf8').trim();
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Invalid key length in ${KEY_PATH} (expected 32 bytes)`);
    return key;
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  try { fs.chmodSync(KEY_PATH, 0o600); } catch {}
  return key;
}

function encryptJson(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

const app = express();

app.get('/', (req, res) => {
  res.status(200).send('QuickBooks OAuth helper is running. Use the Auth URL shown in the terminal.');
});

app.get('/connected', (req, res) => {
  res.status(200).send('✅ Connected to QuickBooks. You can close this tab.');
});

const state = base64url(crypto.randomBytes(16));
const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

const scopes = [
  'com.intuit.quickbooks.accounting'
].join(' ');

const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scopes);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

console.log('QuickBooks OAuth setup');
console.log('Redirect URI:', REDIRECT_URI);
console.log('Token path (encrypted):', TOKEN_PATH);
console.log('Key path:', KEY_PATH);
console.log('Auth URL (open in browser):\n', authUrl.toString(), '\n');

app.get('/callback', async (req, res) => {
  try {
    const { code, realmId, state: returnedState, error, error_description } = req.query;

    if (error) {
      res.status(400).send(`OAuth error: ${error}\n${error_description || ''}`);
      return;
    }

    if (!code || !realmId) {
      res.status(400).send('Missing code or realmId in callback');
      return;
    }

    if (returnedState !== state) {
      res.status(400).send('State mismatch. Aborting.');
      return;
    }

    // Exchange code for tokens
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier
    });

    const fetch = global.fetch || (await import('node-fetch')).default;
    const tokenResp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const text = await tokenResp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!tokenResp.ok) {
      res.status(500).send(`Token exchange failed (${tokenResp.status}):\n${text}`);
      return;
    }

    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });

    const key = ensureKey();

    const payload = {
      realmId: String(realmId),
      obtainedAt: new Date().toISOString(),
      scopes,
      ...json
    };

    const enc = encryptJson(payload, key);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(enc, null, 2), { mode: 0o600 });
    try { fs.chmodSync(TOKEN_PATH, 0o600); } catch {}

    // IMPORTANT: do not return HTML that could leak sensitive URL params via Referer.
    // Redirect to a safe page.
    res.status(302).set('Location', '/connected').send();

    console.log('✅ Encrypted tokens saved to', TOKEN_PATH);
    console.log('realmId:', realmId);

    // shut down shortly
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal error. See console.');
  }
});

app.listen(3000, '127.0.0.1', () => {
  console.log('Listening on http://127.0.0.1:3000 ...');
});
