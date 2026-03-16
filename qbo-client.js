// Minimal QuickBooks Online client helpers (token decrypt + refresh)
// Token files are produced by qbo-oauth-server.js

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;

const TOKEN_PATH = process.env.QBO_TOKEN_PATH || path.resolve(__dirname, '../memory/qbo-token.enc.json');
const KEY_PATH = process.env.QBO_KEY_PATH || path.resolve(__dirname, '../memory/qbo-token.key');

function decryptJson(enc, key) {
  if (!enc || enc.alg !== 'aes-256-gcm') throw new Error('Unsupported token file format');
  const iv = Buffer.from(enc.iv, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function loadToken() {
  const key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  const enc = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  return decryptJson(enc, key);
}

function saveToken(token) {
  // Preserve encryption format by reusing existing key
  const key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(token), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const enc = {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(enc, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch {}
}

async function refreshAccessToken(refreshToken) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(`refresh_token failed (${resp.status}): ${text}`);
  return json;
}

async function getValidAccessToken() {
  const t = loadToken();

  // If expires_at exists and is still valid, use it.
  const nowMs = Date.now();
  const skewMs = 60_000; // 60s

  if (t.expires_at) {
    const expMs = new Date(t.expires_at).getTime();
    if (Number.isFinite(expMs) && expMs - skewMs > nowMs) {
      return { accessToken: t.access_token, realmId: t.realmId, token: t };
    }
  }

  // Otherwise refresh.
  const refreshed = await refreshAccessToken(t.refresh_token);
  const expiresIn = refreshed.expires_in || 3600;
  const newToken = {
    ...t,
    ...refreshed,
    obtainedAt: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
  saveToken(newToken);
  return { accessToken: newToken.access_token, realmId: newToken.realmId, token: newToken };
}

async function qboQuery({ realmId, accessToken, query, minorversion = 73 }) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/query?minorversion=${minorversion}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/text',
      Accept: 'application/json'
    },
    body: query
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const tid = resp.headers.get('intuit_tid');
    const msg = JSON.stringify(json).slice(0, 8000);
    throw new Error(`QBO query failed (${resp.status}) intuit_tid=${tid || 'n/a'}: ${msg}`);
  }
  return { json, intuit_tid: resp.headers.get('intuit_tid') };
}

module.exports = {
  loadToken,
  getValidAccessToken,
  qboQuery
};
