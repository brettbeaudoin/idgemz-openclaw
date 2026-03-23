# IDGemz OpenClaw

Automation scripts for [IDGemz](https://idgemz.com/) — syncing orders, inventory, and reporting across Amazon, Shopify, Walmart, Etsy, and QuickBooks Online.

Managed by [OpenClaw](https://openclaw.ai/) (Dangerboat 🤖).

## What's Here

### Order Sync (hourly crons)
- `sync-amazon.js` — Amazon SP-API → Postgres
- `sync-shopify.js` — Shopify API → Postgres
- `sync-walmart.js` — Walmart API → Postgres
- `import-etsy-forwarded-emails.js` — Gmail (forwarded Etsy sale emails) → Postgres
- `amazon-sheet-orders-sync.js` — Postgres → Google Sheet (Orders tab)
- `postgres-sheet-orders-sync.js` — Postgres → Google Sheet (all channels)

### Inventory
- `sync-on-hand-inventory.js` — Google Sheet → Postgres (on-hand counts)
- `send-to-amazon-daily-email.js` — FBA restock recommendations email

### Reporting
- `daily-sales-report.js` — Generate daily sales stats (JSON + console)
- `send-daily-sales-report-email.js` — Email the daily report
- `amazon-daily-metrics.js` — Amazon-specific daily metrics
- `find-b2b-customers.sql` — Identify B2B/wholesale buyers

### QuickBooks Online (WIP)
- `qbo-client.js` — QBO API client (OAuth2 + token refresh)
- `qbo-save-token.js` — Save QBO refresh token locally
- `qbo-test-purchases.js` — Test QBO connection
- `qbo-for-review-suggest.js` — Suggest categories for uncategorized purchases
- `qbo-oauth-server.js` — Local OAuth callback server
- `vercel/` — Vercel serverless OAuth callback (for production Intuit redirect)

### Other
- `customer-identity.js` — Customer deduplication
- `shopify-client.js` / `walmart-client.js` — API client helpers
- `migrations/` — Postgres schema migrations
- `dashboard-*.json` / `configure-grafana*.js` — Grafana dashboard configs
- `sheet-sku-mapping.json` — SKU → Google Sheet column mapping per channel

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/brettbeaudoin/idgemz-openclaw.git
cd idgemz-openclaw
npm install
```

### 2. Environment Files (Secrets)

Two `.env` files are required. They are **not** checked into git.

#### `.env` — Core credentials

```bash
cp .env.example .env
```

Then fill in:

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `SELLING_PARTNER_APP_CLIENT_ID` | Amazon SP-API client ID | [Amazon Seller Central → Developer Central → App](https://sellercentral.amazon.com/sellingpartner/developerconsole) |
| `SELLING_PARTNER_APP_CLIENT_SECRET` | Amazon SP-API client secret | Same as above |
| `AWS_ACCESS_KEY_ID` | AWS IAM access key (legacy, may not be needed) | [AWS IAM Console](https://console.aws.amazon.com/iam/) |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret key | Same as above |
| `AWS_SELLING_PARTNER_ROLE` | IAM role ARN for SP-API | Same as above |
| `DATABASE_URL` | Postgres connection string | e.g. `postgresql://user@localhost/idgemz` |
| `REDIRECT_URI` | OAuth callback URL | Default: `http://localhost:8080/callback` |
| `PORT` | OAuth server port | Default: `8080` |

#### `.env.local` — Channel-specific credentials

Create this file manually:

```bash
# QuickBooks Online
QBO_CLIENT_ID=           # Intuit Developer → Your App → Production → Keys
QBO_CLIENT_SECRET=       # Same as above

# Shopify
SHOPIFY_CLIENT_ID=       # Shopify Partners → Your App → Client credentials
SHOPIFY_CLIENT_SECRET=   # Same as above
SHOPIFY_API_VERSION=     # e.g. 2024-10
SHOPIFY_REDIRECT_URI=    # e.g. http://localhost:8080/callback
SHOPIFY_SCOPES=          # e.g. read_orders,read_products
SHOPIFY_SHOP=            # e.g. idgemz.myshopify.com
SHOPIFY_ACCESS_TOKEN=    # From OAuth flow or Shopify admin

# Etsy
ETSY_CLIENT_ID=          # Etsy Developer → Your App
ETSY_CLIENT_SECRET=      # Same as above
ETSY_REDIRECT_URI=       # e.g. http://localhost:8080/callback

# Walmart
WALMART_CLIENT_ID=       # Walmart Developer Portal → Your App
WALMART_CLIENT_SECRET=   # Same as above
WALMART_SELLER_ID=       # Your Walmart Seller ID
```

### 3. Database

Postgres database `idgemz` must exist. Run migrations:

```bash
psql -d idgemz -f migrations/*.sql
```

### 4. Google Sheets Access

Uses [`gog` CLI](https://gogcli.sh/) for Sheets/Gmail. Requires one-time OAuth:

```bash
gog auth add dangerboatai@gmail.com --services gmail,sheets
```

## Cron Schedule (managed by OpenClaw)

| Job | Frequency | Script |
|-----|-----------|--------|
| Amazon orders → Postgres | Hourly :00 | `sync-amazon.js` |
| Shopify orders → Postgres | Hourly :03 | `sync-shopify.js` |
| Walmart orders → Postgres | Daily 7:06 AM ET | `sync-walmart.js` |
| Etsy email import | Hourly :09 | `import-etsy-forwarded-emails.js` |
| Postgres → Google Sheet | Hourly :12 | `amazon-sheet-orders-sync.js` |
| On-hand inventory import | Daily 6:00 AM ET | `sync-on-hand-inventory.js` |
| Daily sales report email | Daily 7:30 AM ET | `send-daily-sales-report-email.js` |
| Send-to-Amazon email | Daily 7:30 AM ET | `send-to-amazon-daily-email.js` |

## License

Private / internal use only.
