const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const { ensureCustomerForOrder } = require('./customer-identity');
require('dotenv').config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { limit: 200, year: 2023, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--year') args.year = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function backfillAmazonOrders({ limit, year, dryRun }) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
      options: { auto_request_throttled: true }
    });

    // Pick "placeholder-ish" orders in the target year that have no order_items.
    // We also include orders that have NULL status/order_total/customer fields.
    const ordersRes = await pool.query(
      `SELECT o.id, o.channel_order_id
       FROM orders o
       WHERE o.channel_id = $1
         AND o.order_date >= $2::date
         AND o.order_date < ($2::date + interval '1 year')
         AND (
           o.status IS NULL
           OR o.order_total IS NULL
           OR o.customer_name IS NULL
           OR o.customer_email IS NULL
           OR NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
         )
       ORDER BY o.order_date ASC
       LIMIT $3`,
      [channelId, `${year}-01-01`, limit]
    );

    console.log(`Amazon backfill: year=${year} limit=${limit} dryRun=${dryRun}`);
    console.log(`Found ${ordersRes.rows.length} candidate orders to backfill.`);

    let updatedOrders = 0;
    let insertedItems = 0;

    for (const row of ordersRes.rows) {
      const orderUuid = row.id;
      const amazonOrderId = (row.channel_order_id || '').trim();

      try {
        // 1) Fetch order detail
        console.log(`Fetching order ${amazonOrderId}`);
        const orderResp = await sp.callAPI({
          endpoint: 'orders',
          operation: 'getOrder',
          path: { orderId: amazonOrderId }
        });

        const order = orderResp?.payload || orderResp?.Order || orderResp?.order || orderResp;
        // amazon-sp-api typically returns { payload: { ... } }

        const purchaseDate = order?.PurchaseDate || order?.purchaseDate;
        const orderStatus = order?.OrderStatus || order?.orderStatus;
        const fulfillmentChannel = order?.FulfillmentChannel || order?.fulfillmentChannel;
        const totalAmount = order?.OrderTotal?.Amount ?? order?.orderTotal?.Amount;
        const currency = order?.OrderTotal?.CurrencyCode ?? order?.orderTotal?.CurrencyCode ?? 'USD';

        // These are sometimes not present depending on permission/account.
        const buyerName = order?.BuyerName || null;
        const buyerEmail = order?.BuyerEmail || null;
        const shippingAddress = order?.ShippingAddress || null;

        const customerId = await ensureCustomerForOrder({
          pool,
          channel: 'amazon',
          buyerName,
          buyerEmail,
          shippingAddress: shippingAddress || {},
          source: 'amazon_backfill_single'
        });

        if (!dryRun) {
          await pool.query(
            `UPDATE orders
             SET order_date = COALESCE($1::timestamptz, order_date),
                 status = COALESCE($2, status),
                 fulfillment_channel = COALESCE($3, fulfillment_channel),
                 order_total = COALESCE($4::numeric, order_total),
                 currency = COALESCE($5, currency),
                 customer_id = COALESCE(customer_id, $6::uuid),
                 customer_name = COALESCE($7, customer_name),
                 customer_email = COALESCE($8, customer_email),
                 shipping_address = COALESCE($9::jsonb, shipping_address),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $10`,
            [purchaseDate, orderStatus, fulfillmentChannel, totalAmount, currency, customerId, buyerName, buyerEmail, shippingAddress ? JSON.stringify(shippingAddress) : null, orderUuid]
          );
        }
        updatedOrders++;

        // 2) Fetch order items
        const itemsResp = await sp.callAPI({
          endpoint: 'orders',
          operation: 'getOrderItems',
          path: { orderId: amazonOrderId }
        });

        const items = itemsResp?.OrderItems || itemsResp?.payload?.OrderItems || [];

        for (const item of items) {
          const sellerSku = item.SellerSKU;
          const asin = item.ASIN;
          const title = item.Title || 'Unknown Product';
          const qty = item.QuantityOrdered || 1;
          const itemTotal = parseFloat(item.ItemPrice?.Amount || 0);
          const unitPrice = qty ? itemTotal / qty : itemTotal;

          if (!sellerSku) continue;

          if (dryRun) {
            insertedItems++;
            continue;
          }

          // Ensure product exists
          let productId;
          const prod = await pool.query('SELECT id FROM products WHERE internal_sku=$1', [sellerSku]);
          if (!prod.rows.length) {
            const ins = await pool.query('INSERT INTO products (internal_sku, title) VALUES ($1,$2) RETURNING id', [sellerSku, title]);
            productId = ins.rows[0].id;
          } else {
            productId = prod.rows[0].id;
          }

          // Ensure channel listing exists
          const listing = await pool.query(
            `INSERT INTO channel_listings (product_id, channel_id, channel_sku, asin, title, price, status)
             VALUES ($1,$2,$3,$4,$5,$6,'active')
             ON CONFLICT (channel_id, channel_sku)
             DO UPDATE SET asin=EXCLUDED.asin, title=EXCLUDED.title, updated_at=CURRENT_TIMESTAMP
             RETURNING id`,
            [productId, channelId, sellerSku, asin, title, unitPrice]
          );

          // Insert order item (note: schema has no uniqueness constraint; we use a best-effort dedupe)
          const exists = await pool.query(
            `SELECT 1 FROM order_items
             WHERE order_id=$1 AND channel_listing_id=$2 AND quantity=$3 AND total=$4
             LIMIT 1`,
            [orderUuid, listing.rows[0].id, qty, itemTotal]
          );
          if (!exists.rows.length) {
            await pool.query(
              `INSERT INTO order_items (order_id, channel_listing_id, quantity, unit_price, total)
               VALUES ($1,$2,$3,$4,$5)`,
              [orderUuid, listing.rows[0].id, qty, unitPrice, itemTotal]
            );
            insertedItems++;
          }
        }

        // polite delay between orders
        await sleep(350);
      } catch (err) {
        console.error(`Backfill error for AmazonOrderId=${amazonOrderId}:`, err?.message || err);
        // keep going
        await sleep(500);
      }
    }

    console.log(`Done. Updated orders: ${updatedOrders}. Inserted order_items: ${insertedItems}.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  backfillAmazonOrders(args).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { backfillAmazonOrders };
