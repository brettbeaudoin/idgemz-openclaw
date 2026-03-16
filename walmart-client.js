require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stableJson(x) {
  return JSON.stringify(x, null, 2);
}

class WalmartClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || process.env.WALMART_BASE_URL || 'https://marketplace.walmartapis.com';
    this.clientId = opts.clientId || process.env.WALMART_CLIENT_ID;
    this.clientSecret = opts.clientSecret || process.env.WALMART_CLIENT_SECRET;
    this.sellerId = opts.sellerId || process.env.WALMART_SELLER_ID;
    // Some endpoints require channel type header. In many implementations this is the Client ID.
    this.consumerChannelType = opts.consumerChannelType || process.env.WALMART_CONSUMER_CHANNEL_TYPE || this.clientId;
    this.serviceName = opts.serviceName || process.env.WALMART_SERVICE_NAME || 'Walmart Marketplace';

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Missing WALMART_CLIENT_ID/WALMART_CLIENT_SECRET');
    }

    this.tokenCachePath = opts.tokenCachePath || path.resolve(__dirname, '.cache', 'walmart-token.json');
    ensureDir(path.dirname(this.tokenCachePath));
  }

  _basicAuth() {
    const creds = `${this.clientId}:${this.clientSecret}`;
    return Buffer.from(creds, 'utf8').toString('base64');
  }

  _loadCachedToken() {
    try {
      if (!fs.existsSync(this.tokenCachePath)) return null;
      const j = JSON.parse(fs.readFileSync(this.tokenCachePath, 'utf8'));
      return j;
    } catch {
      return null;
    }
  }

  _saveCachedToken(tok) {
    fs.writeFileSync(this.tokenCachePath, stableJson(tok));
  }

  async getAccessToken() {
    const cached = this._loadCachedToken();
    const safetyMs = 60 * 1000;
    if (cached?.access_token && cached?.expires_at_ms && cached.expires_at_ms - safetyMs > nowMs()) {
      return cached.access_token;
    }

    const url = `${this.baseUrl}/v3/token`;
    const body = new URLSearchParams({ grant_type: 'client_credentials' }).toString();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this._basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'WM_SVC.NAME': this.serviceName,
        'WM_QOS.CORRELATION_ID': this._correlationId(),
        'WM_CONSUMER.CHANNEL.TYPE': this.consumerChannelType
      },
      body
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Walmart token error ${res.status}: ${text}`);
    }

    const json = await res.json();
    const expiresInSec = Number(json.expires_in || json.expiresIn || 0);
    const expiresAt = nowMs() + Math.max(0, expiresInSec) * 1000;

    const tok = {
      access_token: json.access_token,
      token_type: json.token_type,
      expires_in: expiresInSec,
      scope: json.scope,
      fetched_at_ms: nowMs(),
      expires_at_ms: expiresAt
    };

    this._saveCachedToken(tok);
    return tok.access_token;
  }

  _correlationId() {
    // 16 bytes hex is fine for tracing
    return crypto.randomBytes(16).toString('hex');
  }

  async request(pathname, { method = 'GET', query = null, body = null, headers = {}, timeoutMs = 60000 } = {}) {
    const token = await this.getAccessToken();

    const url = new URL(this.baseUrl + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const wmHeaders = {
      Accept: 'application/json',
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_QOS.CORRELATION_ID': this._correlationId(),
      'WM_SVC.NAME': this.serviceName,
      'WM_CONSUMER.CHANNEL.TYPE': this.consumerChannelType,
      ...headers
    };

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: wmHeaders,
        body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal
      });

      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok) {
        throw new Error(`Walmart API ${method} ${pathname} ${res.status}: ${text}`);
      }

      return { res, text, json };
    } finally {
      clearTimeout(to);
    }
  }

  // ---- High-level helpers ----

  async listOrders({ createdStartDate, createdEndDate, limit = 200, nextCursor = null, status = null } = {}) {
    const query = {
      createdStartDate,
      createdEndDate,
      limit,
      status,
    };
    if (nextCursor) query.nextCursor = nextCursor;
    return this.request('/v3/orders', { query });
  }

  async getOrder(purchaseOrderId) {
    return this.request(`/v3/orders/${encodeURIComponent(purchaseOrderId)}`);
  }
}

module.exports = { WalmartClient };
