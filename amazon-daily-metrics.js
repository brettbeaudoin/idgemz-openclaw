// Fetch and persist Amazon daily sales metrics aligned with Seller Central app (Product sales)
// Uses SP-API Sales endpoint: getOrderMetrics (granularity=Day, PT timezone)
//
// Usage:
//   node amazon-daily-metrics.js --date 2026-02-10
//   node amazon-daily-metrics.js --from 2026-01-01 --to 2026-02-01
//   DAYS_BACK=30 node amazon-daily-metrics.js

const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const { DateTime } = require('luxon');
require('dotenv').config();

function parseArgs(argv) {
  const args = {
    date: null,
    from: null,
    to: null,
    chunkDays: null,
    resume: false,
    force: false,
    stateFile: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--chunk-days') args.chunkDays = parseInt(argv[++i], 10);
    else if (a === '--resume') args.resume = true;
    else if (a === '--force') args.force = true;
    else if (a === '--state-file') args.stateFile = argv[++i];
  }
  return args;
}

async function getSpClient(pool) {
  const chRes = await pool.query(
    `SELECT api_credentials FROM channels WHERE platform='amazon' AND api_connected=true ORDER BY name LIMIT 1`
  );
  if (!chRes.rows.length) throw new Error('Amazon channel not connected');
  const refreshToken = chRes.rows[0].api_credentials.refreshToken;

  return new SellingPartner({
    region: 'na',
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
    },
    options: { auto_request_throttled: true }
  });
}

async function fetchMetricsForPtDate(sp, datePt, marketplaceId = 'ATVPDKIKX0DER') {
  const startPt = DateTime.fromISO(datePt, { zone: 'America/Los_Angeles' }).startOf('day');
  const endPt = startPt.plus({ days: 1 });
  const interval = `${startPt.toISO()}--${endPt.toISO()}`;

  const metrics = await sp.callAPI({
    endpoint: 'sales',
    operation: 'getOrderMetrics',
    query: {
      marketplaceIds: [marketplaceId],
      interval,
      granularity: 'Day',
      granularityTimeZone: 'America/Los_Angeles'
    }
  });

  const m = Array.isArray(metrics) ? metrics[0] : null;

  return {
    date_pt: datePt,
    marketplace_id: marketplaceId,
    total_sales: m?.totalSales?.amount ?? 0,
    currency: m?.totalSales?.currencyCode ?? 'USD',
    order_count: m?.orderCount ?? 0,
    order_item_count: m?.orderItemCount ?? 0,
    unit_count: m?.unitCount ?? 0,
    interval: m?.interval || interval,
    raw: m || metrics
  };
}

async function upsert(pool, row) {
  await pool.query(
    `INSERT INTO amazon_daily_metrics (
       date_pt, marketplace_id, total_sales, currency, order_count, order_item_count, unit_count,
       interval, raw, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, now())
     ON CONFLICT (date_pt) DO UPDATE SET
       marketplace_id=EXCLUDED.marketplace_id,
       total_sales=EXCLUDED.total_sales,
       currency=EXCLUDED.currency,
       order_count=EXCLUDED.order_count,
       order_item_count=EXCLUDED.order_item_count,
       unit_count=EXCLUDED.unit_count,
       interval=EXCLUDED.interval,
       raw=EXCLUDED.raw,
       fetched_at=now()`,
    [
      row.date_pt,
      row.marketplace_id,
      row.total_sales,
      row.currency,
      row.order_count,
      row.order_item_count,
      row.unit_count,
      row.interval,
      JSON.stringify(row.raw)
    ]
  );
}

async function existsDate(pool, datePt) {
  const res = await pool.query(`SELECT 1 FROM amazon_daily_metrics WHERE date_pt=$1 LIMIT 1`, [datePt]);
  return !!res.rows.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

  const fs = require('fs');
  const path = require('path');

  const defaultStateFile = path.resolve(__dirname, '../memory/amazon-daily-metrics-backfill.json');
  const stateFile = args.stateFile ? path.resolve(args.stateFile) : defaultStateFile;

  function loadState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function saveState(s) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  }

  try {
    const sp = await getSpClient(pool);

    // Build date list
    let dates = [];
    if (args.date) {
      dates = [args.date];
    } else {
      let from = args.from;
      let to = args.to;

      if (args.resume) {
        const s = loadState();
        if (s?.cursorDatePt && !from) from = s.cursorDatePt;
        if (s?.to && !to) to = s.to;
      }

      if (from && to) {
        const start = DateTime.fromISO(from, { zone: 'America/Los_Angeles' }).startOf('day');
        const end = DateTime.fromISO(to, { zone: 'America/Los_Angeles' }).startOf('day');
        for (let d = start; d < end; d = d.plus({ days: 1 })) {
          dates.push(d.toISODate());
        }
      } else {
        const daysBack = parseInt(process.env.DAYS_BACK || '7', 10);
        const start = DateTime.now().setZone('America/Los_Angeles').minus({ days: daysBack }).startOf('day');
        const end = DateTime.now().setZone('America/Los_Angeles').startOf('day');
        for (let d = start; d < end; d = d.plus({ days: 1 })) {
          dates.push(d.toISODate());
        }
      }
    }

    const chunkDays = args.chunkDays || parseInt(process.env.CHUNK_DAYS || '30', 10);

    console.log(`Fetching Amazon daily metrics for ${dates.length} day(s)... (chunkDays=${chunkDays}, resume=${args.resume}, force=${args.force})`);
    console.log(`State file: ${stateFile}`);

    let processed = 0;

    for (let i = 0; i < dates.length; i++) {
      const datePt = dates[i];

      if (!args.force) {
        const already = await existsDate(pool, datePt);
        if (already) {
          processed++;
          if (processed % chunkDays === 0) {
            saveState({ cursorDatePt: dates[i + 1] || null, to: args.to || null, updatedAt: new Date().toISOString(), processed });
          }
          continue;
        }
      }

      const row = await fetchMetricsForPtDate(sp, datePt);
      await upsert(pool, row);
      console.log(`${datePt} PT: $${Number(row.total_sales).toFixed(2)} (${row.order_count} orders, ${row.unit_count} units)`);

      processed++;

      if (processed % chunkDays === 0) {
        const next = dates[i + 1] || null;
        saveState({ cursorDatePt: next, to: args.to || null, updatedAt: new Date().toISOString(), processed });
        console.log(`Checkpoint saved. Next cursorDatePt=${next}`);
      }

      // light pacing
      await new Promise((r) => setTimeout(r, 250));
    }

    // Final checkpoint
    saveState({ cursorDatePt: null, to: args.to || null, updatedAt: new Date().toISOString(), processed, done: true });
    console.log('Done.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('amazon-daily-metrics failed:', e?.message || e);
    process.exit(1);
  });
}
