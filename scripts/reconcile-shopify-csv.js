#!/usr/bin/env node
/*
Reconcile Shopify CSV exports with Postgres.

Usage:
  node scripts/reconcile-shopify-csv.js <csv1> <csv2> ...

Looks for two Shopify export formats:
- Orders export: header starts with "Name,Email,Financial Status,..." and includes columns: Name, Id, Total, Created at, Paid at
- Payments export: header starts with "Order,Name,Kind,Gateway,..." and includes columns: Order, Name, Created At, Status, Amount

Outputs:
- CSV stats (row count, unique order ids, date range, totals)
- DB stats for existing shopify channel + orders present
*/

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function splitCsvLine(line) {
  // Split on commas not inside quotes
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // handle escaped quotes ""
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`Empty CSV: ${filePath}`);
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length === 1 && cols[0] === '') continue;
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cols[c] ?? '';
    rows.push(row);
  }
  return { header, rows };
}

function parseNumber(x) {
  const n = Number(String(x ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDate(x) {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

function summarizeOrdersExport(rows) {
  const orderIds = new Set();
  let totalSum = 0;
  let totalKnown = 0;
  let minCreated = null;
  let maxCreated = null;

  for (const r of rows) {
    const id = r['Id'] || r['Order'] || r['order_id'];
    if (id) orderIds.add(String(id));
    const t = parseNumber(r['Total']);
    if (t != null) {
      totalSum += t;
      totalKnown++;
    }
    const created = parseDate(r['Created at']);
    if (created) {
      if (!minCreated || created < minCreated) minCreated = created;
      if (!maxCreated || created > maxCreated) maxCreated = created;
    }
  }

  return {
    rows: rows.length,
    uniqueOrderIds: orderIds.size,
    totalSum,
    totalKnown,
    createdRange: { min: minCreated, max: maxCreated },
  };
}

function summarizePaymentsExport(rows) {
  const orderIds = new Set();
  let amountSum = 0;
  let amountKnown = 0;
  let minCreated = null;
  let maxCreated = null;
  let success = 0;

  for (const r of rows) {
    const id = r['Order'];
    if (id) orderIds.add(String(id));
    const amt = parseNumber(r['Amount']);
    if (amt != null) {
      amountSum += amt;
      amountKnown++;
    }
    const created = parseDate(r['Created At']);
    if (created) {
      if (!minCreated || created < minCreated) minCreated = created;
      if (!maxCreated || created > maxCreated) maxCreated = created;
    }
    if ((r['Status'] || '').toLowerCase() === 'success') success++;
  }

  return {
    rows: rows.length,
    uniqueOrderIds: orderIds.size,
    amountSum,
    amountKnown,
    success,
    createdRange: { min: minCreated, max: maxCreated },
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Pass one or more CSV paths');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  let channel = null;
  try {
    const ch = await pool.query(
      `SELECT id, platform, api_connected FROM channels WHERE platform='shopify' ORDER BY id DESC LIMIT 1`
    );
    channel = ch.rows[0] || null;
  } catch (e) {
    console.warn('DB: could not query channels table:', e.message);
  }

  console.log('DB Shopify channel:', channel || '(none found)');

  if (channel?.id) {
    try {
      const stats = await pool.query(
        `SELECT COUNT(*)::int AS orders, MIN(order_date) AS min_order_date, MAX(order_date) AS max_order_date
         FROM orders WHERE channel_id=$1`,
        [channel.id]
      );
      console.log('DB orders for shopify channel:', stats.rows[0]);

      const items = await pool.query(
        `SELECT COUNT(*)::int AS order_items FROM order_items oi
         JOIN orders o ON o.id=oi.order_id
         WHERE o.channel_id=$1`,
        [channel.id]
      );
      console.log('DB order_items for shopify channel:', items.rows[0]);
    } catch (e) {
      console.warn('DB: could not query orders/order_items:', e.message);
    }
  }

  console.log('\nCSV summaries:');
  for (const f of files) {
    const fp = path.resolve(f);
    const { header, rows } = parseCsv(fp);
    const isPayments = header[0] === 'Order' && header.includes('Amount') && header.includes('Gateway');
    const isOrders = header[0] === 'Name' && header.includes('Total') && header.includes('Id');

    console.log(`\n- ${path.basename(fp)}`);
    console.log(`  columns: ${header.length}, rows: ${rows.length}`);

    if (isOrders) {
      const s = summarizeOrdersExport(rows);
      console.log(`  type: orders export`);
      console.log(`  unique order Ids: ${s.uniqueOrderIds}`);
      console.log(`  created range: ${s.createdRange.min?.toISOString() || '-'} .. ${s.createdRange.max?.toISOString() || '-'}`);
      console.log(`  Total sum (known ${s.totalKnown}): ${s.totalSum.toFixed(2)}`);
    } else if (isPayments) {
      const s = summarizePaymentsExport(rows);
      console.log(`  type: payments export`);
      console.log(`  unique Order ids: ${s.uniqueOrderIds}`);
      console.log(`  created range: ${s.createdRange.min?.toISOString() || '-'} .. ${s.createdRange.max?.toISOString() || '-'}`);
      console.log(`  Amount sum (known ${s.amountKnown}): ${s.amountSum.toFixed(2)}; success rows: ${s.success}`);
    } else {
      console.log('  type: unknown (header did not match expected Shopify exports)');
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
