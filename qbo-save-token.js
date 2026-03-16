// Save a QBO realmId + refreshToken into the existing encrypted token file format
// used by qbo-client.js (AES-256-GCM).
//
// Usage:
//   node qbo-save-token.js --realmId <REALMID> --refreshToken <REFRESH_TOKEN>

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    out[k] = v;
    i++;
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const realmId = String(args.realmId || '').trim();
  const refreshToken = String(args.refreshToken || '').trim();

  if (!realmId) throw new Error('Missing --realmId');
  if (!refreshToken) throw new Error('Missing --refreshToken');

  const key = ensureKey();

  const payload = {
    realmId,
    refresh_token: refreshToken,
    obtainedAt: new Date().toISOString(),
    // access_token will be obtained by refresh flow in qbo-client.js
    access_token: null,
    expires_at: null,
    scopes: 'com.intuit.quickbooks.accounting',
    // Some clients like having this populated
    token_type: 'bearer'
  };

  const enc = encryptJson(payload, key);
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(enc, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch {}

  console.log('✅ Saved encrypted QBO token to:', TOKEN_PATH);
  console.log('realmId:', realmId);
})();
