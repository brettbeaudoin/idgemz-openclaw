// Postgres → Google Sheet sync for Orders (all channels we have in Postgres).
//
// Rebuilds the NerdWidgets Google Sheet Orders tab for:
// - today PT
// - yesterday PT
//
// Source of truth: Postgres (orders + order_items).
//
// Sheet rules (apply across channels):
// - Each row = one order.
// - Sales Channel column differentiates channels (e.g. "Amazon", "Shopify").
// - Order ID column should be populated (uses orders.channel_order_id).
// - Units = sum across SKU quantity columns (we write a formula).
// - Total = PRE-tax, PRE-shipping: SUM(quantity * unit_price) across order_items.
// - SKU columns are literal header names.
//   - Amazon: mapping via product_identifiers amazon_sku → google_sheet_sku.
//   - Shopify: we map order_items.raw->>'sku' directly to header name when possible.

require('dotenv').config();

const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { execFileSync } = require('child_process');
const fs = require('fs');

const SHEET_ID = process.env.SHEET_ID || '1HoedZLqY6iq3hIKJLq2-qIAEiKuyoQdWflu7bozWpKg';
const SHEET_NAME = 'Orders';
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

const AMAZON_CHANNEL_ID = process.env.AMAZON_CHANNEL_ID || '248fdd46-cdff-4296-9598-51777a060859';
const SHOPIFY_CHANNEL_ID = process.env.SHOPIFY_CHANNEL_ID || null; // optional override

function gogSheetsGet(rangeA1) {
  const out = execFileSync('gog', ['sheets', 'get', SHEET_ID, rangeA1, '--account', GOG_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000
  });
  const j = JSON.parse(out);
  return j.values || [];
}

function gogSheetsUpdate(rangeA1, values2d) {
  execFileSync('gog', [
    'sheets', 'update', SHEET_ID, rangeA1,
    '--account', GOG_ACCOUNT,
    '--values-json', JSON.stringify(values2d),
    '--input', 'USER_ENTERED',
    '--no-input'
  ], {
    stdio: 'inherit',
    timeout: 120000
  });
}

function gogSheetsMetadata() {
  const out = execFileSync('gog', ['sheets', 'metadata', SHEET_ID, '--account', GOG_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000
  });
  return JSON.parse(out);
}

function numToCol(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function getSheetColumnCount(sheetTitle) {
  const md = gogSheetsMetadata();
  const sheet = (md.sheets || []).find((s) => s?.properties?.title === sheetTitle);
  const colCount = sheet?.properties?.gridProperties?.columnCount;
  if (!colCount) throw new Error(`Could not determine columnCount for sheet tab: ${sheetTitle}`);
  return colCount;
}

function parseNumber(x) {
  const s = String(x ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Load channel SKU → google_sheet_sku mapping from the database.
// Supports: amazon_sku, shopify_sku, etsy_sku, walmart_sku → google_sheet_sku
async function loadChannelSkuMap(pool, channelIdType) {
  const res = await pool.query(
    `WITH ch AS (
       SELECT product_id, id_value AS channel_sku
       FROM public.product_identifiers
       WHERE id_type = $1 AND active = true
     ), sheet AS (
       SELECT product_id, id_value AS google_sheet_sku
       FROM public.product_identifiers
       WHERE id_type = 'google_sheet_sku' AND active = true
     )
     SELECT ch.channel_sku, sheet.google_sheet_sku
     FROM ch
     JOIN sheet ON sheet.product_id = ch.product_id`,
    [channelIdType]
  );
  const m = new Map();
  for (const r of res.rows) m.set(String(r.channel_sku), String(r.google_sheet_sku));
  return m;
}

// Deprecated: JSON file overrides. Kept as fallback during migration.
function loadSkuMappingOverrides(channel) {
  try {
    const p = require('path').resolve(__dirname, 'sheet-sku-mapping.json');
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j?.channels?.[channel] || {};
  } catch (e) {
    return {};
  }
}

// Legacy alias — now delegates to loadChannelSkuMap
async function loadAmazonSkuToSheetHeader(pool) {
  return loadChannelSkuMap(pool, 'amazon_sku');
}

async function resolveChannelIds(pool) {
  const res = await pool.query(`SELECT id, platform, name FROM public.channels`);
  const byPlatform = new Map();
  for (const r of res.rows) byPlatform.set(String(r.platform), r);

  const amazon = byPlatform.get('amazon');
  const shopify = byPlatform.get('shopify');

  return {
    amazonChannelId: process.env.AMAZON_CHANNEL_ID || amazon?.id || AMAZON_CHANNEL_ID,
    shopifyChannelId: process.env.SHOPIFY_CHANNEL_ID || shopify?.id || SHOPIFY_CHANNEL_ID,
    channelNames: {
      amazon: amazon?.name || 'Amazon',
      shopify: shopify?.name || 'Shopify'
    }
  };
}

function signatureKey({ orderId, total, units }) {
  // For date-block rebuild we primarily key by orderId; this is fallback.
  return `${orderId}|${total}|${units}`;
}

async function buildRowsForPtDate({ pool, header, headerIndex, datePt, channel }) {
  const dateSheet = DateTime.fromISO(datePt, { zone: 'America/Los_Angeles' }).toFormat('yyyy/LL/dd');

  const channelLabel = channel.label;
  const channelId = channel.id;

  const overrideSkuToHeader = loadSkuMappingOverrides(channelLabel);
  const skuMap = channel.skuMap || new Map();

  const required = ['Date', 'Total', 'Units', 'Sales Channel', 'NOTES'];
  for (const r of required) {
    if (headerIndex[r] == null) throw new Error(`Orders header missing column: ${r}`);
  }

  const orderIdColName = headerIndex['Order ID'] != null ? 'Order ID' : null;
  if (!orderIdColName) throw new Error('Orders header missing Order ID column (expected "Order ID")');

  // Pull order_items for this channel where order_date in PT date.
  //
  // Amazon: SellerSKU comes from order_items.raw->>'SellerSKU' and we use fallback pricing.
  // Shopify: sku comes from order_items.raw->>'sku' and we can usually use oi.unit_price (fallback to raw->>'price').
  const res = await pool.query(
    `SELECT o.id AS order_pk,
            o.channel_order_id AS order_id,
            COALESCE(so.name, o.channel_order_id) AS order_display_id,
            o.order_total AS order_total,
            o.order_date AS order_date,
            oi.quantity AS quantity,
            oi.raw AS item_raw,
            CASE
              WHEN $3 = 'amazon' THEN COALESCE(oi.unit_price, fb.unit_price)
              ELSE COALESCE(oi.unit_price, NULLIF((oi.raw->>'price')::numeric, 0))
            END AS effective_unit_price,
            CASE
              WHEN $3 = 'amazon' THEN (oi.raw->>'SellerSKU')
              ELSE COALESCE(cl.channel_sku, oi.raw->>'sku')
            END AS item_sku
     FROM public.orders o
     JOIN public.order_items oi ON oi.order_id=o.id
     LEFT JOIN public.channel_listings cl ON cl.id=oi.channel_listing_id
     LEFT JOIN public.shopify_orders so ON so.order_id=o.id
     -- Amazon fallback pricing: if this order_item has no unit_price yet,
     -- use the most recent known unit_price for the same SellerSKU from historical Amazon orders.
     LEFT JOIN LATERAL (
       SELECT oi2.unit_price
       FROM public.orders o2
       JOIN public.order_items oi2 ON oi2.order_id=o2.id
       WHERE o2.channel_id = $1
         AND (oi2.raw->>'SellerSKU') = (oi.raw->>'SellerSKU')
         AND oi2.unit_price IS NOT NULL
         AND oi2.unit_price > 0
       ORDER BY o2.order_date DESC
       LIMIT 1
     ) fb ON ($3 = 'amazon')
     WHERE o.channel_id=$1
       AND (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $2::date
     ORDER BY o.order_date ASC, o.channel_order_id ASC`,
    [channelId, datePt, channel.platform]
  );

  // Aggregate per order
  const byOrder = new Map();
  for (const r of res.rows) {
    const orderId = String(r.order_display_id || r.order_id);
    if (!byOrder.has(orderId)) {
      byOrder.set(orderId, {
        orderId,
        dateSheet,
        orderDate: r.order_date,
        units: 0,
        // Totals in the sheet are intended to be *revenue* (pre-tax, post-discount).
        // For Amazon we compute from line items.
        // For Shopify/Etsy/Walmart we compute from line items too (exclude tax/shipping).
        total: 0,
        qtyByHeader: new Map(),
        unmappedSkus: new Set()
      });
    }
    const o = byOrder.get(orderId);
    const qty = Number(r.quantity || 0);

    let unitPrice = r.effective_unit_price == null ? null : Number(r.effective_unit_price);
    if (channel.platform === 'shopify' && r.item_raw) {
      // Apply Shopify discount allocations at the line-item level.
      // We want net item revenue: (price - discounts) per unit.
      try {
        const raw = r.item_raw;
        const price = raw?.price != null ? Number(raw.price) : unitPrice;
        const allocs = Array.isArray(raw?.discount_allocations) ? raw.discount_allocations : [];
        const discount = allocs.reduce((sum, a) => sum + Number(a?.amount || 0), 0);
        const net = (Number.isFinite(price) ? price : 0) - (Number.isFinite(discount) ? discount : 0);
        unitPrice = qty ? net / qty : net;
      } catch (_) {
        // ignore and fall back
      }
    }

    if (Number.isFinite(qty)) o.units += qty;

    // Revenue (pre-tax). For Amazon, unitPrice may come from fallback pricing.
    // For Shopify, unitPrice is adjusted for discount allocations above.
    if (Number.isFinite(qty) && Number.isFinite(unitPrice)) {
      o.total += qty * unitPrice;
    }

    const sku = String(r.item_sku || '').trim();
    if (sku) {
      // Amazon: skuMap maps SellerSKU -> sheet header.
      // Shopify: we try direct header match by SKU.
      const directHeader = headerIndex[sku] != null ? sku : null;
      const headerName = skuMap.get(sku) || overrideSkuToHeader[sku] || directHeader;
      if (headerName) {
        o.qtyByHeader.set(headerName, (o.qtyByHeader.get(headerName) || 0) + qty);
      } else {
        o.unmappedSkus.add(sku);
      }
    }
  }

  // Build sheet rows
  const rows = [];
  for (const o of byOrder.values()) {
    // Skip zero-unit orders
    if (!o.units || o.units <= 0) continue;

    const row = Array(header.length).fill('');
    row[headerIndex['Date']] = o.dateSheet;
    row[headerIndex['Sales Channel']] = channelLabel;
    row[headerIndex[orderIdColName]] = o.orderId;

    const totalRounded = round2(o.total);
    if (channel.platform === 'amazon' && !(totalRounded > 0)) {
      throw new Error(`Missing order total for ${channelLabel} order ${o.orderId} on ${dateSheet}. This likely means unit_price is missing and no fallback price was found.`);
    }
    const totalStr = Number.isFinite(totalRounded) ? totalRounded.toFixed(2) : '';
    row[headerIndex['Total']] = totalStr;

    // Units is formula; filled later when row number known.
    row[headerIndex['Units']] = '__UNITS_FORMULA__';

    // SKU quantities
    for (const [hdr, qty] of o.qtyByHeader.entries()) {
      const idx = headerIndex[hdr];
      if (idx == null) continue; // header might not have the column yet
      row[idx] = String(qty);
    }

    const unmapped = Array.from(o.unmappedSkus).filter(Boolean).sort();
    row[headerIndex['NOTES']] = unmapped.length ? `UNMAPPED SKU: ${unmapped.join(',')}` : '';

    rows.push({ orderDate: o.orderDate, orderId: o.orderId, row });
  }

  rows.sort((a, b) => {
    const ta = new Date(a.orderDate).getTime();
    const tb = new Date(b.orderDate).getTime();
    if (ta !== tb) return ta - tb;
    return a.orderId.localeCompare(b.orderId);
  });

  return { datePt, dateSheet, rows, orderIdColName, channelLabel };
}

function findLastNonEmptyRow(vals, cols = 4) {
  let lastNonEmpty = null;
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i] || [];
    const slice = row.slice(0, cols);
    if (slice.some((x) => String(x ?? '').trim())) lastNonEmpty = i + 1;
  }
  return lastNonEmpty;
}

async function rebuildDateBlock({ pool, header, headerIndex, datePt, channel }) {
  const colCount = getSheetColumnCount(SHEET_NAME);
  const lastCol = numToCol(colCount);

  const { dateSheet, rows, orderIdColName, channelLabel } = await buildRowsForPtDate({ pool, header, headerIndex, datePt, channel });

  // If no rows for that day, we still may want to clear existing block.
  // We'll locate existing rows and either overwrite with empty or skip if none.

  // Find last non-empty row
  const vals = gogSheetsGet(`${SHEET_NAME}!A1:D20000`);
  const lastNonEmpty = findLastNonEmptyRow(vals, 4);
  if (!lastNonEmpty) throw new Error('Could not find last non-empty row in Orders');

  // Scan tail window to find existing block for date+Amazon
  const tailStart = Math.max(17, lastNonEmpty - 8000);
  const existingRows = gogSheetsGet(`${SHEET_NAME}!A${tailStart}:${lastCol}${lastNonEmpty}`);

  const dateIdx = headerIndex['Date'];
  const chanIdx = headerIndex['Sales Channel'];

  const matchingRowNums = [];
  for (let i = 0; i < existingRows.length; i++) {
    const r = existingRows[i] || [];
    const d = String(r[dateIdx] ?? '').trim();
    const c = String(r[chanIdx] ?? '').trim();
    if (d === dateSheet && c === channelLabel) matchingRowNums.push(tailStart + i);
  }

  let startRow;
  let existingCount = 0;

  if (matchingRowNums.length) {
    startRow = Math.min(...matchingRowNums);
    const endExisting = Math.max(...matchingRowNums);
    existingCount = endExisting - startRow + 1;
  } else {
    // Append at end
    startRow = lastNonEmpty + 1;
    existingCount = 0;
  }

  const targetCount = rows.length;
  const writeCount = Math.max(existingCount, targetCount);
  if (writeCount === 0) {
    console.log(`No existing ${channelLabel} rows for ${dateSheet} and no Postgres rows; nothing to do.`);
    return;
  }

  const endRow = startRow + writeCount - 1;

  // Preserve NOTES if the user has typed something in the sheet.
  // We intentionally treat the sheet as user-editable for NOTES only.
  const notesIdx = headerIndex['NOTES'];
  const orderIdIdx = headerIndex[orderIdColName];
  const existingNotesByOrderId = new Map();
  if (existingCount > 0 && notesIdx != null && orderIdIdx != null) {
    const endExisting = startRow + existingCount - 1;
    const existingBlock = gogSheetsGet(`${SHEET_NAME}!A${startRow}:${lastCol}${endExisting}`);
    for (const r of existingBlock) {
      const oid = String(r?.[orderIdIdx] ?? '').trim();
      const note = String(r?.[notesIdx] ?? '').trim();
      if (oid && note) existingNotesByOrderId.set(oid, note);
    }
  }

  const values = [];
  for (let i = 0; i < writeCount; i++) {
    const sheetRowNum = startRow + i;
    if (i < targetCount) {
      const row = [...rows[i].row];

      // Units formula
      const unitsIdx = headerIndex['Units'];
      if (row[unitsIdx] === '__UNITS_FORMULA__') {
        // Units = sum across SKU quantity columns.
        // Assume SKU columns begin at E and end immediately before NOTES.
        const endSkuCol = (notesIdx != null && notesIdx > 4) ? numToCol(notesIdx) : 'CR';
        row[unitsIdx] = `=SUM(E${sheetRowNum}:${endSkuCol}${sheetRowNum})`;
      }

      // Preserve user notes if present
      const oid = String(row[orderIdIdx] ?? '').trim();
      const existingNote = existingNotesByOrderId.get(oid);
      // Preserve only real user notes; do not preserve the auto-generated unmapped marker.
      if (existingNote && !existingNote.startsWith('UNMAPPED SKU:')) row[notesIdx] = existingNote;

      values.push(row);
    } else {
      // Clear leftover rows
      values.push(Array(header.length).fill(''));
    }
  }

  const range = `${SHEET_NAME}!A${startRow}:${lastCol}${endRow}`;
  gogSheetsUpdate(range, values);

  console.log(`Rebuilt ${channelLabel} Orders block for ${dateSheet}: wrote ${targetCount} rows into ${range} (${existingCount ? `overwrote ${existingCount}` : 'appended'}).`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

  try {
    const colCount = getSheetColumnCount(SHEET_NAME);
    const lastCol = numToCol(colCount);

    // Header row at 16
    const header = gogSheetsGet(`${SHEET_NAME}!A16:${lastCol}16`)[0];
    if (!header || header.length < 10) throw new Error('Could not read Orders header row');

    const headerIndex = {};
    header.forEach((h, i) => { headerIndex[h] = i; });

    const { amazonChannelId, shopifyChannelId } = await resolveChannelIds(pool);

    // Etsy + Walmart channel ids (optional)
    const etsyChannelId = (await pool.query(
      `SELECT id FROM public.channels WHERE platform='etsy' ORDER BY name LIMIT 1`
    )).rows?.[0]?.id;

    const walmartChannelId = (await pool.query(
      `SELECT id FROM public.channels WHERE platform='walmart' ORDER BY name LIMIT 1`
    )).rows?.[0]?.id;

    // Load per-channel SKU→sheet-header maps from Postgres product_identifiers.
    const [amazonSkuMap, shopifySkuMap, etsySkuMap, walmartSkuMap] = await Promise.all([
      loadChannelSkuMap(pool, 'amazon_sku'),
      loadChannelSkuMap(pool, 'shopify_sku'),
      loadChannelSkuMap(pool, 'etsy_sku'),
      loadChannelSkuMap(pool, 'amazon_sku'), // Walmart SKUs currently match Amazon SKUs
    ]);

    const channels = [
      { platform: 'amazon', id: amazonChannelId, label: 'Amazon', skuMap: amazonSkuMap },
      { platform: 'shopify', id: shopifyChannelId, label: 'Shopify', skuMap: shopifySkuMap },
      { platform: 'etsy', id: etsyChannelId, label: 'Etsy', skuMap: etsySkuMap },
      { platform: 'walmart', id: walmartChannelId, label: 'Walmart', skuMap: walmartSkuMap }
    ].filter((c) => c.id);

    // Sheet is tracked in PT day
    const todayPt = DateTime.now().setZone('America/Los_Angeles').toISODate();
    const yesterdayPt = DateTime.now().setZone('America/Los_Angeles').minus({ days: 1 }).toISODate();

    const dates = [];
    if (process.env.DATE_PT) {
      dates.push(process.env.DATE_PT);
    } else {
      dates.push(yesterdayPt, todayPt);
    }

    for (const d of dates) {
      for (const ch of channels) {
        await rebuildDateBlock({ pool, header, headerIndex, datePt: d, channel: ch });
      }
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('postgres-sheet-orders-sync failed:', e?.stack || e);
    process.exit(1);
  });
}
