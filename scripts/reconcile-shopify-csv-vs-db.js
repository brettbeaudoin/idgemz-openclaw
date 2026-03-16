#!/usr/bin/env node
/*
Reconcile Shopify CSV exports (orders + payments) vs Postgres orders table.

Usage:
  node scripts/reconcile-shopify-csv-vs-db.js \
    --orders-csv <orders_export.csv> \
    --payments-csv <payments_export.csv>

Notes:
- Orders CSV uses column 'Id' (Shopify order id) and 'Total'. Multiple rows per order (line items).
- Payments CSV uses column 'Order' (Shopify order id) and 'Amount'. Multiple rows per order possible.

Outputs:
- Missing in DB, missing in CSV
- Totals mismatches per order (CSV Total vs DB order_total)
- Payments mismatches (sum(payments) vs DB order_total) for a sanity check
*/

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function splitCsvLine(line) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
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
  if (!lines.length) throw new Error(`Empty CSV: ${filePath}`);
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cols[c] ?? '';
    rows.push(row);
  }
  return { header, rows };
}

function n(x) {
  const v = Number(String(x ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function approxEq(a, b, eps = 0.01) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--orders-csv') args.ordersCsv = argv[++i];
    else if (a === '--payments-csv') args.paymentsCsv = argv[++i];
  }
  if (!args.ordersCsv || !args.paymentsCsv) {
    console.error('Usage: node scripts/reconcile-shopify-csv-vs-db.js --orders-csv <...> --payments-csv <...>');
    process.exit(2);
  }
  return args;
}

function buildOrdersIndex(rows) {
  // Use first non-empty Total per order id.
  const byId = new Map();
  for (const r of rows) {
    const id = (r['Id'] || '').trim();
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: r['Name'] || null,
        createdAt: r['Created at'] || null,
        total: n(r['Total']),
        rows: 1,
      });
    } else {
      const cur = byId.get(id);
      cur.rows++;
      // sometimes Total repeats, keep the first parsed
      if (cur.total == null) cur.total = n(r['Total']);
    }
  }
  return byId;
}

function buildPaymentsIndex(rows) {
  const byId = new Map();
  for (const r of rows) {
    const id = (r['Order'] || '').trim();
    if (!id) continue;
    const kind = (r['Kind'] || '').toLowerCase();
    const amt = n(r['Amount']) || 0;

    const cur = byId.get(id) || {
      id,
      rows: 0,
      gross: 0,
      refunds: 0,
      net: 0
    };

    cur.rows++;

    // Payments export includes both captures/sales and refunds as positive numbers.
    // Treat refunds as negative for net.
    if (kind === 'refund') {
      cur.refunds += amt;
      cur.net -= amt;
    } else {
      cur.gross += amt;
      cur.net += amt;
    }

    byId.set(id, cur);
  }
  return byId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ordersCsv = path.resolve(args.ordersCsv);
  const paymentsCsv = path.resolve(args.paymentsCsv);

  const ordersParsed = parseCsv(ordersCsv);
  const paymentsParsed = parseCsv(paymentsCsv);

  const ordersIdx = buildOrdersIndex(ordersParsed.rows);
  const paymentsIdx = buildPaymentsIndex(paymentsParsed.rows);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ch = await pool.query("select id from channels where platform='shopify' order by updated_at desc nulls last limit 1");
  const cid = ch.rows[0]?.id;
  if (!cid) throw new Error('No shopify channel found in DB');

  const db = await pool.query(
    `select channel_order_id, order_total, status, order_date
     from orders
     where channel_id=$1`,
    [cid]
  );

  const dbById = new Map();
  for (const r of db.rows) {
    dbById.set(String(r.channel_order_id), {
      id: String(r.channel_order_id),
      orderTotal: r.order_total == null ? null : Number(r.order_total),
      status: r.status,
      orderDate: r.order_date,
    });
  }

  const csvIds = new Set(ordersIdx.keys());
  const dbIds = new Set(dbById.keys());

  const missingInDb = [];
  for (const id of csvIds) if (!dbIds.has(id)) missingInDb.push(id);

  const missingInCsv = [];
  for (const id of dbIds) if (!csvIds.has(id)) missingInCsv.push(id);

  const totalMismatches = [];
  for (const [id, o] of ordersIdx.entries()) {
    const d = dbById.get(id);
    if (!d) continue;
    const csvTotal = o.total;
    const dbTotal = d.orderTotal;
    if (csvTotal == null || dbTotal == null) continue;
    if (!approxEq(csvTotal, dbTotal)) {
      totalMismatches.push({ id, name: o.name, csvTotal, dbTotal, status: d.status });
    }
  }

  const paymentsMismatches = [];
  for (const [id, p] of paymentsIdx.entries()) {
    const d = dbById.get(id);
    if (!d) continue;
    const dbTotal = d.orderTotal;
    if (dbTotal == null) continue;
    if (!approxEq(p.net, dbTotal)) {
      paymentsMismatches.push({
        id,
        paymentsNet: Number(p.net.toFixed(2)),
        paymentsGross: Number(p.gross.toFixed(2)),
        paymentsRefunds: Number(p.refunds.toFixed(2)),
        dbTotal,
        status: d.status
      });
    }
  }

  // Print summary
  console.log(JSON.stringify({
    inputs: { ordersCsv: path.basename(ordersCsv), paymentsCsv: path.basename(paymentsCsv) },
    counts: {
      csvOrdersUnique: csvIds.size,
      csvPaymentsUnique: new Set(paymentsIdx.keys()).size,
      dbOrders: dbIds.size,
      missingInDb: missingInDb.length,
      missingInCsv: missingInCsv.length,
      totalMismatches: totalMismatches.length,
      paymentsMismatches: paymentsMismatches.length
    },
    samples: {
      missingInDb: missingInDb.slice(0, 25),
      missingInCsv: missingInCsv.slice(0, 25),
      totalMismatches: totalMismatches.slice(0, 25),
      paymentsMismatches: paymentsMismatches.slice(0, 25)
    }
  }, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
