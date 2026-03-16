#!/usr/bin/env node

// Import Etsy statement CSVs into Postgres.
// Creates/updates Etsy orders (order_total) and inserts transaction rows.
// Designed to work without Etsy API access.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { DateTime } = require('luxon');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inq && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inq = !inq;
      }
    } else if (ch === ',' && !inq) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const r = {};
    headers.forEach((h, idx) => {
      r[h] = cols[idx];
    });
    rows.push(r);
  }
  return rows;
}

function parseMoney(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s || s === '--') return 0;
  // Etsy exports are like "$15.90" or "-$3.79"
  const neg = s.startsWith('-');
  const num = Number(s.replace(/[^0-9.]/g, ''));
  return neg ? -num : num;
}

function extractOrderId(row) {
  const hay = `${row.Title || ''} ${row.Info || ''}`;
  const m = hay.match(/Order\s*#(\d+)/i);
  return m ? m[1] : null;
}

function parseStatementDate(dateStr) {
  // Example: "January 31, 2024"
  const dt = DateTime.fromFormat(dateStr.trim(), 'LLLL d, yyyy', { zone: 'America/Los_Angeles' });
  if (!dt.isValid) return null;
  // store as timestamp (use midday PT to avoid DST edge nonsense)
  return dt.set({ hour: 12, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO();
}

async function main() {
  const inputFiles = process.argv.slice(2);
  if (!inputFiles.length) {
    console.error('Usage: import-etsy-statements.js <csv1> <csv2> ...');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

  // Find Etsy channel
  const chRes = await pool.query(`SELECT id FROM channels WHERE platform='etsy' ORDER BY name LIMIT 1`);
  if (!chRes.rows.length) throw new Error('No Etsy channel found in channels table');
  const etsyChannelId = chRes.rows[0].id;

  // Load all rows
  let rows = [];
  for (const f of inputFiles) {
    const full = path.resolve(f);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${full}`);
    const r = readCsv(full);
    rows = rows.concat(r);
    console.log(`Loaded ${r.length} rows from ${full}`);
  }

  // Group by order_id when present
  const byOrder = new Map();
  const orphan = [];

  for (const row of rows) {
    const orderId = extractOrderId(row);
    if (!orderId) {
      orphan.push(row);
      continue;
    }
    if (!byOrder.has(orderId)) byOrder.set(orderId, []);
    byOrder.get(orderId).push(row);
  }

  console.log(`Rows with order id: ${Array.from(byOrder.values()).reduce((a, v) => a + v.length, 0)}; orphan rows: ${orphan.length}`);
  console.log(`Distinct orders found: ${byOrder.size}`);

  let upsertedOrders = 0;
  let insertedTx = 0;

  await pool.query('BEGIN');
  try {
    // Insert a sync log entry (optional)
    const syncIdRes = await pool.query(
      `INSERT INTO sync_logs (channel_id, sync_type, status, records_processed, details)
       VALUES ($1,'etsy_statement_import','running',0,$2::jsonb)
       RETURNING id`,
      [etsyChannelId, JSON.stringify({ files: inputFiles.map((p) => path.resolve(p)), importedAt: new Date().toISOString() })]
    );
    const syncLogId = syncIdRes.rows[0].id;

    for (const [orderId, group] of byOrder.entries()) {
      // Determine a reasonable order_date: earliest statement row date for this order
      const dates = group.map((r) => parseStatementDate(r.Date)).filter(Boolean).sort();
      const orderDateIso = dates[0] || new Date().toISOString();

      // Order gross heuristic (matches what we *can* extract without itemized order exports):
      // Sum of positive inflows for this order: Sale + Payment + Buyer Fee
      // Plus refunds (negative).
      // NOTE: This intentionally excludes fees/shipping labels/marketing/tax lines.
      let orderTotal = 0;
      for (const r of group) {
        const t = (r.Type || '').trim();
        if (t === 'Sale' || t === 'Payment' || t === 'Buyer Fee' || t === 'Refund') {
          orderTotal += parseMoney(r.Amount);
        }
      }
      // Upsert order
      const orderRes = await pool.query(
        `INSERT INTO orders (channel_id, channel_order_id, order_date, order_total, currency, status, fulfillment_channel)
         VALUES ($1,$2,$3,$4,'USD','Imported','etsy')
         ON CONFLICT (channel_id, channel_order_id)
         DO UPDATE SET order_date=LEAST(orders.order_date, EXCLUDED.order_date),
                       order_total=COALESCE(orders.order_total, 0) + EXCLUDED.order_total,
                       updated_at=NOW()
         RETURNING id`,
        [etsyChannelId, orderId, orderDateIso, orderTotal]
      );
      const orderDbId = orderRes.rows[0].id;
      upsertedOrders++;

      // Insert transactions for each row in the group (dedupe-ish by (order_id, type, amount, date, description))
      for (const r of group) {
        const txType = (r.Type || '').toLowerCase().replace(/\s+/g, '_');
        const amount = parseMoney(r.Amount) + parseMoney(r['Fees & Taxes'] || '0');
        // For rows where Amount is '--' but Fees & Taxes has a value, above captures it.
        // For Sale rows, Fees & Taxes is '--', so amount is the sale amount.

        const txDateIso = parseStatementDate(r.Date) || orderDateIso;
        const desc = [r.Type, r.Title, r.Info].filter(Boolean).join(' — ').slice(0, 1000);

        // Use a lightweight uniqueness check to avoid inserting duplicates if you rerun import.
        const exists = await pool.query(
          `SELECT 1 FROM transactions
           WHERE channel_id=$1 AND order_id=$2 AND transaction_type=$3 AND amount=$4 AND transaction_date=$5 AND description=$6
           LIMIT 1`,
          [etsyChannelId, orderDbId, txType, amount, txDateIso, desc]
        );
        if (exists.rows.length) continue;

        await pool.query(
          `INSERT INTO transactions (channel_id, order_id, transaction_type, amount, currency, description, transaction_date)
           VALUES ($1,$2,$3,$4,'USD',$5,$6)`,
          [etsyChannelId, orderDbId, txType, amount, desc, txDateIso]
        );
        insertedTx++;
      }
    }

    await pool.query(
      `UPDATE sync_logs SET status='completed', completed_at=NOW(), records_processed=$2
       WHERE id=$1`,
      [syncLogId, upsertedOrders]
    );

    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  } finally {
    await pool.end();
  }

  console.log(`Done. Upserted orders: ${upsertedOrders}. Inserted transactions: ${insertedTx}.`);
}

main().catch((e) => {
  console.error('Import failed:', e?.stack || e);
  process.exit(1);
});
