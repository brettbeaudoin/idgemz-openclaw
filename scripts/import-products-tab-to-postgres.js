#!/usr/bin/env node

/**
 * Import NerdWidgets Google Sheet "Products" tab into Postgres:
 * - Adds product_identifiers for amazon_sku, amazon_asin, upc, amazon_fnsku
 * - Updates products fields: title, color, token_count, token_types (material already exists)
 *
 * Idempotent:
 * - Uses UNIQUE(id_type,id_value) on product_identifiers
 * - Will not create duplicates
 * - Will update existing products when matched by amazon_sku identifier
 */

require('dotenv').config();

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const SHEET_ID = process.env.SHEET_ID || '1HoedZLqY6iq3hIKJLq2-qIAEiKuyoQdWflu7bozWpKg';
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

function gogSheetsGet(rangeA1) {
  const out = execFileSync('gog', ['sheets', 'get', SHEET_ID, rangeA1, '--account', GOG_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000
  });
  const j = JSON.parse(out);
  return j.values || [];
}

function makeInternalSkuFromAmazonSku(amazonSku) {
  const base = String(amazonSku || '').trim();
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  const h = crypto.createHash('md5').update(base).digest('hex').slice(0, 8);
  return `amz-${slug || 'sku'}-${h}`.slice(0, 100);
}

function cleanVal(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase() === 'n/a') return null;
  return s;
}

async function ensureProductByAmazonSku(client, amazonSku, title) {
  // Find existing product_id by amazon_sku identifier
  const ex = await client.query(
    `select product_id from product_identifiers where id_type='amazon_sku' and id_value=$1 limit 1`,
    [amazonSku]
  );
  if (ex.rows.length) return ex.rows[0].product_id;

  // Create new product
  const internalSku = makeInternalSkuFromAmazonSku(amazonSku);
  const ins = await client.query(
    `insert into products (internal_sku, title)
     values ($1,$2)
     on conflict (internal_sku) do update set title=excluded.title
     returning id`,
    [internalSku, title || amazonSku]
  );
  const productId = ins.rows[0].id;

  // Add amazon_sku identifier
  await client.query(
    `insert into product_identifiers (product_id,id_type,id_value,is_primary,notes)
     values ($1,'amazon_sku',$2,true,'imported from Sheet Products tab')
     on conflict (id_type,id_value) do nothing`,
    [productId, amazonSku]
  );

  return productId;
}

async function addIdentifier(client, productId, idType, idValue) {
  const v = cleanVal(idValue);
  if (!v) return 0;
  const res = await client.query(
    `insert into product_identifiers (product_id,id_type,id_value,is_primary,notes)
     values ($1,$2,$3,false,'imported from Sheet Products tab')
     on conflict (id_type,id_value) do nothing`,
    [productId, idType, v]
  );
  return res.rowCount;
}

async function main() {
  const rows = gogSheetsGet('Products!A1:H2000');
  if (!rows.length) throw new Error('No rows read from Products tab');

  const header = rows[0].map(String);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const required = ['SKU', 'FNSKU', 'ASIN', 'UPC', 'Title', 'Color', 'Token Count', 'Token Types'];
  for (const r of required) {
    if (idx[r] == null) throw new Error(`Products tab missing column: ${r}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });
  await client.connect();

  let seen = 0;
  let productsTouched = 0;
  let identifiersAdded = 0;

  try {
    await client.query('BEGIN');

    for (const r of rows.slice(1)) {
      const sku = cleanVal(r[idx['SKU']]);
      if (!sku) continue;
      seen++;

      const fnsku = cleanVal(r[idx['FNSKU']]);
      const asin = cleanVal(r[idx['ASIN']]);
      const upc = cleanVal(r[idx['UPC']]);
      const title = cleanVal(r[idx['Title']]);
      const color = cleanVal(r[idx['Color']]);
      const tokenCountRaw = cleanVal(r[idx['Token Count']]);
      const tokenTypes = cleanVal(r[idx['Token Types']]);
      const tokenCount = tokenCountRaw != null && /^\d+$/.test(tokenCountRaw) ? Number(tokenCountRaw) : null;

      const productId = await ensureProductByAmazonSku(client, sku, title);

      // Update product attributes (only set when present; do not blank existing)
      await client.query(
        `update products
         set title = coalesce($2, title),
             color = coalesce($3, color),
             token_count = coalesce($4, token_count),
             token_types = coalesce($5, token_types)
         where id=$1`,
        [productId, title, color, tokenCount, tokenTypes]
      );
      productsTouched++;

      identifiersAdded += await addIdentifier(client, productId, 'amazon_fnsku', fnsku);
      identifiersAdded += await addIdentifier(client, productId, 'amazon_asin', asin);
      identifiersAdded += await addIdentifier(client, productId, 'upc', upc);
    }

    await client.query('COMMIT');

    console.log('Import complete.');
    console.log(`- Sheet rows processed (non-empty SKU): ${seen}`);
    console.log(`- Products updated/touched: ${productsTouched}`);
    console.log(`- Identifiers inserted: ${identifiersAdded}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
