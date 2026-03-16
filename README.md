# IDGemz Multi-Channel Sync

This system syncs your sales data from Amazon, Walmart, Shopify, and Etsy into a PostgreSQL database.

## Setup Instructions

### 1. PostgreSQL Setup ✅
- Database `idgemz` is created and running
- Schema includes tables for products, orders, inventory, reviews, etc.

### 2. Amazon SP-API Setup

#### In Seller Central:
1. Go to **Partner Network** → **Develop Apps**
2. If you don't see this option, request developer access (takes 1-2 days)
3. Once approved, click **"Add new app client"**
4. Fill in:
   - App name: `IDGemz Data Sync`
   - OAuth login URI: `http://localhost:8080/callback`
   - OAuth redirect URI: `http://localhost:8080/callback`
5. Save the app and note your:
   - LWA Client ID
   - LWA Client Secret

#### AWS Credentials (No longer needed!):
Amazon removed the AWS requirement in late 2023. You can skip AWS setup! 🎉

### 3. Configure Environment

1. Copy the example env file:
```bash
cp .env.example .env
```

2. Fill in your credentials in `.env`:
```
SELLING_PARTNER_APP_CLIENT_ID=amzn1.application-oa2-client.xxxxx
SELLING_PARTNER_APP_CLIENT_SECRET=xxxxx
# Leave AWS fields empty - not needed anymore!
```

### 4. Authorize Your Account

1. Start the OAuth server:
```bash
node oauth-server.js
```

2. Visit http://localhost:8080 in your browser
3. Click the authorization link
4. Log into your Seller Central account
5. Approve the app permissions
6. You'll be redirected back with success message

### 5. Sync Your Data

Run the sync manually:
```bash
node sync-amazon.js
```

Or set up a cron job to run it hourly/daily.

### 6. View Your Data

Check the dashboard:
```bash
node dashboard.js
```

Or query PostgreSQL directly:
```bash
psql -d idgemz
```

Example queries:
```sql
-- Today's sales
SELECT COUNT(*), SUM(order_total) 
FROM orders 
WHERE order_date::date = CURRENT_DATE;

-- Best selling products
SELECT p.title, COUNT(*) as sales
FROM order_items oi
JOIN channel_listings cl ON oi.channel_listing_id = cl.id
JOIN products p ON cl.product_id = p.id
GROUP BY p.title
ORDER BY sales DESC
LIMIT 10;
```

## Shopify sync

Prereqs (in `.env.local`):
- `SHOPIFY_SHOP` (e.g. `c5e7b1-48.myshopify.com`)
- `SHOPIFY_ACCESS_TOKEN` (from the OAuth helper)
- `SHOPIFY_API_VERSION` (default `2026-01`)
- `DATABASE_URL`

Run a one-time bootstrap from Feb 1, 2023:
```bash
npm run shopify:bootstrap
```

Run daily incremental (yesterday ET):
```bash
npm run shopify:daily
```

Ad-hoc range options:
```bash
node sync-shopify.js --since-days 2
node sync-shopify.js --start 2025-01-01 --end 2025-02-01
```

Notes:
- Uses Shopify Admin REST API + cursor pagination.
- Writes into normalized tables (`orders`, `order_items`, `products`, `channel_listings`) and stores raw payloads in `shopify_orders`.

## Next Steps

1. Set up hourly sync cron job
2. Add Walmart integration (using Walmart Marketplace API)
3. Add Etsy integration (using Etsy API v3)
4. Build analytics dashboard with charts

## Troubleshooting

- **"No Amazon connection found"**: Run `oauth-server.js` first
- **"Role not found" error**: AWS credentials not needed anymore!
- **Rate limits**: SP-API has rate limits, the sync handles this automatically