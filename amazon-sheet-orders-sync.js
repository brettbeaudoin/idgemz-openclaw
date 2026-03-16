// Sync today's Amazon orders into the NerdWidgets Google Sheet (Orders tab).
//
// Rules (per Brett):
// - Each row = one Amazon order.
// - Quantity under each SKU column = units of that SKU in that order.
// - Units column = sum of SKU quantities (we compute it).
// - Total column = USD total. If foreign currency, convert to USD and note original (NOT implemented yet; currently assumes USD).
// - Notes column should be blank unless anomalous.
// - Insert in chronological order *within today*; append to the end of the sheet (keeps overall chronological order for an always-growing log).
// - Avoid duplicates by matching against existing rows for today's date.
//
// Usage:
//   node amazon-sheet-orders-sync.js
//   DATE_PT=2026-02-12 node amazon-sheet-orders-sync.js
//   SHEET_ID=... node amazon-sheet-orders-sync.js

require('dotenv').config();
const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { execFileSync } = require('child_process');
const fs = require('fs');

const SHEET_ID = process.env.SHEET_ID || '1HoedZLqY6iq3hIKJLq2-qIAEiKuyoQdWflu7bozWpKg';
const SHEET_NAME = 'Orders';
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

function gogSheetsGet(rangeA1) {
  // NOTE: Some ranges (like A1:D20000) can produce large JSON. Increase buffer to avoid ENOBUFS.
  const out = execFileSync('gog', ['sheets', 'get', SHEET_ID, rangeA1, '--account', GOG_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50MB
    timeout: 120000 // 2m hard-stop so cron doesn't hang forever
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

function numToCol(n) {
  // 1-indexed
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function gogSheetsMetadata() {
  const out = execFileSync('gog', ['sheets', 'metadata', SHEET_ID, '--account', GOG_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000
  });
  return JSON.parse(out);
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

const fxCache = new Map();
async function convertToUsd(amount, fromCurrency, datePt) {
  // Prefer a free, stable API. Frankfurter is simple and keyless.
  // https://www.frankfurter.app/docs/
  // Use a dated endpoint so FX matches the PT date being synced.
  // Note: for weekends/holidays Frankfurter returns the nearest previous business day.
  if (!fromCurrency || fromCurrency === 'USD') return { usd: Number(amount), source: 'native', date: datePt };

  const key = `${datePt}|${fromCurrency}|${amount}`;
  if (fxCache.has(key)) return fxCache.get(key);

  const url = `https://api.frankfurter.app/${encodeURIComponent(datePt)}?amount=${encodeURIComponent(String(amount))}&from=${encodeURIComponent(fromCurrency)}&to=USD`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`FX convert failed (${resp.status}) for ${fromCurrency}->USD`);
  const j = await resp.json();
  const usd = j?.rates?.USD;
  if (usd == null || !Number.isFinite(Number(usd))) throw new Error(`FX convert missing USD rate for ${fromCurrency}`);
  const out = { usd: Number(usd), source: 'frankfurter', date: j?.date };
  fxCache.set(key, out);
  return out;
}

function loadSheetSkuConfig() {
  try {
    const p = require('path').resolve(__dirname, 'sheet-sku-mapping.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('Warning: failed to load sheet-sku-mapping.json:', e?.message || e);
    return {};
  }
}

function loadSkuMappingOverrides(channel) {
  const j = loadSheetSkuConfig();
  return j?.channels?.[channel] || {};
}

function loadSkuPrices(channel) {
  const j = loadSheetSkuConfig();
  return j?.skuPrices?.[channel] || {};
}

function buildSkuToColname(headerRow, channel = 'Amazon') {
  // Hard-coded defaults aligned to this specific NerdWidgets sheet.
  // Prefer using sheet-sku-mapping.json overrides for channel-specific SKUs.
  const map = {

    'BHT1STE-V2': 'BH-T1 RSA Stealth V2',
    'BHT2STE-V2': 'BH-T2 RSA Stealth V2',
    'BHT3STE-V2': 'BH-T3 RSA Stealth V2',
    'BHT1STE-YUBI-V2': 'BH-T1 Yubi V2',
    'BHT1STE-YUBI-V1': 'BH-T1 Yubi V1 Slot',
    'BHT2STE-RSA-YUBI-V2': 'BH-T2 RSA & Yubi V2',
    'BHT2STE-RSA-YUBI': 'BH-T2 RSA & Yubi V1',
    'BHT2STE-RSA-ET': 'BH-T2 RSA & ET',
    'BHT2STE': 'BH-T2 RSA Stealth V1',
    'BHT2STE-YUBI-V1': 'BH-T2 Yubi V1',
    'BHT2FLAG': 'BH-T2 RSA Flag V2',
    'BHT2FLAG-V2': 'BH-T2 RSA Flag V2',
    'BHT1FLAG-V2': 'BH-T1 RSA Flag V2',
    'BHT1DF': 'BH-T1-DF',
    'BHT1STE-ET': 'BH-T1 EToken'
  };

  // Apply overrides (Option B: grouped SKUs, and/or per-channel SKU names)
  const overrides = loadSkuMappingOverrides(channel);
  for (const [sku, col] of Object.entries(overrides)) map[sku] = col;

  const headerSet = new Set(headerRow);
  const missingCols = Object.values(map).filter((c) => !headerSet.has(c));
  if (missingCols.length) {
    throw new Error(`Sheet header missing expected columns: ${missingCols.join(', ')}`);
  }
  return map;
}

function signatureFromRow(row, headerIndex, skuToColname) {
  const date = String(row[headerIndex.Date] ?? '').trim();
  const total = String(row[headerIndex.Total] ?? '').trim();
  const channel = String(row[headerIndex.SalesChannel] ?? '').trim();
  if (!date || !total || !channel) return null;
  if (channel !== 'Amazon') return null;

  // IMPORTANT: Units cell may be a formula (=SUM(...)) which won't match our report signatures.
  // Compute units from SKU quantity columns instead.
  const items = [];
  let unitsNum = 0;
  for (const [sku, colName] of Object.entries(skuToColname)) {
    const idx = headerIndex[colName];
    const v = (idx != null && row[idx] != null) ? String(row[idx]).trim() : '';
    if (!v) continue;
    const q = parseNumber(v);
    if (q && q !== 0) {
      items.push([sku, q]);
      unitsNum += q;
    }
  }

  // If there are no SKU quantities, fall back to a signature that will still dedupe
  // (this happens when SKUs are not mapped to any sheet columns).
  if (!items.length) {
    const unitsCell = String(row[headerIndex.Units] ?? '').trim();
    const unitsNum = parseNumber(unitsCell) || 0;
    return `${total}|${String(unitsNum)}|UNMAPPED`;
  }

  items.sort((a, b) => a[0].localeCompare(b[0]));
  return `${total}|${String(unitsNum)}|${items.map(([s, q]) => `${s}:${q}`).join(',')}`;
}

async function downloadAmazonAllOrdersReportForPtDate(sp, datePt) {
  const startPt = DateTime.fromISO(datePt, { zone: 'America/Los_Angeles' }).startOf('day');
  const endPt = startPt.plus({ days: 1 });
  const start = startPt.toUTC().toISO();
  const end = endPt.toUTC().toISO();

  const reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';

  const res = await sp.downloadReport({
    body: {
      reportType,
      marketplaceIds: ['ATVPDKIKX0DER'],
      dataStartTime: start,
      dataEndTime: end
    },
    interval: 15000,
    cancel_after: 12,
    download: { unzip: true, charset: 'utf8' }
  });

  const outPath = `/tmp/amazon_all_orders_${datePt}.txt`;
  fs.writeFileSync(outPath, res);
  return outPath;
}

function parseAllOrdersReport(path) {
  // Parse TSV without extra deps.
  const raw = fs.readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split('\t');
  const records = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cells[i] ?? '';
    records.push(row);
  }

  // aggregate to per-order
  const orders = new Map();

  const AMAZON_ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;

  for (const row of records) {
    const oid = String(row['amazon-order-id'] || '').trim();
    if (!oid) continue;

    // Exclude disposal/non-order records. Real Amazon orders look like 123-1234567-1234567.
    // (Brett example: "kH4W6x8tLC" should be ignored.)
    if (!AMAZON_ORDER_ID_RE.test(oid)) continue;

    const dt = DateTime.fromISO(row['purchase-date']);
    const sku = String(row['sku'] || '').trim();
    const qty = parseInt(row['quantity'] || '0', 10) || 0;
    const currency = (row['currency'] || '').trim() || 'USD';
    const orderStatus = String(row['order-status'] || '').trim();

    // NOTE: For Sales Dashboard alignment, totalSales matches sum(item-price) (not shipping).
    // Some Pending orders can show item-price=0 in the report; we will hydrate those later via Orders API.
    const itemPrice = row['item-price'] ? Number(String(row['item-price']).trim()) : 0;

    if (!orders.has(oid)) {
      orders.set(oid, { oid, dt, currency, orderStatus, itemTotal: 0, units: 0, items: new Map() });
    }
    const o = orders.get(oid);
    if (dt.isValid && (!o.dt || dt < o.dt)) o.dt = dt;
    o.currency = currency;
    o.orderStatus = orderStatus || o.orderStatus;
    o.itemTotal += (Number.isFinite(itemPrice) ? itemPrice : 0);
    o.units += qty;
    if (sku) o.items.set(sku, (o.items.get(sku) || 0) + qty);
  }

  return Array.from(orders.values()).sort((a, b) => {
    const ta = a.dt?.toMillis?.() ?? 0;
    const tb = b.dt?.toMillis?.() ?? 0;
    if (ta !== tb) return ta - tb;
    return a.oid.localeCompare(b.oid);
  });
}

async function hydrateZeroTotalsFromOrdersApi(sp, reportOrders, skuPrices = {}) {
  // Do not exclude Pending orders.
  // If report shows $0.00 but we have SKUs/units, try to fetch item totals from Orders API orderItems
  // (exclude tax by summing ItemPrice only). If that still yields 0, fall back to SKU price table.
  const zeroOrders = reportOrders.filter((o) => round2(o.itemTotal) === 0 && o.units > 0);
  if (!zeroOrders.length) return;

  for (const o of zeroOrders) {
    let total = 0;
    try {
      let nextToken = null;
      do {
        const res = await sp.callAPI({
          operation: 'getOrderItems',
          endpoint: 'orders',
          path: { orderId: o.oid },
          ...(nextToken ? { query: { NextToken: nextToken } } : {})
        });

        const payload = res?.payload || res;
        const items = payload?.OrderItems || [];
        for (const it of items) {
          const amt = Number(it?.ItemPrice?.Amount);
          if (Number.isFinite(amt)) total += amt;
        }
        nextToken = payload?.NextToken || null;
      } while (nextToken);
    } catch (e) {
      console.warn(`Warning: failed to hydrate total for order ${o.oid} via Orders API: ${e?.message || e}`);
    }

    if (round2(total) <= 0) {
      // Fallback: SKU price table (ex tax). Useful for Pending orders where API returns $0.
      let fallback = 0;
      for (const [sku, qty] of o.items.entries()) {
        const p = Number(skuPrices[sku]);
        if (!Number.isFinite(p)) continue;
        fallback += p * Number(qty || 0);
      }
      total = fallback;
    }

    if (round2(total) > 0) {
      o.itemTotal = total;
    }
  }
}

async function main() {
  const datePt = process.env.DATE_PT || DateTime.now().setZone('America/Los_Angeles').toISODate();
  const dateSheet = DateTime.fromISO(datePt, { zone: 'America/Los_Angeles' }).toFormat('yyyy/LL/dd');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

  try {
    // Header row (dynamic width; Brett may add columns like "Amazon Order ID")
    const colCount = getSheetColumnCount(SHEET_NAME);
    const lastCol = numToCol(colCount);
    const header = gogSheetsGet(`${SHEET_NAME}!A16:${lastCol}16`)[0];
    if (!header || header.length < 10) throw new Error('Could not read Orders header row');

    const headerIndex = {};
    header.forEach((h, i) => { headerIndex[h] = i; });

    const required = ['Date', 'Total', 'Units', 'Sales Channel', 'NOTES'];
    const orderIdColName = (headerIndex['Amazon Order ID'] != null)
      ? 'Amazon Order ID'
      : (headerIndex['Order ID'] != null ? 'Order ID' : null);
    const hasAmazonOrderIdCol = !!orderIdColName;
    for (const r of required) {
      if (headerIndex[r] == null) throw new Error(`Orders header missing column: ${r}`);
    }

    // Keep names aligned
    headerIndex.Date = headerIndex['Date'];
    headerIndex.Total = headerIndex['Total'];
    headerIndex.Units = headerIndex['Units'];
    headerIndex.SalesChannel = headerIndex['Sales Channel'];

    const skuToColname = buildSkuToColname(header, 'Amazon');

    // Find last non-empty row (A:D)
    const vals = gogSheetsGet(`${SHEET_NAME}!A1:D20000`);
    let lastNonEmpty = null;
    for (let i = 0; i < vals.length; i++) {
      const row = vals[i] || [];
      const a = row[0], b = row[1], c = row[2], d = row[3];
      if ([a, b, c, d].some((x) => String(x ?? '').trim())) lastNonEmpty = i + 1;
    }
    if (!lastNonEmpty) throw new Error('Could not find last non-empty row in Orders');

    // Pull existing rows for today only (scan a tail window to keep it fast)
    // Scan a larger tail window to avoid missing existing rows when the sheet has been manually edited/cleared.
    const tailStart = Math.max(17, lastNonEmpty - 5000);
    const existingRows = gogSheetsGet(`${SHEET_NAME}!A${tailStart}:${lastCol}${lastNonEmpty}`);

    const existingSigs = new Set();
    const existingOrderIds = new Set();
    for (const r of existingRows) {
      // filter by today's date + amazon
      const date = String(r[headerIndex.Date] ?? '').trim();
      const chan = String(r[headerIndex.SalesChannel] ?? '').trim();
      if (date !== dateSheet || chan !== 'Amazon') continue;

      if (hasAmazonOrderIdCol) {
        const oid = String(r[headerIndex[orderIdColName]] ?? '').trim();
        if (oid) existingOrderIds.add(oid);
      }

      const sig = signatureFromRow(r, headerIndex, skuToColname);
      if (sig) existingSigs.add(sig);
    }

    // SP-API client
    const chRes = await pool.query(
      `SELECT api_credentials FROM channels WHERE platform='amazon' AND api_connected=true ORDER BY name LIMIT 1`
    );
    if (!chRes.rows.length) throw new Error('Amazon channel not connected');
    const refreshToken = chRes.rows[0].api_credentials.refreshToken;

    const sp = new SellingPartner({
      region: 'na',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
      },
      options: { auto_request_throttled: true }
    });

    const reportPath = await downloadAmazonAllOrdersReportForPtDate(sp, datePt);
    const reportOrders = parseAllOrdersReport(reportPath);

    // IMPORTANT: Never exclude Pending + $0.00 orders.
    // If the report yields 0 totals for such orders, hydrate totals from Orders API (excluding tax).
    await hydrateZeroTotalsFromOrdersApi(sp, reportOrders, loadSkuPrices('Amazon'));

    // --- Repair pass (today only): fill "placeholder" rows that have totals/units but no SKU quantities.
    // This can happen if we previously inserted incomplete rows due to missing SKU mapping.
    // We do NOT write order IDs into NOTES (per Brett), so the best we can do is match by (total, units)
    // and consume unmatched report orders in chronological order.
    const reportUnmatchedByKey = new Map();
    for (const o of reportOrders) {
      if (!o.units || o.units <= 0) continue;
      let totalStr;
      if (o.currency !== 'USD') {
        const originalAmt = round2(o.itemTotal);
        const fx = await convertToUsd(originalAmt, o.currency, datePt);
        totalStr = Number(fx.usd).toFixed(2);
      } else {
        totalStr = Number(o.itemTotal).toFixed(2);
      }
      const unitsNumStr = String(o.units);
      const items = [];
      for (const [sku, qty] of o.items.entries()) {
        if (!qty) continue;
        items.push([sku, qty]);
      }
      items.sort((a, b) => a[0].localeCompare(b[0]));
      const sig = `${totalStr}|${unitsNumStr}|${items.map(([s, q]) => `${s}:${q}`).join(',')}`;
      if (existingSigs.has(sig)) continue;
      const key = `${totalStr}|${unitsNumStr}`;
      if (!reportUnmatchedByKey.has(key)) reportUnmatchedByKey.set(key, []);
      reportUnmatchedByKey.get(key).push({ o, items, sig });
    }

    // Identify placeholder rows in today's existing rows.
    const placeholderRowNums = [];
    for (let i = 0; i < existingRows.length; i++) {
      const r = existingRows[i] || [];
      const date = String(r[headerIndex.Date] ?? '').trim();
      const chan = String(r[headerIndex.SalesChannel] ?? '').trim();
      if (date !== dateSheet || chan !== 'Amazon') continue;

      const totalStr = String(r[headerIndex.Total] ?? '').trim();
      const unitsCell = String(r[headerIndex.Units] ?? '').trim();
      let unitsNum = parseNumber(unitsCell);
      if (!totalStr) continue;

      // does it have any SKU quantities?
      let hasAnySkuQty = false;
      for (const colName of Object.values(skuToColname)) {
        const idx = headerIndex[colName];
        const v = (idx != null && r[idx] != null) ? String(r[idx]).trim() : '';
        if (v && parseNumber(v)) { hasAnySkuQty = true; break; }
      }
      if (!hasAnySkuQty) {
        const sheetRowNum = tailStart + i;
        // Some bad rows have Units=0; assume 1 only for matching (most orders are unit=1)
        // and we will only consume candidates that actually exist.
        if (!unitsNum || unitsNum <= 0) unitsNum = 1;
        placeholderRowNums.push({ sheetRowNum, totalStr, unitsNumStr: String(unitsNum) });
      }
    }

    if (placeholderRowNums.length) {
      // Fill in order within the sheet as-is (chronological): earlier rows get earlier unmatched orders.
      for (const p of placeholderRowNums) {
        const key = `${p.totalStr}|${p.unitsNumStr}`;
        const candidates = reportUnmatchedByKey.get(key) || [];
        if (!candidates.length) continue;
        const { o, items, sig } = candidates.shift();
        // write row
        const row = Array(header.length).fill('');
        row[headerIndex.Date] = dateSheet;
        row[headerIndex.Total] = p.totalStr;
        {
          const notesIdx = headerIndex['NOTES'];
          const endSkuCol = (notesIdx != null && notesIdx > 4) ? numToCol(notesIdx) : 'CR';
          row[headerIndex.Units] = `=SUM(E${p.sheetRowNum}:${endSkuCol}${p.sheetRowNum})`;
        }
        row[headerIndex.SalesChannel] = 'Amazon';
        for (const [sku, qty] of items) {
          const colName = skuToColname[sku];
          if (!colName) continue;
          const idx = headerIndex[colName];
          row[idx] = String(qty);
        }
        row[headerIndex['NOTES']] = (o.currency && o.currency !== 'USD') ? `${o.currency} $${round2(o.itemTotal).toFixed(2)}` : '';
        if (hasAmazonOrderIdCol) {
          row[headerIndex[orderIdColName]] = o.oid;
        }

        gogSheetsUpdate(`${SHEET_NAME}!A${p.sheetRowNum}:${lastCol}${p.sheetRowNum}`, [row]);
        existingSigs.add(sig);
      }
    }

    // Backfill missing Order IDs for today's existing Amazon rows (common for older/placeholder inserts).
    if (hasAmazonOrderIdCol) {
      const orderIdIdx = headerIndex[orderIdColName];

      // Build signature -> orderId map from report
      const sigToOid = new Map();
      for (const o of reportOrders) {
        if (!o.units || o.units <= 0) continue;

        let totalStr;
        if (o.currency !== 'USD') {
          const originalAmt = round2(o.itemTotal);
          const fx = await convertToUsd(originalAmt, o.currency, datePt);
          totalStr = Number(fx.usd).toFixed(2);
        } else {
          totalStr = Number(o.itemTotal).toFixed(2);
        }

        const unitsNumStr = String(o.units);
        const items = [];
        for (const [sku, qty] of o.items.entries()) {
          if (!qty) continue;
          items.push([sku, qty]);
        }
        items.sort((a, b) => a[0].localeCompare(b[0]));
        const sig = `${totalStr}|${unitsNumStr}|${items.map(([s, q]) => `${s}:${q}`).join(',')}`;
        if (!sigToOid.has(sig)) sigToOid.set(sig, o.oid);
      }

      const orderIdColLetter = numToCol(orderIdIdx + 1);

      for (let i = 0; i < existingRows.length; i++) {
        const r = existingRows[i] || [];
        const date = String(r[headerIndex.Date] ?? '').trim();
        const chan = String(r[headerIndex.SalesChannel] ?? '').trim();
        if (date !== dateSheet || chan !== 'Amazon') continue;

        const existingOid = String(r[orderIdIdx] ?? '').trim();
        if (existingOid) continue;

        const sig = signatureFromRow(r, headerIndex, skuToColname);
        if (!sig) continue;

        const oid = sigToOid.get(sig);
        if (!oid) continue;

        const sheetRowNum = tailStart + i;
        gogSheetsUpdate(`${SHEET_NAME}!${orderIdColLetter}${sheetRowNum}:${orderIdColLetter}${sheetRowNum}`, [[oid]]);

        // If NOTES only contains an unmapped-SKU warning, and those SKUs are now mappable,
        // clear it (common after adding/repairing mappings).
        const notesIdx = headerIndex['NOTES'];
        if (notesIdx != null) {
          const notesVal = String(r[notesIdx] ?? '').trim();
          if (notesVal.startsWith('UNMAPPED SKU:')) {
            const skus = notesVal
              .replace(/^UNMAPPED SKU:\s*/,'')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

            const allNowMappable = skus.length
              ? skus.every(sku => {
                  const colName = skuToColname[sku];
                  if (!colName) return false;
                  const cidx = headerIndex[colName];
                  return cidx != null;
                })
              : false;

            if (allNowMappable) {
              const notesColLetter = numToCol(notesIdx + 1);
              gogSheetsUpdate(`${SHEET_NAME}!${notesColLetter}${sheetRowNum}:${notesColLetter}${sheetRowNum}`, [['']]);
            }
          }
        }
      }
    }

    // Build rows to add (skip anything already present)
    const rowsToAdd = [];
    const newOrderIds = new Set();
    for (const o of reportOrders) {
      if (!o.units || o.units <= 0) continue;
      let totalStr;
      let notesFx = '';
      if (o.currency !== 'USD') {
        // FX conversion: convert order total to USD and record original currency in NOTES.
        const originalAmt = round2(o.itemTotal);
        const fx = await convertToUsd(originalAmt, o.currency, datePt);
        totalStr = Number(fx.usd).toFixed(2);
        // Brett requested comment like: "CAD $29.05"
        notesFx = `${o.currency} $${originalAmt.toFixed(2)}`;
      } else {
        totalStr = Number(o.itemTotal).toFixed(2);
      }

      const unitsNumStr = String(o.units);
      const items = [];
      for (const [sku, qty] of o.items.entries()) {
        if (!qty) continue;
        items.push([sku, qty]);
      }
      items.sort((a, b) => a[0].localeCompare(b[0]));

      // Prefer dedupe by Amazon Order ID if the column exists.
      if (hasAmazonOrderIdCol) {
        if (existingOrderIds.has(o.oid)) continue;
      } else {
        // Fallback dedupe: signature comparable to sheet signature (uses numeric units)
        const sig = `${totalStr}|${unitsNumStr}|${items.map(([s, q]) => `${s}:${q}`).join(',')}`;
        if (existingSigs.has(sig)) continue;
      }

      const row = Array(header.length).fill('');
      row[headerIndex.Date] = dateSheet;
      row[headerIndex.Total] = totalStr;
      // Units formula will be filled in after we know the target sheet row number.
      row[headerIndex.Units] = '__UNITS_FORMULA__';
      row[headerIndex.SalesChannel] = 'Amazon';
      // SKU quantities
      const unmappedSkus = [];
      for (const [sku, qty] of items) {
        const colName = skuToColname[sku];
        if (!colName) {
          unmappedSkus.push(sku);
          continue;
        }
        const idx = headerIndex[colName];
        row[idx] = String(qty);
      }

      // If nothing mapped, preserve units as a number (can't be derived from empty SKU columns)
      // and leave a note so Brett can add a mapping/column later.
      if (unmappedSkus.length && unmappedSkus.length === items.length) {
        row[headerIndex.Units] = unitsNumStr;
      }

      // NOTES blank unless anomalous (per Brett); include FX original amount if applicable.
      const unmappedNote = unmappedSkus.length ? `UNMAPPED SKU: ${unmappedSkus.sort().join(',')}` : '';
      row[headerIndex['NOTES']] = [notesFx, unmappedNote].filter(Boolean).join(' | ');

      if (hasAmazonOrderIdCol) {
        // Avoid duplicates within the same run.
        if (newOrderIds.has(o.oid)) continue;
        newOrderIds.add(o.oid);
        row[headerIndex[orderIdColName]] = o.oid;
      }

      rowsToAdd.push({ dt: o.dt, oid: o.oid, row });
    }

    if (!rowsToAdd.length) {
      console.log(`No new Amazon orders to add for ${dateSheet}.`);
      return;
    }

    // Ensure chronological order
    rowsToAdd.sort((a, b) => {
      const ta = a.dt?.toMillis?.() ?? 0;
      const tb = b.dt?.toMillis?.() ?? 0;
      if (ta !== tb) return ta - tb;
      return a.oid.localeCompare(b.oid);
    });

    const startRow = lastNonEmpty + 1;
    const endRow = startRow + rowsToAdd.length - 1;
    const range = `${SHEET_NAME}!A${startRow}:${lastCol}${endRow}`;

    const values = rowsToAdd.map((r, idx) => {
      const sheetRowNum = startRow + idx;
      const row = [...r.row];
      const unitsIdx = headerIndex.Units;
      if (row[unitsIdx] === '__UNITS_FORMULA__') {
        const notesIdx = headerIndex['NOTES'];
        const endSkuCol = (notesIdx != null && notesIdx > 4) ? numToCol(notesIdx) : 'CR';
        row[unitsIdx] = `=SUM(E${sheetRowNum}:${endSkuCol}${sheetRowNum})`;
      }
      return row;
    });

    gogSheetsUpdate(range, values);
    console.log(`Inserted ${rowsToAdd.length} Amazon order rows into ${range}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('amazon-sheet-orders-sync failed:', e?.stack || e);
    process.exit(1);
  });
}
