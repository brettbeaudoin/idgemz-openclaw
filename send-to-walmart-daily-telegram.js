#!/usr/bin/env node

// Daily "Send to Walmart" Telegram delivery for WFS restock recommendations.

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DateTime } = require('luxon');
const { WalmartClient } = require('./walmart-client');

const TELEGRAM_TARGET = process.env.SEND_TO_WALMART_TELEGRAM_TARGET || '8130524019';
const TELEGRAM_CHANNEL = process.env.SEND_TO_WALMART_CHANNEL || 'telegram';

function getAllowedAttachmentDir() {
  return process.env.SEND_TO_WALMART_ATTACHMENT_DIR
    || path.join('/tmp', 'openclaw', 'idgemz');
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function num(x) {
  if (x == null || x === '') return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys, fallback = '') {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return fallback;
}

function normalizeItems(payload) {
  const rawItems = payload?.recommendedItemDetails || payload?.recommendedItems || payload?.items || payload?.itemDetails || [];
  return rawItems.map((item) => ({
    sku: pick(item, ['sku', 'sellerSku', 'itemSku', 'merchantSku'], ''),
    available: num(pick(item, ['availableQty', 'availableQuantity', 'availableInventory', 'available'], 0)),
    inbound: num(pick(item, ['inboundQty', 'inboundQuantity', 'inboundInventory', 'inbound'], 0)),
    onHand: num(pick(item, ['onHandQty', 'onHandQuantity', 'onHandInventory', 'onHand'], 0)),
    recommended: num(pick(item, ['recommendedShipmentQty', 'recommendedQuantity', 'recommendedQty', 'recommendedUnits'], 0)),
    demand: pick(item, ['demandTier', 'demandCategory', 'customerDemandLabel', 'isInDemand'], ''),
    atRiskSales: num(pick(item, ['forecastedSalesAtRisk', 'salesAtRisk', 'atRiskGmv'], 0)),
    estimatedLift: num(pick(item, ['estimatedSalesLift', 'forecastedSalesLift', 'salesLift'], 0))
  }));
}

function formatCurrency(amount) {
  return `$${num(amount).toFixed(2)}`;
}

function formatHtmlDocument(rows, dateStr, summary = {}) {
  const rowHtml = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.sku)}</td>
      <td class="num">${escapeHtml(r.available)}</td>
      <td class="num">${escapeHtml(r.inbound)}</td>
      <td class="num">${escapeHtml(r.onHand)}</td>
      <td class="num">${escapeHtml(r.recommended)}</td>
      <td>${escapeHtml(r.demand || '')}</td>
      <td class="num">${escapeHtml(r.atRiskSales)}</td>
      <td class="num">${escapeHtml(r.estimatedLift)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Send to Walmart — ${escapeHtml(dateStr)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 8px 0; font-size: 24px; }
    p { margin: 0 0 12px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; }
    th { background: #f3f4f6; text-align: left; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .note { margin-top: 14px; font-size: 12px; color: #444; }
  </style>
</head>
<body>
  <h1>Send to Walmart</h1>
  <p>${escapeHtml(dateStr)}</p>
  <p>Total recommendations: <strong>${escapeHtml(summary.totalRecords ?? rows.length)}</strong>${summary.totalForecastedSalesAtRisk != null ? ` · At-risk sales: <strong>${escapeHtml(formatCurrency(summary.totalForecastedSalesAtRisk))}</strong>` : ''}${summary.totalEstimatedSalesLift != null ? ` · Estimated lift: <strong>${escapeHtml(formatCurrency(summary.totalEstimatedSalesLift))}</strong>` : ''}</p>
  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Available</th>
        <th>Inbound</th>
        <th>On hand</th>
        <th>Recommended qty</th>
        <th>Demand</th>
        <th>At-risk sales</th>
        <th>Estimated lift</th>
      </tr>
    </thead>
    <tbody>
      ${rowHtml || '<tr><td colspan="8">No WFS restock recommendations returned today.</td></tr>'}
    </tbody>
  </table>
  <div class="note">Source: Walmart WFS restock recommendations API.</div>
</body>
</html>`;
}

function formatTextSummary(rows, dateStr, summary = {}) {
  const lines = [
    `🛒 Send to Walmart — ${dateStr}`,
    rows.length
      ? `${rows.length} WFS restock recommendation${rows.length === 1 ? '' : 's'}.`
      : 'No WFS restock recommendations returned today.'
  ];

  if (summary.totalForecastedSalesAtRisk != null || summary.totalEstimatedSalesLift != null) {
    lines.push(`At-risk sales: ${formatCurrency(summary.totalForecastedSalesAtRisk || 0)} · Estimated lift: ${formatCurrency(summary.totalEstimatedSalesLift || 0)}`);
  }
  lines.push('');
  const topRows = rows.slice(0, 25);
  for (const r of topRows) {
    lines.push(`• ${r.sku} — avail ${r.available}, inbound ${r.inbound}, on-hand ${r.onHand}, rec ${r.recommended}, demand ${r.demand || 'n/a'}, at-risk ${formatCurrency(r.atRiskSales)}, lift ${formatCurrency(r.estimatedLift)}`);
  }
  if (rows.length > topRows.length) lines.push(`…and ${rows.length - topRows.length} more recommendation${rows.length - topRows.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
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
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    throw new Error(combined.trim() || `openclaw message send failed with status ${result.status}`);
  }

  return { mode: 'attachment' };
}

async function main() {
  const client = new WalmartClient();
  const { json } = await client.request('/v3/wfs/recommendation/restock', { timeoutMs: 90000 });
  if (json?.status !== 'OK') {
    throw new Error(`Unexpected Walmart response: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const summary = {
    totalRecords: json?.payload?.totalRecords ?? 0,
    totalForecastedSalesAtRisk: num(json?.payload?.totalInsights?.totalForecastedSalesAtRisk),
    totalEstimatedSalesLift: num(json?.payload?.totalInsights?.totalEstimatedSalesLift)
  };
  const rows = normalizeItems(json?.payload || {});
  rows.sort((a, b) => (b.recommended - a.recommended) || (b.atRiskSales - a.atRiskSales) || a.sku.localeCompare(b.sku));

  const dateStr = DateTime.now().setZone('America/New_York').toISODate();
  const attachmentDir = getAllowedAttachmentDir();
  fs.mkdirSync(attachmentDir, { recursive: true });
  const attachmentPath = path.join(attachmentDir, `send-to-walmart-${dateStr}.html`);
  fs.writeFileSync(attachmentPath, formatHtmlDocument(rows, dateStr, summary), 'utf8');

  const caption = rows.length
    ? `🛒 Send to Walmart — ${dateStr}\n${rows.length} WFS restock recommendation${rows.length === 1 ? '' : 's'}. HTML attachment is printable.`
    : `🛒 Send to Walmart — ${dateStr}\nNo WFS restock recommendations returned today. HTML attachment included for reference.`;

  const sendResult = sendTelegramWithAttachment({
    channel: TELEGRAM_CHANNEL,
    target: TELEGRAM_TARGET,
    caption,
    attachmentPath
  });

  console.log(`Sent daily Send to Walmart Telegram ${sendResult.mode} to ${TELEGRAM_TARGET} (rows: ${rows.length}).`);
}

main().catch((e) => {
  console.error('send-to-walmart-daily-telegram failed:', e?.stack || e);
  process.exit(1);
});
