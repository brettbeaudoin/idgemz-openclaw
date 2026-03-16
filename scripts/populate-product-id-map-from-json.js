#!/usr/bin/env node

// Populate public.product_id_map from sheet-sku-mapping.json (Amazon channel only for now)
// Idempotent-ish: will not insert duplicate (amazon_sku, google_sheets_sku) pairs.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const JSON_PATH = path.resolve(__dirname, '..', 'sheet-sku-mapping.json');

async function main() {
  const j = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const amazon = j?.channels?.Amazon || {};

  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz'
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Create a temp table of existing pairs for quick check
    const existingRes = await client.query(
      `select amazon_sku, google_sheets_sku
       from public.product_id_map
       where amazon_sku is not null and google_sheets_sku is not null`
    );
    const existing = new Set(existingRes.rows.map(r => `${r.amazon_sku}|||${r.google_sheets_sku}`));

    let inserted = 0;
    for (const [amazon_sku, google_sheets_sku] of Object.entries(amazon)) {
      const key = `${amazon_sku}|||${google_sheets_sku}`;
      if (existing.has(key)) continue;

      // product_name: best-effort = the sheet header name for now.
      await client.query(
        `insert into public.product_id_map (
           product_name,
           google_sheets_sku,
           amazon_sku,
           notes,
           active
         ) values ($1,$2,$3,$4,true)`,
        [google_sheets_sku, google_sheets_sku, amazon_sku, 'seeded from idgemz-sync/sheet-sku-mapping.json']
      );
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`Inserted ${inserted} rows into public.product_id_map from ${path.basename(JSON_PATH)} (Amazon channel).`);
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
