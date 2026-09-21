#!/usr/bin/env node

/**
 * Daily “Send to Amazon” Telegram delivery.
 *
 * Pulls SP-API Restock Recommendations report, filters SKUs per Brett rules,
 * writes a printable TSV attachment, and sends it to Brett on Telegram.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { SellingPartner } = require('amazon-sp-api');
const { DateTime } = require('luxon');
const { spawnSync } = require('child_process');

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatHtmlDocument(rows, dateStr) {
  const rowHtml = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.sku)}</td>
      <td class="num">${escapeHtml(r.available)}</td>
      <td class="num">${escapeHtml(r.inbound)}</td>
      <td class="num">${escapeHtml(r.reserved)}</td>
      <td class="num">${escapeHtml(r.total)}</td>
      <td class="num">${escapeHtml(r.recommended)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Send to Amazon — ${escapeHtml(dateStr)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 8px 0; font-size: 24px; }
    p { margin: 0 0 16px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; }
    th { background: #f3f4f6; text-align: left; }
    tbody tr:nth-child(even) {
      background: #f8f9fa;
    }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .note { margin-top: 14px; font-size: 12px; color: #444; }
  </style>
</head>
<body>
  <h1>Send to Amazon</h1>
  <p>${escapeHtml(dateStr)}</p>
  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Available</th>
        <th>Inbound</th>
        <th>Reserved</th>
        <th>Total</th>
        <th>Recommended qty</th>
      </tr>
    </thead>
    <tbody>
      ${rowHtml || '<tr><td colspan="6">No SKUs matched the restock filter today.</td></tr>'}
    </tbody>
  </table>
  <div class="note">Filter: recommended_qty &gt;= 5 OR (available + inbound + reserved) &lt; 10</div>
</body>
</html>`;
}

function getAllowedAttachmentDir() {
  return process.env.SEND_TO_AMAZON_ATTACHMENT_DIR
    || path.join('/tmp', 'openclaw', 'idgemz');
}

function sendTelegramWithAttachment({ channel, target, caption, attachmentPath }) {
  const args = [
    'message', 'send',
    '--channel', channel,
    '--target', target,
    '--message', caption,
    '--media', attachmentPath,
    '--force-document'
  ];

  const result = spawnSync('openclaw', args, {
    encoding: 'utf8',
    timeout: 180000
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(combined || `openclaw message send failed with status ${result.status}`);
  }

  return { mode: 'attachment' };
}

const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const TELEGRAM_TARGET = process.env.SEND_TO_AMAZON_TELEGRAM_TARGET || '8130524019';
const TELEGRAM_CHANNEL = process.env.SEND_TO_AMAZON_CHANNEL || 'telegram';

function num(x) {
  if (x == null) return 0;
  const s = String(x).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function tsvParse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => l.split('\t'));
  return { header, rows };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableReportError(error) {
  const detail = `${error?.code || ''} ${error?.message || ''}`;
  return /REPORT_PROCESSING_(?:FATAL|CANCELLED|CANCELLED_MANUALLY)|Something went wrong while processing the report|Report did not finish/i.test(detail);
}

async function downloadReportWithRetry(sp, params, label, { retries = 2, delayMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sp.downloadReport(params);
    } catch (error) {
      if (attempt >= retries || !isRetryableReportError(error)) throw error;
      console.warn(`${label} report processing failed (${error?.code || error?.message || error}); retrying in ${Math.round(delayMs / 1000)}s.`);
      await sleep(delayMs);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const inventoryOnly = argv.includes('--refresh-inventory-only') || argv.includes('--inventory-only');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });
  try {
    const chRes = await pool.query(
      `SELECT id, api_credentials
       FROM channels
       WHERE platform='amazon' AND api_connected=true
       ORDER BY name
       LIMIT 1`
    );
    if (!chRes.rows.length) throw new Error('Amazon channel not connected');
    const amazonChannelId = chRes.rows[0].id;
    const refreshToken = chRes.rows[0].api_credentials.refreshToken;

    const sp = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      options: { auto_request_throttled: true }
    });

    try {
      console.log('Refreshing Amazon FBA inventory into Postgres (MYI report)...');

      const mapRes = await pool.query(
        `SELECT sku, product_id
         FROM (
           SELECT cl.channel_sku AS sku, cl.product_id, 0 AS priority
           FROM public.channel_listings cl
           WHERE cl.channel_id = $1
           UNION ALL
           SELECT pi.id_value AS sku, pi.product_id, 1 AS priority
           FROM public.product_identifiers pi
           JOIN public.products p ON p.id = pi.product_id
           WHERE pi.id_type = 'amazon_sku'
             AND pi.active = true
             AND p.deprecated = false
           UNION ALL
           SELECT p.internal_sku AS sku, p.id AS product_id, 2 AS priority
           FROM public.products p
           WHERE p.deprecated = false
         ) sku_map
         WHERE sku IS NOT NULL AND sku <> ''
         ORDER BY priority`,
        [amazonChannelId]
      );
      const skuToProductId = new Map();
      for (const r of mapRes.rows) {
        const sku = String(r.sku);
        if (!skuToProductId.has(sku)) skuToProductId.set(sku, String(r.product_id));
      }

      const myiTsv = await downloadReportWithRetry(sp, {
        body: {
          reportType: 'GET_FBA_MYI_ALL_INVENTORY_DATA',
          marketplaceIds: [MARKETPLACE_ID]
        },
        interval: 15000,
        cancel_after: 12,
        download: { unzip: true, charset: 'utf8' }
      }, 'Amazon MYI');

      const parsed = tsvParse(myiTsv);
      const header = parsed.header;
      const rows = parsed.rows;
      const idx = Object.fromEntries(header.map((h, i) => [String(h).trim().toLowerCase(), i]));

      function col(...names) {
        for (const n of names) {
          const i = idx[String(n).trim().toLowerCase()];
          if (i != null) return i;
        }
        return null;
      }

      const cSku = col('seller-sku', 'sku', 'merchant sku', 'merchant sku (msku)');
      const cFulfillable = col('afn-fulfillable-quantity', 'fulfillable');
      const cReserved = col('afn-reserved-quantity', 'reserved');
      const cInboundWorking = col('afn-inbound-working-quantity', 'inbound working');
      const cInboundShipped = col('afn-inbound-shipped-quantity', 'inbound shipped');
      const cInboundReceiving = col('afn-inbound-receiving-quantity', 'inbound receiving');

      if ([cSku, cFulfillable, cReserved, cInboundWorking, cInboundShipped, cInboundReceiving].some((v) => v == null)) {
        throw new Error(`MYI report missing expected columns. Header: ${header.join(', ')}`);
      }

      let upserts = 0;
      let misses = 0;
      const missingSkus = [];

      for (const r of rows) {
        const sellerSku = String(r[cSku] || '').trim();
        if (!sellerSku) continue;

        const available = num(r[cFulfillable]);
        const reserved = num(r[cReserved]);
        const inbound = num(r[cInboundWorking]) + num(r[cInboundShipped]) + num(r[cInboundReceiving]);

        const productId = skuToProductId.get(sellerSku);
        if (!productId) {
          if (available || reserved || inbound) {
            misses++;
            if (missingSkus.length < 200) missingSkus.push(sellerSku);
          }
          continue;
        }

        await pool.query(
          `INSERT INTO public.inventory (
            product_id, channel_id, quantity_available,
            quantity_reserved, quantity_inbound, warehouse_location, last_updated
          ) VALUES ($1, $2, $3, $4, $5, 'FBA', CURRENT_TIMESTAMP)
          ON CONFLICT (product_id, channel_id, warehouse_location)
          DO UPDATE SET
            quantity_available = EXCLUDED.quantity_available,
            quantity_reserved = EXCLUDED.quantity_reserved,
            quantity_inbound = EXCLUDED.quantity_inbound,
            last_updated = CURRENT_TIMESTAMP`,
          [productId, amazonChannelId, available, reserved, inbound]
        );

        upserts++;
      }

      if (upserts > 0) {
        await pool.query(
          `UPDATE public.inventory
           SET quantity_available = 0,
               quantity_reserved = 0,
               quantity_inbound = 0,
               last_updated = CURRENT_TIMESTAMP
           WHERE channel_id = $1
             AND warehouse_location = 'FBA'
             AND last_updated < (CURRENT_TIMESTAMP - INTERVAL '1 minute')`,
          [amazonChannelId]
        );
      }

      const uniqMissing = Array.from(new Set(missingSkus)).sort();
      console.log(`Inventory refresh complete (MYI): upserted ${upserts} rows (unmapped SKUs: ${misses}).`);
      if (misses) console.log(`Unmapped SKUs (sample): ${uniqMissing.slice(0, 50).join(', ')}`);
      if (inventoryOnly) {
        if (misses) {
          console.log('Unmapped SKUs (full list):');
          console.log(uniqMissing.join('\n'));
        }
        console.log('Inventory-only mode: skipping Telegram send.');
        return;
      }
    } catch (e) {
      if (inventoryOnly) throw e;
      console.warn('⚠️ Inventory refresh failed (continuing to build/send attachment):', e?.message || e);
    }

    const tsv = await downloadReportWithRetry(sp, {
      body: {
        reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
        marketplaceIds: [MARKETPLACE_ID]
      },
      interval: 15000,
      cancel_after: 12,
      download: { unzip: true, charset: 'utf8' }
    }, 'Amazon restock');

    const { header, rows } = tsvParse(tsv);
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));

    const colSku = idx['Merchant SKU'];
    const colAsin = idx['ASIN'];
    const colAvail = idx['Available'];
    const colInbound = idx['Inbound'];
    const colCustOrder = idx['Customer Order'];
    const colWorking = idx['Working'];
    const colTransfer = idx['FC transfer'];
    const colProc = idx['FC Processing'];
    const colUnful = idx['Unfulfillable'];
    const colRepl = idx['Recommended replenishment qty'];

    if ([colSku, colAsin, colAvail, colInbound, colCustOrder, colWorking, colTransfer, colProc, colUnful, colRepl].some((v) => v == null)) {
      throw new Error('Restock report missing one or more expected columns (header changed).');
    }

    const allowedRes = await pool.query(
      `WITH allowed_products AS (
         SELECT id, internal_sku
         FROM public.products
         WHERE deprecated = false
       ), allowed_skus AS (
         SELECT internal_sku AS sku FROM allowed_products
         UNION
         SELECT pi.id_value AS sku
         FROM public.product_identifiers pi
         JOIN allowed_products ap ON ap.id = pi.product_id
         WHERE pi.id_type='amazon_sku' AND pi.active=true
       )
       SELECT sku FROM allowed_skus`
    );
    const allowedSku = new Set(allowedRes.rows.map(r => String(r.sku)));

    const out = [];
    for (const r of rows) {
      const sku = String(r[colSku] || '').trim();
      if (!sku || !allowedSku.has(sku)) continue;

      const recommended = num(r[colRepl]);
      const available = num(r[colAvail]);
      const inbound = num(r[colInbound]);
      const reserved = num(r[colCustOrder]) + num(r[colWorking]) + num(r[colTransfer]) + num(r[colProc]) + num(r[colUnful]);
      const total = available + inbound + reserved;

      if (!((recommended >= 5) || (total < 10))) continue;

      out.push({
        sku,
        asin: String(r[colAsin] || '').trim(),
        available,
        inbound,
        reserved,
        total,
        recommended
      });
    }

    out.sort((a, b) => (b.recommended - a.recommended) || (a.total - b.total) || a.sku.localeCompare(b.sku));

    const dateStr = DateTime.now().setZone('America/New_York').toISODate();
    // OpenClaw host-read policy trusts generated HTML reports only under
    // the gateway temp root, not arbitrary user media directories.
    const attachmentDir = getAllowedAttachmentDir();
    fs.mkdirSync(attachmentDir, { recursive: true });
    const attachmentPath = path.join(attachmentDir, `send-to-amazon-${dateStr}.html`);
    fs.writeFileSync(attachmentPath, formatHtmlDocument(out, dateStr), 'utf8');

    const caption = out.length
      ? `📦 Send to Amazon — ${dateStr}\n${out.length} SKU${out.length === 1 ? '' : 's'} matched the restock filter. HTML attachment is printable.`
      : `📦 Send to Amazon — ${dateStr}\nNo SKUs matched the restock filter today. HTML attachment included for printing/reference.`;

    const sendResult = sendTelegramWithAttachment({
      channel: TELEGRAM_CHANNEL,
      target: TELEGRAM_TARGET,
      caption,
      attachmentPath
    });

    console.log(`Sent daily Send to Amazon Telegram ${sendResult.mode} to ${TELEGRAM_TARGET} (rows: ${out.length}, attachment: ${attachmentPath}).`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
