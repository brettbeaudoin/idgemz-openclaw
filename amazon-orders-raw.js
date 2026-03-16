// Fetch raw Amazon SP-API orders JSON for a specific window.
// Default: system "yesterday" mapped to PT day boundaries (00:00–24:00 America/Los_Angeles).
//
// Usage examples:
//   node amazon-orders-raw.js --yesterday-pt
//   node amazon-orders-raw.js --pt-date 2026-02-05
//
// Output: prints the full JSON response to stdout.

// Force any incidental logs to stderr so stdout stays valid JSON.
console.log = (...args) => console.error(...args);

const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const { DateTime } = require('luxon');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const modeYesterdayPt = argv.includes('--yesterday-pt');
  const ptDate = argValue('--pt-date'); // YYYY-MM-DD

  // Get refresh token from DB
  const result = await pool.query(`
    SELECT api_credentials
    FROM channels
    WHERE platform = 'amazon' AND api_connected = true
    LIMIT 1
  `);
  if (!result.rows.length) throw new Error('Amazon channel not connected');

  const { refreshToken } = result.rows[0].api_credentials;

  const sp = new SellingPartner({
    region: 'na',
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
    },
    options: { auto_request_throttled: true }
  });

  let reportDateStr;
  if (ptDate) {
    reportDateStr = ptDate;
  } else if (modeYesterdayPt) {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    reportDateStr = DateTime.now().setZone(systemTz).minus({ days: 1 }).toISODate();
  } else {
    // default to yesterday-pt behavior
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    reportDateStr = DateTime.now().setZone(systemTz).minus({ days: 1 }).toISODate();
  }

  const startPt = DateTime.fromISO(reportDateStr, { zone: 'America/Los_Angeles' }).startOf('day');
  const endPt = startPt.plus({ days: 1 });

  const query = {
    MarketplaceIds: ['ATVPDKIKX0DER'],
    CreatedAfter: startPt.toUTC().toISO(),
    CreatedBefore: endPt.toUTC().toISO()
  };

  const resp = await sp.callAPI({
    endpoint: 'orders',
    operation: 'getOrders',
    query
  });

  try {
    process.stdout.write(JSON.stringify({
      ptDay: reportDateStr,
      createdAfterUtc: query.CreatedAfter,
      createdBeforeUtc: query.CreatedBefore,
      response: resp
    }, null, 2));
  } catch (e) {
    // Ignore broken pipe (e.g., when piped to `head`/`jq` that exits early)
    if (e?.code !== 'EPIPE') throw e;
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
