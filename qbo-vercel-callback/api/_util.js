const crypto = require('crypto');

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Base64Url(s) {
  return base64url(crypto.createHash('sha256').update(s).digest());
}

function randomBase64Url(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

module.exports = {
  base64url,
  sha256Base64Url,
  randomBase64Url,
  parseCookies
};
