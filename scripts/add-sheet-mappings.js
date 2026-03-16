#!/usr/bin/env node

// Add/ensure google_sheet_sku + amazon_sku mappings in normalized product_identifiers.
// This is for mappings that existed in amazon-sheet-orders-sync.js hardcoded list
// but were missing from sheet-sku-mapping.json.

const crypto = require('crypto');
const { Client } = require('pg');

function makeInternalSku(sheetSku) {
  const slug = sheetSku
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  const h = crypto.createHash('md5').update(sheetSku).digest('hex').slice(0, 8);
  return `sheet-${slug || 'sku'}-${h}`.slice(0, 100);
}

const mappings = [
  { amazon_sku: 'BHT1STE-V2', sheet: 'BH-T1 RSA Stealth V2' },
  { amazon_sku: 'BHT1STE-YUBI-V2', sheet: 'BH-T1 Yubi V2' },
  { amazon_sku: 'BHT1DF', sheet: 'BH-T1-DF' },
  { amazon_sku: 'BHT1FLAG-V2', sheet: 'BH-T1 RSA Flag V2' }
];

async function ensureProductForSheet(client, sheetSku) {
  // If google_sheet_sku identifier exists, return its product_id.
  const ex = await client.query(
    `select product_id from product_identifiers where id_type='google_sheet_sku' and id_value=$1 limit 1`,
    [sheetSku]
  );
  if (ex.rows.length) return ex.rows[0].product_id;

  // Create product row
  const internalSku = makeInternalSku(sheetSku);
  const ins = await client.query(
    `insert into products (internal_sku, title)
     values ($1,$2)
     on conflict (internal_sku) do update set title=excluded.title
     returning id`,
    [internalSku, sheetSku]
  );
  const productId = ins.rows[0].id;

  // Add google_sheet_sku identifier
  await client.query(
    `insert into product_identifiers (product_id,id_type,id_value,is_primary,notes)
     values ($1,'google_sheet_sku',$2,true,'added for Postgres→Sheet sync')
     on conflict (id_type,id_value) do nothing`,
    [productId, sheetSku]
  );

  return productId;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });
  await client.connect();
  try {
    await client.query('BEGIN');
    let added = 0;

    for (const m of mappings) {
      const productId = await ensureProductForSheet(client, m.sheet);
      const res = await client.query(
        `insert into product_identifiers (product_id,id_type,id_value,is_primary,notes)
         values ($1,'amazon_sku',$2,false,'added for Postgres→Sheet sync')
         on conflict (id_type,id_value) do nothing`,
        [productId, m.amazon_sku]
      );
      added += res.rowCount;
    }

    await client.query('COMMIT');
    console.log(`Added ${added} amazon_sku identifiers (and created any missing products/sheet identifiers).`);
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
