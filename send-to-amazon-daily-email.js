#!/usr/bin/env node

/**
 * Daily “Send to Amazon” email.
 *
 * Pulls SP-API Restock Recommendations report, filters SKUs per Brett rules, and emails a table.
 *
 * Include SKU if:
 *  - recommended_qty >= 5 OR
 *  - (available + inbound + reserved) < 10
 *
 * reserved = Customer Order + Working + FC transfer + FC Processing + Unfulfillable
 */

require('dotenv').config();

const { Pool } = require('pg');
const { SellingPartner } = require('amazon-sp-api');
const { execFileSync } = require('child_process');

const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const TO_EMAIL = process.env.SEND_TO_AMAZON_TO || 'brett@nerdwidgets.com';
const FROM_ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

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

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatHtmlTable(rows) {
  const th = (x) => `<th style="border:1px solid #ddd;padding:6px 8px;text-align:left;background:#f6f7f9;font-weight:600;">${escapeHtml(x)}</th>`;
  const tdL = (x) => `<td style="border:1px solid #ddd;padding:6px 8px;text-align:left;">${escapeHtml(x)}</td>`;
  const tdR = (x) => `<td style="border:1px solid #ddd;padding:6px 8px;text-align:right; font-variant-numeric: tabular-nums;">${escapeHtml(x)}</td>`;

  const header = ['SKU', 'ASIN', 'Available', 'Inbound', 'Reserved*', 'Total', 'Recommended qty'];

  const bodyRows = rows.map((r, i) => {
    const bg = (i % 2 === 0) ? '#ffffff' : '#fbfbfc';
    return `<tr style="background:${bg};">` +
      tdL(r.sku) +
      tdL(r.asin) +
      tdR(r.available) +
      tdR(r.inbound) +
      tdR(r.reserved) +
      tdR(r.total) +
      tdR(r.recommended) +
      `</tr>`;
  }).join('');

  return `
<table style="border-collapse:collapse;border:1px solid #ddd;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:13px;">
  <thead>
    <tr>${header.map(th).join('')}</tr>
  </thead>
  <tbody>
    ${bodyRows || `<tr><td style="border:1px solid #ddd;padding:8px;" colspan="7">No SKUs matched the filter today.</td></tr>`}
  </tbody>
</table>
  `.trim();
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

    // Refresh inventory table first so DB-backed workflows are up to date.
    // Source: Seller Central-compatible FBA MYI report.
    // Non-fatal: the email can still send even if inventory refresh fails.
    try {
      console.log('Refreshing Amazon FBA inventory into Postgres (MYI report)...');

      // Preload channel SKU -> product_id mapping (avoids N+1 queries)
      const mapRes = await pool.query(
        `SELECT cl.channel_sku, cl.product_id
         FROM public.channel_listings cl
         WHERE cl.channel_id = $1`,
        [amazonChannelId]
      );
      const skuToProductId = new Map(mapRes.rows.map((r) => [String(r.channel_sku), String(r.product_id)]));

      // Download the inventory report (TSV)
      const myiTsv = await sp.downloadReport({
        body: {
          reportType: 'GET_FBA_MYI_ALL_INVENTORY_DATA',
          marketplaceIds: [MARKETPLACE_ID]
        },
        interval: 15000,
        cancel_after: 12,
        download: { unzip: true, charset: 'utf8' }
      });

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

      // Common MYI column names (case-insensitive)
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

        const productId = skuToProductId.get(sellerSku);
        if (!productId) {
          misses++;
          if (missingSkus.length < 200) missingSkus.push(sellerSku);
          continue;
        }

        const available = num(r[cFulfillable]);
        const reserved = num(r[cReserved]);
        const inbound = num(r[cInboundWorking]) + num(r[cInboundShipped]) + num(r[cInboundReceiving]);

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

      // Hygiene: if a SKU disappears from the report, zero it out.
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
        console.log('Inventory-only mode: skipping email send.');
        return;
      }
    } catch (e) {
      if (inventoryOnly) throw e;
      console.warn('⚠️ Inventory refresh failed (continuing to send email):', e?.message || e);
    }

    const body = {
      reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
      marketplaceIds: [MARKETPLACE_ID]
    };

    // Use library helper to create + poll + download (more robust than manual polling).
    const tsv = await sp.downloadReport({
      body,
      interval: 15000,
      cancel_after: 12,
      download: { unzip: true, charset: 'utf8' }
    });

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

    // Only include non-deprecated products.
    // We treat products.internal_sku as canonical and also include any amazon_sku aliases from product_identifiers.
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
      if (!sku) continue;

      if (!allowedSku.has(sku)) continue;

      const recommended = num(r[colRepl]);
      const available = num(r[colAvail]);
      const inbound = num(r[colInbound]);
      const reserved = num(r[colCustOrder]) + num(r[colWorking]) + num(r[colTransfer]) + num(r[colProc]) + num(r[colUnful]);
      const total = available + inbound + reserved;

      const include = (recommended >= 5) || (total < 10);
      if (!include) continue;

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

    const subject = `Send to Amazon — Recommendations (${new Date().toISOString().slice(0, 10)})`;

    const htmlTable = formatHtmlTable(out);
    const bodyHtml = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.35;">
  <p style="margin:0 0 10px 0;"><strong>${escapeHtml(subject)}</strong></p>
  <p style="margin:0 0 10px 0;">Include rule: <code>recommended_qty &gt;= 5</code> OR <code>(available + inbound + reserved) &lt; 10</code><br/>
  Reserved* = Customer Order + Working + FC transfer + FC Processing + Unfulfillable</p>
  ${htmlTable}
</div>
    `.trim();

    execFileSync('gog', [
      'gmail', 'send',
      '--account', FROM_ACCOUNT,
      '--to', TO_EMAIL,
      '--subject', subject,
      '--body-html', bodyHtml,
      '--no-input'
    ], {
      encoding: 'utf8',
      stdio: ['inherit', 'inherit', 'inherit'],
      timeout: 180000
    });

    console.log(`Sent daily Send to Amazon email to ${TO_EMAIL} (rows: ${out.length}).`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
