#!/usr/bin/env node

/*
Import Shopify Products CSV (Shopify admin export) into Postgres.

Updates:
- products: internal_sku (Variant SKU), title, base_cost (Cost per item), weight_grams (Variant Grams), color (if Option1 Name==Color), deprecated (Status==archived)
- channel_listings (shopify channel): channel_sku (Variant SKU), title, price (Variant Price), status (active/draft/archived), listing_id (Handle), url (shop domain + /products/<handle>)

Usage:
  node scripts/import-shopify-products-csv.js /path/to/shopify_products.csv

Notes:
- Only rows with a non-empty Variant SKU are imported.
- This is intended to keep product/catalog metadata aligned for reporting + sheet sync.
*/

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/import-shopify-products-csv.js <shopify_products.csv>');
  process.exit(1);
}

function splitCsvLine(line) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function toNum(x) {
  const s = String(x ?? '').trim();
  if (!s || s === '--') return null;
  const cleaned = s.replace(/[$,]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normStatus(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'active' || s === 'archived' || s === 'draft') return s;
  return s;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

  const ch = await pool.query("select id from channels where platform='shopify' order by updated_at desc nulls last limit 1");
  if (!ch.rows.length) throw new Error('No shopify channel in channels table');
  const channelId = ch.rows[0].id;

  const shopDomain = process.env.SHOPIFY_SHOP ? `https://${process.env.SHOPIFY_SHOP}` : null;

  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV appears empty');

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => header.indexOf(name);

  const iHandle = idx('Handle');
  const iTitle = idx('Title');
  const iOpt1Name = idx('Option1 Name');
  const iOpt1Val = idx('Option1 Value');
  const iVariantSku = idx('Variant SKU');
  const iVariantGrams = idx('Variant Grams');
  const iVariantPrice = idx('Variant Price');
  const iCostPerItem = idx('Cost per item');
  const iStatus = idx('Status');

  const required = ['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Status'];
  for (const r of required) {
    if (idx(r) === -1) throw new Error(`CSV missing required column: ${r}`);
  }

  let processed = 0;
  let skipped = 0;

  await pool.query('begin');
  try {
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const sku = String(cols[iVariantSku] || '').trim();
      if (!sku) { skipped++; continue; }

      const title = String(cols[iTitle] || '').trim() || sku;
      const status = normStatus(cols[iStatus]);
      const deprecated = status === 'archived';

      const grams = toNum(cols[iVariantGrams]);
      const cost = toNum(cols[iCostPerItem]);
      const price = toNum(cols[iVariantPrice]);

      let color = null;
      const opt1Name = String(cols[iOpt1Name] || '').trim().toLowerCase();
      const opt1Val = String(cols[iOpt1Val] || '').trim();
      if (opt1Name === 'color' && opt1Val) color = opt1Val;

      const handle = iHandle >= 0 ? String(cols[iHandle] || '').trim() : '';
      const url = (shopDomain && handle) ? `${shopDomain}/products/${handle}` : null;

      const prod = await pool.query(
        `insert into products (internal_sku, title, base_cost, weight_grams, color, deprecated)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (internal_sku) do update set
           title = excluded.title,
           base_cost = coalesce(excluded.base_cost, products.base_cost),
           weight_grams = coalesce(excluded.weight_grams, products.weight_grams),
           color = coalesce(excluded.color, products.color),
           deprecated = excluded.deprecated,
           updated_at = now()
         returning id`,
        [sku, title, cost, grams != null ? Math.round(grams) : null, color, deprecated]
      );

      await pool.query(
        `insert into channel_listings (product_id, channel_id, channel_sku, listing_id, title, price, status, url, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
         on conflict (channel_id, channel_sku) do update set
           product_id = excluded.product_id,
           listing_id = coalesce(excluded.listing_id, channel_listings.listing_id),
           title = excluded.title,
           price = coalesce(excluded.price, channel_listings.price),
           status = coalesce(excluded.status, channel_listings.status),
           url = coalesce(excluded.url, channel_listings.url),
           updated_at = now()`,
        [prod.rows[0].id, channelId, sku, handle || null, title, price, status || 'active', url]
      );

      processed++;
    }

    await pool.query('commit');
  } catch (e) {
    await pool.query('rollback');
    throw e;
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify({
    csv: csvPath,
    channelId,
    processed,
    skipped
  }, null, 2));
})().catch((e) => {
  console.error('import-shopify-products-csv failed:', e?.stack || e);
  process.exit(1);
});
