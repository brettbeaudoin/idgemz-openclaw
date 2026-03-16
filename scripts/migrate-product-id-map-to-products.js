#!/usr/bin/env node

/**
 * Migrates the legacy wide table public.product_id_map into the normalized:
 *   - public.products
 *   - public.product_identifiers
 *
 * Rules:
 * - One canonical product per distinct google_sheets_sku.
 * - The sheet header string is stored in product_identifiers as:
 *     id_type='google_sheet_sku', id_value=<header>
 * - Amazon SKU aliases are stored as:
 *     id_type='amazon_sku', id_value=<amazon sku>
 * - Idempotent: safe to re-run; uses existing rows when present.
 */

const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz'
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Pull source rows (Amazon only for now; extend later)
    const src = await client.query(
      `select id,
              product_name,
              google_sheets_sku,
              amazon_sku,
              amazon_asin,
              upc,
              notes,
              active
       from public.product_id_map
       where active = true`
    );

    // Build products keyed by google_sheets_sku
    const bySheetSku = new Map();
    for (const r of src.rows) {
      const sheetSku = (r.google_sheets_sku || '').trim();
      if (!sheetSku) continue;
      if (!bySheetSku.has(sheetSku)) bySheetSku.set(sheetSku, []);
      bySheetSku.get(sheetSku).push(r);
    }

    let productsCreated = 0;
    let identifiersCreated = 0;

    // Deduplicate creation count: if product already existed (via google_sheet_sku identifier), we don't count it.
    // (But if we had to create via internal_sku insertion above, we do.)

    for (const [sheetSku, rows] of bySheetSku.entries()) {
      // 1) Ensure product exists for this sheetSku
      // We key products by existence of product_identifiers google_sheet_sku.
      let productId = null;
      {
        const existing = await client.query(
          `select pi.product_id
           from public.product_identifiers pi
           where pi.id_type='google_sheet_sku' and pi.id_value=$1
           limit 1`,
          [sheetSku]
        );
        if (existing.rows.length) productId = existing.rows[0].product_id;
      }

      if (!productId) {
        // NOTE: public.products already exists in this DB and is used by inventory/channel_listings.
        // It requires internal_sku + title.
        const crypto = require('crypto');
        const slug = sheetSku
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 70);
        const h = crypto.createHash('md5').update(sheetSku).digest('hex').slice(0, 8);
        const internalSku = `sheet-${slug || 'sku'}-${h}`.slice(0, 100);
        const title = sheetSku;

        const ins = await client.query(
          `insert into public.products (internal_sku, title)
           values ($1, $2)
           on conflict (internal_sku) do update set title=excluded.title
           returning id`,
          [internalSku, title]
        );
        productId = ins.rows[0].id;
        productsCreated++;

        // Add google sheet sku identifier
        await client.query(
          `insert into public.product_identifiers (product_id, id_type, id_value, is_primary, notes)
           values ($1,'google_sheet_sku',$2,true,$3)
           on conflict (id_type, id_value) do nothing`,
          [productId, sheetSku, 'from product_id_map.google_sheets_sku']
        );
        identifiersCreated++;
      }

      // 2) Add identifiers from each row
      for (const r of rows) {
        const maybeInsert = async (idType, idValue, note) => {
          const v = (idValue || '').trim();
          if (!v) return;
          const res = await client.query(
            `insert into public.product_identifiers (product_id, id_type, id_value, is_primary, notes)
             values ($1,$2,$3,false,$4)
             on conflict (id_type, id_value) do nothing`,
            [productId, idType, v, note]
          );
          if (res.rowCount === 1) identifiersCreated++;
        };

        await maybeInsert('amazon_sku', r.amazon_sku, 'from product_id_map.amazon_sku');
        await maybeInsert('amazon_asin', r.amazon_asin, 'from product_id_map.amazon_asin');
        await maybeInsert('upc', r.upc, 'from product_id_map.upc');
      }
    }

    await client.query('COMMIT');

    console.log(`Migration complete.`);
    console.log(`- Source rows scanned: ${src.rows.length}`);
    console.log(`- Products created: ${productsCreated}`);
    console.log(`- Identifiers created: ${identifiersCreated}`);
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
