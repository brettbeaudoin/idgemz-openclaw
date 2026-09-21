#!/usr/bin/env node

/**
 * Print the active Amazon ASIN inventory used by the weekly review watcher.
 * Read-only helper for OpenClaw cron runs.
 */

const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz'
});

async function main() {
  const { rows } = await pool.query(`
    with asin_sources as (
      select
        upper(btrim(pi.id_value)) as asin,
        p.internal_sku,
        p.title,
        'product_identifiers' as source
      from public.product_identifiers pi
      join public.products p on p.id = pi.product_id
      where pi.id_type in ('amazon_asin', 'asin')
        and pi.active is not false
        and btrim(pi.id_value) <> ''

      union all

      select
        upper(btrim(cl.asin)) as asin,
        p.internal_sku,
        coalesce(nullif(cl.title, ''), p.title) as title,
        'channel_listings' as source
      from public.channel_listings cl
      join public.channels c on c.id = cl.channel_id
      left join public.products p on p.id = cl.product_id
      where c.platform = 'amazon'
        and cl.asin is not null
        and btrim(cl.asin) <> ''
        and coalesce(lower(cl.status), '') not in ('inactive', 'archived', 'deleted')
    )
    select
      asin,
      min(internal_sku) filter (where internal_sku is not null and internal_sku <> '') as internal_sku,
      min(title) filter (where title is not null and title <> '') as title,
      array_agg(distinct source order by source) as sources
    from asin_sources
    group by asin
    order by asin
  `);

  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: rows.length,
    asins: rows
  }, null, 2)}\n`);
}

main()
  .catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
