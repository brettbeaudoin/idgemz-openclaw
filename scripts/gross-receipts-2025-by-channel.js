#!/usr/bin/env node
/*
Compute gross receipts for calendar year 2025 by channel.

Definition used here:
- Gross receipts = SUM(orders.order_total) for orders with amount_known=true
- Date window = [2025-01-01T00:00:00Z, 2026-01-01T00:00:00Z)
- Excludes obvious cancellations/voids: status ILIKE '%cancel%' or '%void%'

Usage:
  node scripts/gross-receipts-2025-by-channel.js
*/

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const from = '2025-01-01T00:00:00Z';
  const to = '2026-01-01T00:00:00Z';

  const q = await pool.query(
    `SELECT
       c.platform,
       COUNT(*)::int AS orders,
       ROUND(COALESCE(SUM(o.order_total),0)::numeric, 2) AS gross_receipts
     FROM orders o
     JOIN channels c ON c.id=o.channel_id
     WHERE o.order_date >= $1::timestamptz
       AND o.order_date < $2::timestamptz
       AND o.amount_known = true
       AND COALESCE(o.order_total, 0) > 0
       AND NOT (COALESCE(o.status,'') ILIKE '%cancel%' OR COALESCE(o.status,'') ILIKE '%void%')
     GROUP BY c.platform
     ORDER BY gross_receipts DESC`,
    [from, to]
  );

  // Also show overall total
  const total = await pool.query(
    `SELECT ROUND(COALESCE(SUM(o.order_total),0)::numeric, 2) AS gross_receipts
     FROM orders o
     WHERE o.order_date >= $1::timestamptz
       AND o.order_date < $2::timestamptz
       AND o.amount_known = true
       AND COALESCE(o.order_total, 0) > 0
       AND NOT (COALESCE(o.status,'') ILIKE '%cancel%' OR COALESCE(o.status,'') ILIKE '%void%')`,
    [from, to]
  );

  console.log(JSON.stringify({
    window: { from, to },
    byPlatform: q.rows,
    total: total.rows[0]
  }, null, 2));

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
