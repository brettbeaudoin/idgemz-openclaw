// Sync "On-Hand Inventory" Google Sheet tab -> Postgres inventory (local/home)
//
// Sheet format:
//   Col A: "SKU From Sheet" (google_sheet_sku header name)
//   Col B: "On-Hand" (integer)
//
// We map SKU From Sheet -> product_id via product_identifiers(id_type='google_sheet_sku').
// Then upsert into public.inventory for channel platform='local' (created if missing)
// and warehouse_location='home'.

require('dotenv').config();

const { Pool } = require('pg');
const { execFileSync } = require('child_process');

const SHEET_ID = process.env.SHEET_ID || '1HoedZLqY6iq3hIKJLq2-qIAEiKuyoQdWflu7bozWpKg';
const TAB = 'On-Hand Inventory';
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

function parseIntSafe(x) {
  const s = String(x ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function ensureLocalChannel(pool) {
  const existing = await pool.query(`SELECT id FROM public.channels WHERE platform='local' LIMIT 1`);
  if (existing.rows.length) return existing.rows[0].id;

  const ins = await pool.query(
    `INSERT INTO public.channels (id, platform, name)
     VALUES (uuid_generate_v4(), 'local', 'On-Hand (Home)')
     RETURNING id`
  );
  return ins.rows[0].id;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });
  try {
    const localChannelId = await ensureLocalChannel(pool);

    // Read a generous window; stop on blank SKU rows.
    const values = gogSheetsGet(`${TAB}!A1:B500`);
    if (!values.length) throw new Error(`No data found in tab: ${TAB}`);

    const header = values[0] || [];
    const idxSku = header.findIndex((h) => String(h).trim().toLowerCase() === 'sku from sheet');
    const idxQty = header.findIndex((h) => String(h).trim().toLowerCase() === 'on-hand');
    if (idxSku < 0 || idxQty < 0) {
      throw new Error(`Expected headers "SKU From Sheet" and "On-Hand" in ${TAB}!A1:B1, got: ${JSON.stringify(header)}`);
    }

    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i] || [];
      const sku = String(r[idxSku] ?? '').trim();
      if (!sku) continue;
      const qty = parseIntSafe(r[idxQty]);
      if (qty == null) continue;
      rows.push({ sku, qty });
    }

    if (!rows.length) {
      console.log('No inventory rows found to import.');
      return;
    }

    // Load mapping sku->product_id
    const skus = rows.map((x) => x.sku);
    const mapRes = await pool.query(
      `SELECT id_value AS sheet_sku, product_id
       FROM public.product_identifiers
       WHERE id_type='google_sheet_sku'
         AND active=true
         AND id_value = ANY($1::text[])`,
      [skus]
    );
    const skuToProduct = new Map(mapRes.rows.map((r) => [String(r.sheet_sku), String(r.product_id)]));

    const missing = [];
    let upserts = 0;

    await pool.query('BEGIN');

    for (const { sku, qty } of rows) {
      const productId = skuToProduct.get(sku);
      if (!productId) {
        missing.push(sku);
        continue;
      }

      await pool.query(
        `INSERT INTO public.inventory (product_id, channel_id, warehouse_location, quantity_available, quantity_reserved, quantity_inbound, last_updated)
         VALUES ($1, $2, 'home', $3, 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id, channel_id, warehouse_location)
         DO UPDATE SET quantity_available=EXCLUDED.quantity_available,
                       quantity_reserved=0,
                       quantity_inbound=0,
                       last_updated=CURRENT_TIMESTAMP`,
        [productId, localChannelId, qty]
      );
      upserts++;
    }

    await pool.query('COMMIT');

    console.log(`Imported on-hand inventory: ${upserts} rows upserted into public.inventory (channel=local, warehouse_location=home).`);
    if (missing.length) {
      console.log(`Warning: ${missing.length} SKUs in sheet had no google_sheet_sku mapping in Postgres (skipped):`);
      console.log(missing.sort().join(', '));
    }
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('sync-on-hand-inventory failed:', e?.stack || e);
  process.exit(1);
});
