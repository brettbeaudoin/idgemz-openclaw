const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function syncAmazon() {
  let sellingPartner;
  let channelId;
  
  try {
    // Get credentials from database
    const result = await pool.query(`
      SELECT id, api_credentials 
      FROM channels 
      WHERE platform = 'amazon' AND api_connected = true
    `);
    
    if (!result.rows.length) {
      throw new Error('Amazon channel not connected');
    }
    
    channelId = result.rows[0].id;
    const { refreshToken } = result.rows[0].api_credentials;
    
    // Initialize SP-API client
    sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      options: {
        auto_request_throttled: true
      }
    });
    
    console.log('Connected to Amazon SP-API');
    
    // 1. Sync recent orders (7 days at a time to avoid timeouts)
    console.log('\n📦 Syncing orders...');
    const now = new Date();
    // SP-API can reject CreatedBefore/LastUpdatedBefore values too close to "now"
    // (systematic delay; must be at least ~2 minutes behind). Use a small safety buffer.
    const safeNow = new Date(now.getTime() - (5 * 60 * 1000));
    let totalOrders = 0;
    
    for (let daysAgo = 7; daysAgo <= 30; daysAgo += 7) {
      const startDate = new Date(safeNow.getTime() - (daysAgo * 24 * 60 * 60 * 1000));
      const endDate = new Date(safeNow.getTime() - ((daysAgo - 7) * 24 * 60 * 60 * 1000));
      
      console.log(`\nFetching orders from ${startDate.toDateString()} to ${endDate.toDateString()}`);
      
      let nextToken = null;
      let pageCount = 0;
      
      do {
        try {
          const query = {
            MarketplaceIds: ['ATVPDKIKX0DER'], // US marketplace
            CreatedAfter: startDate.toISOString(),
            CreatedBefore: endDate.toISOString()
          };
          
          if (nextToken) {
            query.NextToken = nextToken;
          }
          
          const response = await sellingPartner.callAPI({
            endpoint: 'orders',
            operation: 'getOrders',
            query: query
          });
          
          const orders = response.Orders || [];
          console.log(`  Page ${++pageCount}: ${orders.length} orders`);
          
          for (const order of orders) {
            // Insert order
            const orderResult = await pool.query(`
              INSERT INTO orders (
                channel_id, channel_order_id, order_date, 
                order_total, currency, status, fulfillment_channel,
                shipping_address
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (channel_id, channel_order_id) 
              DO UPDATE SET
                order_date = EXCLUDED.order_date,
                order_total = EXCLUDED.order_total,
                currency = EXCLUDED.currency,
                status = EXCLUDED.status,
                fulfillment_channel = EXCLUDED.fulfillment_channel,
                shipping_address = EXCLUDED.shipping_address,
                updated_at = CURRENT_TIMESTAMP
              RETURNING id
            `, [
              channelId,
              order.AmazonOrderId,
              order.PurchaseDate,
              parseFloat(order.OrderTotal?.Amount || 0),
              order.OrderTotal?.CurrencyCode || 'USD',
              order.OrderStatus,
              order.FulfillmentChannel,
              JSON.stringify(order.DefaultShipFromLocationAddress || {})
            ]);
            
            totalOrders++;
          }
          
          nextToken = response.NextToken;
          
          // Rate limit: Wait 1 second between pages
          if (nextToken) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error) {
          console.error('Error fetching page:', error.message);
          break;
        }
      } while (nextToken);
    }
    
    console.log(`\n✅ Synced ${totalOrders} orders total`);
    
    // 2. Get order items for recent orders (last 7 days only to avoid rate limits)
    console.log('\n📋 Fetching order items for recent orders...');
    const recentOrders = await pool.query(`
      SELECT o.id, o.channel_order_id
      FROM orders o
      WHERE o.channel_id = $1
        AND o.order_date > NOW() - INTERVAL '14 days'
        AND (
          NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
          OR COALESCE((SELECT SUM(oi.total) FROM order_items oi WHERE oi.order_id = o.id), 0) = 0
          OR COALESCE(o.order_total, 0) = 0
        )
      ORDER BY o.order_date DESC
      LIMIT 50
    `, [channelId]);
    
    console.log(`Processing ${recentOrders.rows.length} orders without items...`);
    
    for (const order of recentOrders.rows) {
      try {
        console.log(`  Fetching items for order ${order.channel_order_id}`);
        
        const itemsResponse = await sellingPartner.callAPI({
          endpoint: 'orders',
          operation: 'getOrderItems',
          path: {
            orderId: order.channel_order_id
          }
        });
        
        const items = itemsResponse.OrderItems || [];
        
        // Clear any placeholder/partial items so we can re-ingest cleanly.
        await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);

        for (const item of items) {
          // First ensure product exists
          let productId;
          const productCheck = await pool.query(
            'SELECT id FROM products WHERE internal_sku = $1',
            [item.SellerSKU]
          );
          
          if (productCheck.rows.length === 0) {
            const newProduct = await pool.query(`
              INSERT INTO products (internal_sku, title)
              VALUES ($1, $2)
              RETURNING id
            `, [item.SellerSKU, item.Title || 'Unknown Product']);
            productId = newProduct.rows[0].id;
          } else {
            productId = productCheck.rows[0].id;
          }
          
          // Ensure channel listing exists
          const listing = await pool.query(`
            INSERT INTO channel_listings (
              product_id, channel_id, channel_sku, asin, title, price, status
            ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
            ON CONFLICT (channel_id, channel_sku)
            DO UPDATE SET
              asin = EXCLUDED.asin,
              title = EXCLUDED.title,
              updated_at = CURRENT_TIMESTAMP
            RETURNING id
          `, [
            productId,
            channelId,
            item.SellerSKU,
            item.ASIN,
            item.Title,
            (item.ItemPrice?.Amount == null)
              ? null
              : (((item.QuantityShipped || 0) > 0 && (item.QuantityOrdered || 0) > (item.QuantityShipped || 0))
                  ? (parseFloat(item.ItemPrice.Amount) / (item.QuantityShipped || 1))
                  : (parseFloat(item.ItemPrice.Amount) / (item.QuantityOrdered || 1)))
          ]);
          
          const qty = item.QuantityOrdered || 1;
          const qtyShipped = item.QuantityShipped || 0;
          const itemPrice = item.ItemPrice?.Amount != null ? parseFloat(item.ItemPrice.Amount) : null;
          const shipPrice = parseFloat(item.ShippingPrice?.Amount || 0);
          const itemTax = parseFloat(item.ItemTax?.Amount || 0);
          const promoDiscount = parseFloat(item.PromotionDiscount?.Amount || 0);

          // Insert order item
          await pool.query(`
            INSERT INTO order_items (
              order_id, channel_listing_id, quantity, unit_price,
              shipping_price, tax, discount, total
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT DO NOTHING
          `, [
            order.id,
            listing.rows[0].id,
            qty,
            (itemPrice == null)
              ? null
              : ((qtyShipped > 0 && qty > qtyShipped)
                  ? (itemPrice / qtyShipped)
                  : (qty ? (itemPrice / qty) : itemPrice)),
            shipPrice,
            itemTax,
            promoDiscount,
            (itemPrice + shipPrice + itemTax - promoDiscount)
          ]);
        }
        
        // After inserting items, update the order_total from line items (more reliable than OrderTotal for some statuses)
        await pool.query(`
          UPDATE orders o
          SET order_total = x.sum_total,
              updated_at = CURRENT_TIMESTAMP
          FROM (
            SELECT order_id, COALESCE(SUM(total),0) AS sum_total
            FROM order_items
            WHERE order_id = $1
            GROUP BY order_id
          ) x
          WHERE o.id = x.order_id;
        `, [order.id]);

        // Rate limit: Wait between order item requests
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`  Error processing order ${order.channel_order_id}:`, error.message);
      }
    }
    
    console.log('\n✅ Amazon sync completed successfully!');
    
  } catch (error) {
    console.error('Sync failed:', error);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  syncAmazon().catch(console.error);
}

module.exports = { syncAmazon };