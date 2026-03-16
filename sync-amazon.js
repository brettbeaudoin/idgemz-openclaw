const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { ensureCustomerForOrder } = require('./customer-identity');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

class AmazonSync {
  constructor() {
    this.sellingPartner = null;
    this.channelId = null;
  }

  async initialize() {
    // Get channel info and credentials from database
    const result = await pool.query(`
      SELECT id, api_credentials 
      FROM channels 
      WHERE platform = 'amazon' AND api_connected = true
    `);
    
    if (!result.rows.length) {
      throw new Error('Amazon channel not connected. Run oauth-server.js first.');
    }
    
    this.channelId = result.rows[0].id;
    const { refreshToken } = result.rows[0].api_credentials;
    
    // Initialize SP-API client
    this.sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
      },
      options: {
        auto_request_throttled: true
      }
    });
  }

  async syncOrders(daysBack = 7, opts = {}) {
    const { mode } = opts;

    let query;

    if (mode === 'yesterday-pt') {
      // "Yesterday" is defined in the system timezone (so if the machine moves, the concept of
      // "yesterday" follows the machine). But Amazon orders are queried using PT day boundaries.
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const reportDateStr = DateTime.now().setZone(systemTz).minus({ days: 1 }).toISODate();

      const startPt = DateTime.fromISO(reportDateStr, { zone: 'America/Los_Angeles' }).startOf('day');
      const endPt = startPt.plus({ days: 1 });

      console.log(`Syncing Amazon orders for PT day: ${reportDateStr}`);
      console.log(`  CreatedAfter (PT midnight):  ${startPt.toISO()}`);
      console.log(`  CreatedBefore (next midnight): ${endPt.toISO()}`);

      query = {
        MarketplaceIds: ['ATVPDKIKX0DER'],
        CreatedAfter: startPt.toUTC().toISO(),
        CreatedBefore: endPt.toUTC().toISO()
      };
    } else {
      console.log(`Syncing orders from last ${daysBack} days...`);
      query = {
        MarketplaceIds: ['ATVPDKIKX0DER'], // US marketplace
        CreatedAfter: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
      };
    }

    const syncLog = await pool.query(`
      INSERT INTO sync_logs (channel_id, sync_type, status)
      VALUES ($1, 'orders', 'running')
      RETURNING id
    `, [this.channelId]);
    const syncLogId = syncLog.rows[0].id;
    
    try {
      const orders = await this.sellingPartner.callAPI({
        endpoint: 'orders',
        operation: 'getOrders',
        query
      });
      
      let processedCount = 0;
      
      for (const order of orders.Orders || []) {
        // Insert or update order
        const orderTotalKnown = !!(order.OrderTotal && order.OrderTotal.Amount != null);

        const shippingAddress = order.ShippingAddress || {};
        const buyerName = order.BuyerInfo?.BuyerName || null;
        const buyerEmail = order.BuyerInfo?.BuyerEmail || null;

        // Link to a canonical customer record for cross-channel correlation
        const customerId = await ensureCustomerForOrder({
          pool,
          channel: 'amazon',
          buyerName,
          buyerEmail,
          shippingAddress,
          source: 'amazon_orders_api'
        });

        await pool.query(`
          INSERT INTO orders (
            channel_id, channel_order_id, order_date, customer_id, customer_name,
            customer_email, shipping_address, order_total, currency,
            status, fulfillment_channel, external_updated_at,
            amount_known
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
            amount_known = (orders.amount_known OR EXCLUDED.amount_known),
            updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `, [
          this.channelId,
          order.AmazonOrderId,
          order.PurchaseDate, // UTC (Z) from Amazon
          customerId,
          buyerName,
          buyerEmail,
          JSON.stringify(shippingAddress),
          orderTotalKnown ? parseFloat(order.OrderTotal.Amount) : 0,
          (order.OrderTotal && order.OrderTotal.CurrencyCode) ? order.OrderTotal.CurrencyCode : 'USD',
          order.OrderStatus,
          order.FulfillmentChannel,
          order.LastUpdateDate || null,
          orderTotalKnown
        ]);
        
        // Upsert amazon_orders (normalized) + keep raw order JSON for diagnostics
        try {
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
              this.channelId,
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
        } catch (e) {
          // don't fail the whole sync if the diagnostics table insert fails
          console.warn('amazon_orders upsert failed (continuing):', e?.message || e);
        }

        // Get order items
        const orderItems = await this.sellingPartner.callAPI({
          endpoint: 'orders',
          operation: 'getOrderItems',
          path: {
            orderId: order.AmazonOrderId
          }
        });

        for (const item of orderItems.OrderItems || []) {
          // First, ensure we have the product listing
          const listing = await this.upsertProductListing(item);

          const qtyOrdered = item.QuantityOrdered || 0;
          const qtyShipped = item.QuantityShipped ?? null;

          // Amazon Orders API: ItemPrice is generally a LINE total (already qty * unit).
          // We store unit_price as per-unit for consistency with downstream reporting.
          const lineItemPrice = (item.ItemPrice && item.ItemPrice.Amount != null) ? parseFloat(item.ItemPrice.Amount) : null;
          const shippingPrice = (item.ShippingPrice && item.ShippingPrice.Amount != null) ? parseFloat(item.ShippingPrice.Amount) : null;
          const itemTax = (item.ItemTax && item.ItemTax.Amount != null) ? parseFloat(item.ItemTax.Amount) : null;
          const promoDiscount = (item.PromotionDiscount && item.PromotionDiscount.Amount != null) ? parseFloat(item.PromotionDiscount.Amount) : null;

          const perUnitPrice = (lineItemPrice == null)
            ? null
            : (qtyOrdered > 0 ? (lineItemPrice / qtyOrdered) : null);

          // Insert/update order item (idempotent by (order_id, channel_line_item_id))
          await pool.query(`
            INSERT INTO order_items (
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
            WHERE o.channel_order_id = $1 AND o.channel_id = $12
            ON CONFLICT (order_id, channel_line_item_id)
            DO UPDATE SET
              quantity = EXCLUDED.quantity,
              quantity_shipped = EXCLUDED.quantity_shipped,
              unit_price = EXCLUDED.unit_price,
              shipping_price = EXCLUDED.shipping_price,
              tax = EXCLUDED.tax,
              discount = EXCLUDED.discount,
              total = EXCLUDED.total,
              raw = EXCLUDED.raw
          `, [
            order.AmazonOrderId,
            listing.id,
            item.OrderItemId || null,
            qtyOrdered,
            qtyShipped,
            perUnitPrice,
            shippingPrice,
            itemTax,
            promoDiscount,
            // total = PRE-tax, PRE-shipping item total (matches sheet + reporting expectations)
            (perUnitPrice == null)
              ? null
              : (perUnitPrice * qtyOrdered) - (promoDiscount || 0),
            JSON.stringify(item),
            this.channelId
          ]);
        }
        
        processedCount++;
      }
      
      // Update sync log
      await pool.query(`
        UPDATE sync_logs 
        SET completed_at = CURRENT_TIMESTAMP,
            status = 'completed',
            records_processed = $2
        WHERE id = $1
      `, [syncLogId, processedCount]);
      
      console.log(`Successfully synced ${processedCount} orders`);
      return processedCount;
      
    } catch (error) {
      // Update sync log with error
      await pool.query(`
        UPDATE sync_logs 
        SET completed_at = CURRENT_TIMESTAMP,
            status = 'failed',
            error_message = $2
        WHERE id = $1
      `, [syncLogId, error.message]);
      
      throw error;
    }
  }

  async upsertProductListing(orderItem) {
    // Check if product exists
    // Create-or-get in one round-trip to avoid race conditions.
    const product = await pool.query(
      `INSERT INTO products (internal_sku, title)
       VALUES ($1, $2)
       ON CONFLICT (internal_sku)
       DO UPDATE SET title = COALESCE(products.title, EXCLUDED.title)
       RETURNING id`,
      [orderItem.SellerSKU, orderItem.Title]
    );
    
    // Upsert channel listing
    const listing = await pool.query(`
      INSERT INTO channel_listings (
        product_id, channel_id, channel_sku, asin, title, price, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (channel_id, channel_sku)
      DO UPDATE SET
        asin = EXCLUDED.asin,
        title = EXCLUDED.title,
        price = EXCLUDED.price,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [
      product.rows[0].id,
      this.channelId,
      orderItem.SellerSKU,
      orderItem.ASIN,
      orderItem.Title,
      // Store per-unit price for the listing when we have it.
      (orderItem.ItemPrice?.Amount != null)
        ? (parseFloat(orderItem.ItemPrice.Amount) / (orderItem.QuantityOrdered || 1))
        : null
    ]);
    
    return listing.rows[0];
  }

  async syncInventory() {
    console.log('Syncing inventory levels...');
    
    try {
      const inventory = await this.sellingPartner.callAPI({
        endpoint: 'fbaInventory',
        operation: 'getInventorySummaries',
        query: {
          // Required by SP-API FBA Inventory v1
          granularityType: 'Marketplace',
          granularityId: 'ATVPDKIKX0DER',
          marketplaceIds: ['ATVPDKIKX0DER'],
          // Some SP-API endpoints are picky about booleans; use a string.
          details: 'true'
        }
      });
      
      for (const item of inventory.inventorySummaries || []) {
        // Get product by SKU
        const product = await pool.query(`
          SELECT p.id 
          FROM products p
          JOIN channel_listings cl ON cl.product_id = p.id
          WHERE cl.channel_id = $1 AND cl.channel_sku = $2
        `, [this.channelId, item.sellerSku]);
        
        if (product.rows.length) {
          await pool.query(`
            INSERT INTO inventory (
              product_id, channel_id, quantity_available, 
              quantity_reserved, quantity_inbound, warehouse_location
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (product_id, channel_id, warehouse_location)
            DO UPDATE SET
              quantity_available = EXCLUDED.quantity_available,
              quantity_reserved = EXCLUDED.quantity_reserved,
              quantity_inbound = EXCLUDED.quantity_inbound,
              last_updated = CURRENT_TIMESTAMP
          `, [
            product.rows[0].id,
            this.channelId,
            item.totalQuantity || 0,
            // Sum all known reserved buckets (shape varies by API version)
            (item.reservedQuantity?.totalReservedQuantity
              ?? (
                num(item.reservedQuantity?.customerOrdersQuantity)
                + num(item.reservedQuantity?.pendingCustomerOrderQuantity)
                + num(item.reservedQuantity?.workingQuantity)
                + num(item.reservedQuantity?.fcTransferQuantity)
                + num(item.reservedQuantity?.fcProcessingQuantity)
                + num(item.reservedQuantity?.unfulfillableQuantity)
              )), 
            // Sum all known inbound buckets
            (item.inboundQuantity?.totalInboundQuantity
              ?? (num(item.inboundQuantity?.inboundWorkingQuantity)
                + num(item.inboundQuantity?.inboundShippedQuantity)
                + num(item.inboundQuantity?.inboundReceivingQuantity))),
            // This endpoint is FBA inventory; treat as FBA.
            'FBA'
          ]);
        }
      }
      
      console.log('Inventory sync completed');
    } catch (error) {
      console.error('Inventory sync error:', error);
      throw error;
    }
  }
}

// Run sync if called directly
if (require.main === module) {
  (async () => {
    try {
      const sync = new AmazonSync();
      await sync.initialize();
      
      // Sync orders (configurable)
      // Usage:
      //   AMAZON_SYNC_DAYS_BACK=7 node sync-amazon.js
      //   node sync-amazon.js 7
      const argv = process.argv.slice(2);
      const hasYesterdayPt = argv.includes('--yesterday-pt') || process.env.AMAZON_SYNC_MODE === 'yesterday-pt';

      const daysBackArg = argv.find((a) => /^\d+$/.test(a));
      const daysBack = parseInt(process.env.AMAZON_SYNC_DAYS_BACK || daysBackArg || '7', 10);

      if (hasYesterdayPt) {
        console.log('Running Amazon order sync in mode=yesterday-pt (system yesterday, PT day boundaries)...');
        await sync.syncOrders(daysBack, { mode: 'yesterday-pt' });
      } else {
        console.log(`Running Amazon order sync for last ${daysBack} days...`);
        await sync.syncOrders(daysBack);
      }
      
      // Sync current inventory (non-fatal if it fails; orders are the core source of truth)
      try {
        await sync.syncInventory();
      } catch (err) {
        console.error('⚠️ Inventory sync failed (continuing):', err?.message || err);
      }
      
      console.log('Amazon sync completed (orders done; inventory attempted).');
    } catch (error) {
      console.error('Sync failed:', error);
      process.exitCode = 1;
    } finally {
      try { await pool.end(); } catch {}
    }
  })();
}

module.exports = AmazonSync;