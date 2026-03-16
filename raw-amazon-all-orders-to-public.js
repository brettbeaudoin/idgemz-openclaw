// ETL: load raw.amazon_all_orders_all view into public schema (orders, products, channel_listings, order_items, amazon_orders)
// Idempotent: uses orders unique (channel_id, channel_order_id) and order_items unique (order_id, channel_line_item_id).
//
// Usage:
//   node raw-amazon-all-orders-to-public.js
//   DRY_RUN=1 node raw-amazon-all-orders-to-public.js
//
// Notes:
// - raw view columns are TEXT; we cast/parse conservatively.
// - channel_line_item_id is synthesized from the raw row so duplicates don't insert.

const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function num(x) {
  if (x == null) return null;
  const t = String(x).trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  const ch = await pool.query("select id from channels where platform='amazon' and api_connected=true order by name limit 1");
  if (!ch.rows.length) throw new Error('No connected Amazon channel found');
  const channelId = ch.rows[0].id;

  // Stream-ish batch loop
  const batchSize = parseInt(process.env.BATCH || '2000', 10);
  let offset = 0;

  let insertedOrders = 0;
  let insertedItems = 0;

  while (true) {
    const res = await pool.query(
      `select *
       from raw.amazon_all_orders_all
       order by purchase_date, amazon_order_id
       limit $1 offset $2`,
      [batchSize, offset]
    );

    if (!res.rows.length) break;

    if (!dryRun) await pool.query('BEGIN');
    try {
      for (const r of res.rows) {
        const amazonOrderId = (r.amazon_order_id || '').trim();
        if (!amazonOrderId) continue;

        // Parse timestamps (raw has UTC-ish strings; cast in SQL is easiest/strict)
        // We'll hand strings to Postgres and cast.
        const purchaseDate = r.purchase_date || null;
        const lastUpdatedDate = r.last_updated_date || null;

        const currency = (r.currency || 'USD').trim() || 'USD';
        const orderTotal = null; // flat file doesn't provide a single order total reliably.

        const shipAddr = {
          city: r.ship_city || null,
          state: r.ship_state || null,
          postal_code: r.ship_postal_code || null,
          country: r.ship_country || null
        };

        // Upsert order
        const orderUp = await pool.query(
          `insert into orders (
             channel_id, channel_order_id, order_date, order_total, currency,
             status, fulfillment_channel, shipping_address, external_updated_at
           ) values (
             $1, $2,
             nullif($3,'')::timestamptz,
             $4::numeric,
             $5,
             nullif($6,''),
             nullif($7,''),
             $8::jsonb,
             nullif($9,'')::timestamptz
           )
           on conflict (channel_id, channel_order_id)
           do update set
             order_date = coalesce(excluded.order_date, orders.order_date),
             currency = coalesce(excluded.currency, orders.currency),
             status = coalesce(excluded.status, orders.status),
             fulfillment_channel = coalesce(excluded.fulfillment_channel, orders.fulfillment_channel),
             shipping_address = coalesce(excluded.shipping_address, orders.shipping_address),
             external_updated_at = coalesce(excluded.external_updated_at, orders.external_updated_at),
             updated_at = now()
           returning id`,
          [
            channelId,
            amazonOrderId,
            purchaseDate,
            orderTotal,
            currency,
            r.order_status || null,
            r.fulfillment_channel || null,
            JSON.stringify(shipAddr),
            lastUpdatedDate
          ]
        );
        const orderId = orderUp.rows[0].id;
        insertedOrders++;

        // Product + listing
        const sku = (r.sku || '').trim();
        if (!sku) continue;
        const title = (r.product_name || '').trim() || 'Unknown Product';

        const prod = await pool.query(
          `insert into products (internal_sku, title)
           values ($1,$2)
           on conflict (internal_sku) do update set title=coalesce(excluded.title, products.title)
           returning id`,
          [sku, title]
        );
        const productId = prod.rows[0].id;

        const listing = await pool.query(
          `insert into channel_listings (product_id, channel_id, channel_sku, asin, title, price, status)
           values ($1,$2,$3,$4,$5,$6,'active')
           on conflict (channel_id, channel_sku)
           do update set asin=excluded.asin, title=excluded.title, price=excluded.price, updated_at=now()
           returning id`,
          [productId, channelId, sku, r.asin || null, title, num(r.item_price) || 0]
        );
        const listingId = listing.rows[0].id;

        // Synthesize a stable line item id from raw fields
        const lineKey = [amazonOrderId, sku, r.asin || '', r.purchase_date || '', r.item_status || '', r.promotion_ids || ''].join('|');
        const channelLineItemId = 'raw:' + md5(lineKey);

        const qty = parseInt((r.quantity || '0').trim() || '0', 10) || 0;

        const unitPrice = num(r.item_price) || 0;
        const shippingPrice = num(r.shipping_price) || 0;
        const tax = num(r.item_tax) || 0;
        const discount = num(r.item_promotion_discount) || 0;
        const total = unitPrice * qty + shippingPrice - discount;

        await pool.query(
          `insert into order_items (
             order_id, channel_listing_id, channel_line_item_id,
             quantity, unit_price, shipping_price, tax, discount, total, raw
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb
           )
           on conflict (order_id, channel_line_item_id)
           do update set
             quantity=excluded.quantity,
             unit_price=excluded.unit_price,
             shipping_price=excluded.shipping_price,
             tax=excluded.tax,
             discount=excluded.discount,
             total=excluded.total,
             raw=excluded.raw`,
          [
            orderId,
            listingId,
            channelLineItemId,
            qty,
            unitPrice,
            shippingPrice,
            tax,
            discount,
            total,
            JSON.stringify(r)
          ]
        );
        insertedItems++;

        // amazon_orders table (minimal fields from raw)
        await pool.query(
          `insert into amazon_orders (
             order_id, amazon_order_id, marketplace_id, last_update_date,
             sales_channel, order_channel, ship_service_level,
             is_business_order, raw, updated_at
           ) values (
             $1,$2,$3,
             nullif($4,'')::timestamptz,
             nullif($5,''), nullif($6,''), nullif($7,''),
             case when lower(nullif($8,'')) in ('true','t','yes','y','1') then true when lower(nullif($8,'')) in ('false','f','no','n','0') then false else null end,
             $9::jsonb,
             now()
           )
           on conflict (order_id)
           do update set
             last_update_date=coalesce(excluded.last_update_date, amazon_orders.last_update_date),
             sales_channel=coalesce(excluded.sales_channel, amazon_orders.sales_channel),
             order_channel=coalesce(excluded.order_channel, amazon_orders.order_channel),
             ship_service_level=coalesce(excluded.ship_service_level, amazon_orders.ship_service_level),
             is_business_order=coalesce(excluded.is_business_order, amazon_orders.is_business_order),
             raw=excluded.raw,
             updated_at=now()`,
          [
            orderId,
            amazonOrderId,
            'ATVPDKIKX0DER',
            lastUpdatedDate,
            r.sales_channel || null,
            r.order_channel || null,
            r.ship_service_level || null,
            r.is_business_order || null,
            JSON.stringify(r)
          ]
        );
      }

      if (!dryRun) await pool.query('COMMIT');
    } catch (e) {
      if (!dryRun) await pool.query('ROLLBACK');
      throw e;
    }

    offset += res.rows.length;
    process.stderr.write(`processed ${offset} rows...\n`);
  }

  process.stderr.write(`done. upserted orders: ${insertedOrders}, upserted items: ${insertedItems}\n`);
}

main()
  .catch((e) => {
    console.error(e?.stack || e?.message || e);
    process.exit(1);
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
