// Backfill Amazon orders history gradually without getting throttled.
// Each run pulls ONE time window (default 7 days) going backwards until the API limit.
//
// State file: ../memory/amazon-backfill-state.json
//
// Usage:
//   node amazon-backfill-worker.js
//   CHUNK_DAYS=3 node amazon-backfill-worker.js
//   DRY_RUN=1 node amazon-backfill-worker.js

const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { ensureCustomerForOrder } = require('./customer-identity');
require('dotenv').config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_PATH = path.resolve(__dirname, '../memory/amazon-backfill-state.json');
const LOCK_PATH = path.resolve(__dirname, '../memory/amazon-backfill.lock');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(LOCK_PATH); } catch {}
    };
  } catch (e) {
    // If lock exists, check if the process is still alive.
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      const pid = lock?.pid;
      if (pid) {
        try {
          process.kill(pid, 0);
          console.error(`Another amazon-backfill-worker is running (pid ${pid}); exiting.`);
          return null;
        } catch {
          // stale lock
          fs.unlinkSync(LOCK_PATH);
          return acquireLock();
        }
      }
    } catch {
      // ignore and fall through
    }
    console.error('Could not acquire lock; exiting:', e?.message || e);
    return null;
  }
}

async function callApiWithTimeout(sp, req, timeoutMs, label) {
  const t = timeoutMs || 120000;
  return await Promise.race([
    sp.callAPI(req),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout_after_${t}ms:${label}`)), t))
  ]);
}

async function main() {
  const releaseLock = acquireLock();
  if (!releaseLock) return;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const chunkDays = parseInt(process.env.CHUNK_DAYS || '7', 10);
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  // "API will allow" is ambiguous; SP-API Orders API generally supports up to ~2 years.
  const earliestUtc = DateTime.utc().minus({ days: 730 }).startOf('day');
  const doneFlag = 'done';

  // We avoid querying right up to "now" for safety. Also leaves room for late updates.
  const safeEndUtc = DateTime.utc().minus({ hours: 6 });

  try {
    const chRes = await pool.query(
      `SELECT id, api_credentials FROM channels WHERE platform='amazon' AND api_connected=true ORDER BY name LIMIT 1`
    );
    if (!chRes.rows.length) throw new Error('Amazon channel not connected');

    const channelId = chRes.rows[0].id;
    const { refreshToken } = chRes.rows[0].api_credentials;

    const sp = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
      },
      options: { auto_request_throttled: true }
    });

    const state = loadState() || {
      // We walk backwards from a safe end.
      cursorEndUtc: safeEndUtc.toISO(),
      chunkDays,
      runs: 0,
      done: false
    };

    const cursorEnd = DateTime.fromISO(state.cursorEndUtc, { zone: 'utc' });
    const cursorStart = cursorEnd.minus({ days: chunkDays });

    if (state.done || cursorEnd <= earliestUtc) {
      const finalState = { ...state, done: true, doneAtUtc: state.doneAtUtc || DateTime.utc().toISO() };
      saveState(finalState);
      console.log('Amazon backfill: reached earliest limit. Marked done.');
      return;
    }

    const startUtc = cursorStart < earliestUtc ? earliestUtc : cursorStart;
    const endUtc = cursorEnd;

    console.log(`Amazon backfill window (UTC): ${startUtc.toISO()} → ${endUtc.toISO()} (dryRun=${dryRun})`);

    let totalOrders = 0;
    let nextToken = null;

    do {
      const query = {
        MarketplaceIds: ['ATVPDKIKX0DER'],
        CreatedAfter: startUtc.toISO(),
        CreatedBefore: endUtc.toISO()
      };
      if (nextToken) query.NextToken = nextToken;

      const resp = await callApiWithTimeout(
        sp,
        { endpoint: 'orders', operation: 'getOrders', query },
        parseInt(process.env.AMAZON_API_TIMEOUT_MS || '120000', 10),
        'getOrders'
      );
      const orders = resp?.Orders || [];
      nextToken = resp?.NextToken || null;

      console.log(`  page: ${orders.length} orders${nextToken ? ' (nextToken)' : ''}`);

      let processedInThisPage = 0;
      for (const order of orders) {
        totalOrders++;
        processedInThisPage++;

        if (totalOrders % 10 === 0) {
          // Heartbeat so "hung" detection has something to look at.
          const hb = {
            ...state,
            chunkDays,
            lastRunAtUtc: DateTime.utc().toISO(),
            lastWindow: { startUtc: startUtc.toISO(), endUtc: endUtc.toISO(), orders: totalOrders },
            progress: {
              pageProcessed: processedInThisPage,
              pageSize: orders.length,
              nextToken: !!nextToken,
              lastAmazonOrderId: order?.AmazonOrderId || null
            }
          };
          saveState(hb);
          console.log(`  progress: processed ${totalOrders} orders so far...`);
        }

        if (dryRun) continue;

        // Reuse existing sync logic by doing the same inserts/updates inline (minimal subset):
        // orders (+ customer graph)
        const shippingAddress = order.ShippingAddress || {};
        const buyerName = order.BuyerInfo?.BuyerName || null;
        const buyerEmail = order.BuyerInfo?.BuyerEmail || null;

        const customerId = await ensureCustomerForOrder({
          pool,
          channel: 'amazon',
          buyerName,
          buyerEmail,
          shippingAddress,
          source: 'amazon_backfill'
        });

        await pool.query(
          `INSERT INTO orders (
             channel_id, channel_order_id, order_date, customer_id, customer_name,
             customer_email, shipping_address, order_total, currency,
             status, fulfillment_channel, external_updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
             fulfillment_channel = COALESCE(EXCLUDED.fulfillment_channel, orders.fulfillment_channel),
             external_updated_at = COALESCE(EXCLUDED.external_updated_at, orders.external_updated_at),
             updated_at = now()`,
          [
            channelId,
            order.AmazonOrderId,
            order.PurchaseDate,
            customerId,
            buyerName,
            buyerEmail,
            JSON.stringify(shippingAddress),
            parseFloat(order.OrderTotal?.Amount || 0),
            order.OrderTotal?.CurrencyCode || 'USD',
            order.OrderStatus,
            order.FulfillmentChannel,
            order.LastUpdateDate || null
          ]
        );

        // amazon_orders diagnostics/extra
        await pool.query(
          `INSERT INTO amazon_orders (
             order_id, amazon_order_id, marketplace_id, last_update_date,
             sales_channel, order_channel, ship_service_level,
             is_prime, is_business_order, is_premium_order, order_type,
             payment_method_details, raw, updated_at
           )
           VALUES (
             (SELECT id FROM orders WHERE channel_id=$1 AND channel_order_id=$2),
             $2, $3, $4::timestamptz,
             $5, $6, $7,
             $8, $9, $10, $11,
             $12::jsonb, $13::jsonb, now()
           )
           ON CONFLICT (order_id) DO UPDATE SET
             marketplace_id=EXCLUDED.marketplace_id,
             last_update_date=EXCLUDED.last_update_date,
             sales_channel=EXCLUDED.sales_channel,
             order_channel=EXCLUDED.order_channel,
             ship_service_level=EXCLUDED.ship_service_level,
             is_prime=EXCLUDED.is_prime,
             is_business_order=EXCLUDED.is_business_order,
             is_premium_order=EXCLUDED.is_premium_order,
             order_type=EXCLUDED.order_type,
             payment_method_details=EXCLUDED.payment_method_details,
             raw=EXCLUDED.raw,
             updated_at=now()`,
          [
            channelId,
            order.AmazonOrderId,
            order.MarketplaceId || 'ATVPDKIKX0DER',
            order.LastUpdateDate || null,
            order.SalesChannel || null,
            order.OrderChannel || null,
            order.ShipServiceLevel || null,
            order.IsPrime || null,
            order.IsBusinessOrder || null,
            order.IsPremiumOrder || null,
            order.OrderType || null,
            JSON.stringify(order.PaymentMethodDetails || null),
            JSON.stringify(order)
          ]
        );

        // Fetch items for each order (this is the slow part; throttle politely)
        const itemsResp = await callApiWithTimeout(
          sp,
          {
            endpoint: 'orders',
            operation: 'getOrderItems',
            path: { orderId: order.AmazonOrderId }
          },
          parseInt(process.env.AMAZON_API_TIMEOUT_MS || '120000', 10),
          'getOrderItems'
        );

        for (const item of itemsResp?.OrderItems || []) {
          // Minimal product/listing upsert (same as sync-amazon.js does)
          const sellerSku = item.SellerSKU;
          const asin = item.ASIN;
          const title = item.Title || 'Unknown Product';
          if (!sellerSku) continue;

          // products
          let prod = await pool.query('SELECT id FROM products WHERE internal_sku=$1', [sellerSku]);
          if (!prod.rows.length) {
            prod = await pool.query('INSERT INTO products (internal_sku, title) VALUES ($1,$2) RETURNING id', [sellerSku, title]);
          }
          const productId = prod.rows[0].id;

          // channel_listings
          const qtyOrdered = item.QuantityOrdered || 0;
          const qtyShipped = item.QuantityShipped || 0;
          const itemTotal = item.ItemPrice?.Amount != null ? parseFloat(item.ItemPrice.Amount) : null;
          const unitPrice = (itemTotal == null)
            ? null
            : ((qtyShipped > 0 && qtyOrdered > qtyShipped)
                ? (itemTotal / qtyShipped)
                : (qtyOrdered ? itemTotal / qtyOrdered : itemTotal));

          const listing = await pool.query(
            `INSERT INTO channel_listings (product_id, channel_id, channel_sku, asin, title, price, status)
             VALUES ($1,$2,$3,$4,$5,$6,'active')
             ON CONFLICT (channel_id, channel_sku)
             DO UPDATE SET asin=EXCLUDED.asin, title=EXCLUDED.title, price=EXCLUDED.price, updated_at=now()
             RETURNING id`,
            [productId, channelId, sellerSku, asin, title, unitPrice]
          );

          const shippingPrice = parseFloat(item.ShippingPrice?.Amount || 0);
          const promoDiscount = parseFloat(item.PromotionDiscount?.Amount || 0);

          await pool.query(
            `INSERT INTO order_items (
               order_id, channel_listing_id, channel_line_item_id,
               quantity, quantity_shipped,
               unit_price, shipping_price, tax, discount, total,
               raw
             )
             SELECT
               o.id, $2, $3,
               $4, $5,
               $6, $7, $8, $9, $10,
               $11::jsonb
             FROM orders o
             WHERE o.channel_id=$12 AND o.channel_order_id=$1
             ON CONFLICT (order_id, channel_line_item_id)
             DO UPDATE SET
               quantity=EXCLUDED.quantity,
               quantity_shipped=EXCLUDED.quantity_shipped,
               unit_price=EXCLUDED.unit_price,
               shipping_price=EXCLUDED.shipping_price,
               tax=EXCLUDED.tax,
               discount=EXCLUDED.discount,
               total=EXCLUDED.total,
               raw=EXCLUDED.raw`,
            [
              order.AmazonOrderId,
              listing.rows[0].id,
              item.OrderItemId || null,
              qtyOrdered,
              item.QuantityShipped ?? null,
              unitPrice,
              shippingPrice,
              parseFloat(item.ItemTax?.Amount || 0),
              promoDiscount,
              (unitPrice == null) ? null : (unitPrice * qtyOrdered + shippingPrice - promoDiscount),
              JSON.stringify(item),
              channelId
            ]
          );
        }

        // Gentle per-order delay (auto_request_throttled helps, but this keeps us polite)
        await sleep(250);
      }

      if (nextToken) await sleep(1000);
    } while (nextToken);

    console.log(`Backfill window complete. Orders seen: ${totalOrders}`);

    // Move cursor backwards
    const newEnd = startUtc;
    const newState = {
      ...state,
      cursorEndUtc: newEnd.toISO(),
      chunkDays,
      runs: (state.runs || 0) + 1,
      lastRunAtUtc: DateTime.utc().toISO(),
      lastWindow: { startUtc: startUtc.toISO(), endUtc: endUtc.toISO(), orders: totalOrders }
    };
    saveState(newState);

    console.log(`State saved. Next run will end at: ${newState.cursorEndUtc}`);
  } finally {
    await pool.end();
    try { releaseLock(); } catch {}
  }
}

if (require.main === module) {
  main()
    .then(() => {
      // amazon-sp-api / undici can keep sockets open; force a clean exit when work is done.
      process.exit(0);
    })
    .catch((e) => {
      console.error(e?.stack || e?.message || e);
      process.exit(1);
    });
}
