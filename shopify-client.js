const fetch = require('node-fetch');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLinkHeader(link) {
  // <url>; rel="next", <url>; rel="previous"
  if (!link) return {};
  const out = {};
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

class ShopifyClient {
  constructor({ shop, accessToken, apiVersion }) {
    if (!shop) throw new Error('Missing shop');
    if (!accessToken) throw new Error('Missing accessToken');
    this.shop = shop;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion || '2026-01';
  }

  async request(path, { method = 'GET', query = {}, body = null, retries = 8 } = {}) {
    const url = new URL(`https://${this.shop}/admin/api/${this.apiVersion}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    while (true) {
      attempt++;
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Rate limiting: 429 or 5xx
      if ((resp.status === 429 || resp.status >= 500) && attempt <= retries) {
        const ra = resp.headers.get('retry-after');
        const waitMs = ra ? (parseFloat(ra) * 1000) : Math.min(30000, 500 * Math.pow(2, attempt));
        await sleep(waitMs);
        continue;
      }

      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}

      if (!resp.ok) {
        const msg = json?.errors ? JSON.stringify(json.errors) : (text || resp.statusText);
        const err = new Error(`Shopify HTTP ${resp.status}: ${msg}`);
        err.status = resp.status;
        err.body = json || text;
        throw err;
      }

      return { json, headers: resp.headers };
    }
  }

  async *paginate(path, { query = {}, rootKey, limit = 250 } = {}) {
    // Shopify REST cursor pagination uses page_info in Link header
    let nextUrl = null;
    let first = true;

    while (true) {
      let res;
      if (first) {
        first = false;
        res = await this.request(path, { query: { ...query, limit } });
      } else {
        // nextUrl already includes full URL + query
        const resp = await fetch(nextUrl, {
          headers: {
            'X-Shopify-Access-Token': this.accessToken,
            'Accept': 'application/json'
          }
        });
        if (resp.status === 429) {
          const ra = resp.headers.get('retry-after');
          const waitMs = ra ? (parseFloat(ra) * 1000) : 1500;
          await sleep(waitMs);
          continue;
        }
        const text = await resp.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (!resp.ok) {
          throw new Error(`Shopify HTTP ${resp.status}: ${text || resp.statusText}`);
        }
        res = { json, headers: resp.headers };
      }

      const data = rootKey ? res.json?.[rootKey] : res.json;
      if (Array.isArray(data)) {
        for (const item of data) yield item;
      } else if (data != null) {
        yield data;
      }

      const links = parseLinkHeader(res.headers.get('link'));
      if (!links.next) break;
      nextUrl = links.next;
    }
  }
}

module.exports = { ShopifyClient };
