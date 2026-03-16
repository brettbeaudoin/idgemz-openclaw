const { Pool } = require('pg');
const { DateTime } = require('luxon');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config();

const { ShopifyClient } = require('./shopify-client');
const { ensureCustomerForOrder } = require('./customer-identity');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function sumTaxLines(taxLines) {
  if (!Array.isArray(taxLines)) return 0;
  return taxLines.reduce((acc, tl) => acc + (num(tl?.price) || 0), 0);
}

async function ensureShopifyTables() {
  // No psql in this environment; create diagnostic table if needed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_orders (
      order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      shopify_order_id bigint NOT NULL,
      name text,
      raw jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS shopify_orders_shopify_order_id_idx
      ON shopify_orders (shopify_order_id);
  `);
}

async function ensureShopifyChannel() {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-01';
  if (!shop || !token) throw new Error('Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN in env');

  // Prefer existing row by platform if it exists
  const existing = await pool.query(
    `SELECT id FROM channels WHERE platform='shopify' ORDER BY created_at DESC NULLS LAST LIMIT 1`
  );

  let channelId;
  if (existing.rows.length) {
    channelId = existing.rows[0].id;
    await pool.query(
      `UPDATE channels
       SET api_connected=true,
           api_credentials=$2::jsonb,
           updated_at=now()
       WHERE id=$1`,
      [channelId, JSON.stringify({ shop, accessToken: token, apiVersion })]
    );
  } else {
    // channels has UNIQUE(name)
    const name = 'shopify';
    const inserted = await pool.query(
      `INSERT INTO channels (name, platform, api_connected, api_credentials, created_at, updated_at)
       VALUES ($1, 'shopify', true, $2::jsonb, now(), now())
       ON CONFLICT (name)
       DO UPDATE SET
         platform='shopify',
         api_connected=true,
         api_credentials=EXCLUDED.api_credentials,
         updated_at=now()
       RETURNING id`,
      [name, JSON.stringify({ shop, accessToken: token, apiVersion })]
    );
    channelId = inserted.rows[0].id;
  }

  return { channelId, shop, token, apiVersion };
}

async function createSyncLog(channelId, syncType, details = null) {
  const r = await pool.query(
    `INSERT INTO sync_logs (channel_id, sync_type, status, started_at, details)
     VALUES ($1, $2, 'running', now(), $3::jsonb)
     RETURNING id`,
    [channelId, syncType, details ? JSON.stringify(details) : null]
  );
  return r.rows[0].id;
}

async function completeSyncLog(id, status, recordsProcessed, errorMessage = null, details = null) {
  await pool.query(
    `UPDATE sync_logs
     SET completed_at=now(), status=$2, records_processed=$3, error_message=$4, details=COALESCE($5::jsonb, details)
     WHERE id=$1`,
    [id, status, recordsProcessed ?? null, errorMessage, details ? JSON.stringify(details) : null]
  );
}

async function upsertProductAndListing({ channelId, lineItem }) {
  const sku = (lineItem?.sku || '').trim();
  const internalSku = sku || (lineItem?.variant_id ? `shopify_variant_${lineItem.variant_id}` : `shopify_line_${lineItem.id}`);
  const title = lineItem?.title || 'Unknown';

  const product = await pool.query(
    `INSERT INTO products (internal_sku, title, deprecated)
     VALUES ($1, $2, false)
     ON CONFLICT (internal_sku)
     DO UPDATE SET title = COALESCE(products.title, EXCLUDED.title)
     RETURNING id`,
    [internalSku, title]
  );

  const price = num(lineItem?.price);
  const listingId = lineItem?.product_id ? String(lineItem.product_id) : null;

  const listing = await pool.query(
    `INSERT INTO channel_listings (
       product_id, channel_id, channel_sku, listing_id, title, price, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (channel_id, channel_sku)
     DO UPDATE SET
       listing_id = COALESCE(EXCLUDED.listing_id, channel_listings.listing_id),
       title = COALESCE(EXCLUDED.title, channel_listings.title),
       price = COALESCE(EXCLUDED.price, channel_listings.price),
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [product.rows[0].id, channelId, internalSku, listingId, title, price]
  );

  return { productId: product.rows[0].id, listingId: listing.rows[0].id, internalSku };
}

async function upsertOrder({ channelId, order }) {
  const channelOrderId = String(order.id);
  const orderDate = order.created_at;
  const buyerEmail = order.email || order.customer?.email || null;
  const buyerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || order.shipping_address?.name || null;

  const shippingAddress = order.shipping_address || null;

  const customerId = await ensureCustomerForOrder({
    pool,
    channel: 'shopify',
    buyerName,
    buyerEmail,
    shippingAddress: shippingAddress || {},
    source: 'shopify_orders_api'
  });

  const amountKnown = order.total_price != null;

  // Store a merged status string that captures both financial + fulfillment status
  const status = [order.financial_status, order.fulfillment_status].filter(Boolean).join('|') || null;

  const inserted = await pool.query(
    `INSERT INTO orders (
       channel_id, channel_order_id, order_date, customer_id, customer_name,
       customer_email, shipping_address, order_total, currency,
       status, fulfillment_channel, external_updated_at, amount_known
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (channel_id, channel_order_id)
     DO UPDATE SET
       order_date = EXCLUDED.order_date,
       customer_id = COALESCE(orders.customer_id, EXCLUDED.customer_id),
       customer_name = COALESCE(EXCLUDED.customer_name, orders.customer_name),
       customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
       shipping_address = COALESCE(EXCLUDED.shipping_address, orders.shipping_address),
       order_total = COALESCE(EXCLUDED.order_total, orders.order_total),
       currency = COALESCE(EXCLUDED.currency, orders.currency),
       status = COALESCE(EXCLUDED.status, orders.status),
       external_updated_at = COALESCE(EXCLUDED.external_updated_at, orders.external_updated_at),
       amount_known = (orders.amount_known OR EXCLUDED.amount_known),
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [
      channelId,
      channelOrderId,
      orderDate,
      customerId,
      buyerName,
      buyerEmail,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      amountKnown ? num(order.total_price) : 0,
      order.currency || order.presentment_currency || 'USD',
      status,
      null,
      order.updated_at || null,
      amountKnown
    ]
  );

  return inserted.rows[0].id;
}

async function upsertShopifyRaw({ orderId, order }) {
  try {
    await pool.query(
      `INSERT INTO shopify_orders (order_id, shopify_order_id, name, raw, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (order_id)
       DO UPDATE SET
         shopify_order_id=EXCLUDED.shopify_order_id,
         name=EXCLUDED.name,
         raw=EXCLUDED.raw,
         updated_at=now()`,
      [orderId, BigInt(order.id), order.name || null, JSON.stringify(order)]
    );
  } catch (e) {
    console.warn('shopify_orders raw upsert failed (continuing):', e?.message || e);
  }
}

async function upsertOrderItems({ channelId, orderId, order }) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  for (let idx = 0; idx < lineItems.length; idx++) {
    const li = lineItems[idx];
    const { listingId } = await upsertProductAndListing({ channelId, lineItem: li });

    const qty = li.quantity || 0;
    const unitPrice = num(li.price);
    const discount = num(li.total_discount) || 0;
    const tax = sumTaxLines(li.tax_lines);

    const total = unitPrice == null ? null : (unitPrice * qty) - discount;

    // Important: channel_line_item_id must be non-null for ON CONFLICT to work reliably.
    // Shopify line_items normally have an id; if absent, derive a stable-ish key.
    const lineKey = (li.id != null)
      ? String(li.id)
      : `${order.id}:${li.variant_id || li.sku || 'line'}:${idx}`;

    await pool.query(
      `INSERT INTO order_items (
         order_id, channel_listing_id, channel_line_item_id,
         quantity, quantity_shipped,
         unit_price, shipping_price, tax, discount, total,
         raw, amount_known
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (order_id, channel_line_item_id)
       DO UPDATE SET
         channel_listing_id = EXCLUDED.channel_listing_id,
         quantity = EXCLUDED.quantity,
         quantity_shipped = EXCLUDED.quantity_shipped,
         unit_price = EXCLUDED.unit_price,
         shipping_price = EXCLUDED.shipping_price,
         tax = EXCLUDED.tax,
         discount = EXCLUDED.discount,
         total = EXCLUDED.total,
         raw = EXCLUDED.raw,
         amount_known = (order_items.amount_known OR EXCLUDED.amount_known)`,
      [
        orderId,
        listingId,
        lineKey,
        qty,
        null,
        unitPrice,
        null,
        tax,
        discount,
        total,
        JSON.stringify(li),
        unitPrice != null
      ]
    );
  }
}

function parseArgs(argv) {
  const args = { mode: null, sinceDays: null, bootstrap: false, start: null, end: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bootstrap') args.bootstrap = true;
    else if (a === '--yesterday-et') args.mode = 'yesterday-et';
    else if (a === '--since-days') args.sinceDays = parseInt(argv[++i], 10);
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
  }
  return args;
}

function computeRange({ bootstrap, mode, sinceDays, start, end }) {
  if (start || end) {
    return {
      start: start ? DateTime.fromISO(start, { zone: 'UTC' }) : null,
      end: end ? DateTime.fromISO(end, { zone: 'UTC' }) : null,
      label: `custom ${start || ''}..${end || ''}`
    };
  }

  if (bootstrap) {
    // Feb 1, 2023 in ET, convert to UTC for Shopify
    const s = DateTime.fromISO('2023-02-01', { zone: 'America/New_York' }).startOf('day').toUTC();
    return { start: s, end: null, label: 'bootstrap from 2023-02-01' };
  }

  if (mode === 'yesterday-et') {
    const tz = 'America/New_York';
    const day = DateTime.now().setZone(tz).minus({ days: 1 }).toISODate();
    const s = DateTime.fromISO(day, { zone: tz }).startOf('day').toUTC();
    const e = s.plus({ days: 1 });
    return { start: s, end: e, label: `yesterday ET (${day})` };
  }

  const days = Number.isFinite(sinceDays) ? sinceDays : parseInt(process.env.SHOPIFY_SYNC_DAYS_BACK || '2', 10);
  const s = DateTime.now().toUTC().minus({ days }).toISO();
  return { start: DateTime.fromISO(s, { zone: 'UTC' }), end: null, label: `last ${days} days` };
}

async function syncOrders({ client, channelId, range }) {
  const syncLogId = await createSyncLog(channelId, 'shopify_orders', { range: range.label });
  let processed = 0;
  try {
    // Shopify orders endpoint: created_at_min/max, status=any
    // Bootstrap can be massive: do it in chunks (30-day windows) to avoid huge scans.
    const start = range.start;
    const end = range.end;

    const chunkDays = parseInt(process.env.SHOPIFY_BOOTSTRAP_CHUNK_DAYS || '30', 10);
    let curStart = start;

    const hardEnd = end || DateTime.now().toUTC();

    // Ensure we include the entire last day (otherwise you can miss same-day orders)
    const effectiveHardEnd = end ? end : hardEnd.plus({ days: 1 });

    while (curStart && curStart < effectiveHardEnd) {
      const curEnd = end ? end : DateTime.min(curStart.plus({ days: chunkDays }), effectiveHardEnd);

      const q = {
        status: 'any',
        order: 'created_at asc',
        created_at_min: curStart.toISO(),
        created_at_max: curEnd.toISO(),
        fields: 'id,name,created_at,updated_at,currency,presentment_currency,total_price,current_total_price,total_tax,current_total_tax,financial_status,fulfillment_status,email,customer,shipping_address,line_items',
      };

      for await (const order of client.paginate('/orders.json', { query: q, rootKey: 'orders', limit: 250 })) {
        const orderId = await upsertOrder({ channelId, order });
        await upsertShopifyRaw({ orderId, order });
        await upsertOrderItems({ channelId, orderId, order });
        processed++;

        if (processed % 200 === 0) {
          console.log(`Processed ${processed} orders...`);
        }
      }

      console.log(`Chunk complete: ${curStart.toISODate()} .. ${curEnd.toISODate()}`);
      curStart = curEnd;
      if (end) break;
    }

    await completeSyncLog(syncLogId, 'completed', processed, null, { processed });
    console.log(`Successfully synced ${processed} Shopify orders (${range.label})`);
    return processed;
  } catch (e) {
    await completeSyncLog(syncLogId, 'failed', processed, e.message);
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureShopifyTables();
  const { channelId, shop, token, apiVersion } = await ensureShopifyChannel();

  const range = computeRange(args);
  console.log(`Running Shopify sync: ${range.label}`);

  const client = new ShopifyClient({ shop, accessToken: token, apiVersion });

  await syncOrders({ client, channelId, range });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Shopify sync failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await pool.end(); } catch {}
    });
}

module.exports = { ensureShopifyChannel, syncOrders };
