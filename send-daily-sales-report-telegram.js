#!/usr/bin/env node

// Generates the daily sales report (yesterday PT) and sends the summary to Brett on Telegram.

const { execFileSync } = require('child_process');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { generateDailySalesReport } = require('./daily-sales-report');

function toPlainTelegramSummary(report) {
  const formatCurrency = (amount) => `$${Number(amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const arrow = (value) => value >= 0 ? '📈' : '📉';
  const percentChange = (current, previous) => {
    if (previous === 0) return current > 0 ? '+100%' : '0%';
    const pct = ((current - previous) / previous * 100).toFixed(1);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };

  const lines = [];
  lines.push('📊 IDGemz Daily Sales Report');
  lines.push(`📅 ${report.date}`);
  lines.push('');
  lines.push(`💰 Total Sales: ${formatCurrency(report.summary.totalRevenue)} (${report.summary.totalOrders} orders, ${report.summary.unitsSold} units)`);
  lines.push(`📊 Average Order: ${formatCurrency(report.summary.averageOrderValue)}`);
  lines.push('');
  lines.push('📈 Week-over-Week:');
  lines.push(`${arrow(report.weekComparison.revenueChange)} Revenue: ${percentChange(report.summary.totalRevenue, report.weekComparison.lastWeekRevenue)} (${formatCurrency(Math.abs(report.weekComparison.revenueChange))})`);
  lines.push(`${arrow(report.weekComparison.ordersChange)} Orders: ${percentChange(report.summary.totalOrders, report.weekComparison.lastWeekOrders)} (${Math.abs(report.weekComparison.ordersChange)} orders)`);
  if (Array.isArray(report.topProducts) && report.topProducts.length) {
    lines.push('');
    lines.push('🏆 Top Products:');
    report.topProducts.slice(0, 3).forEach((product, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
      lines.push(`${medal} ${product.product} — ${product.unitsSold} units = ${formatCurrency(product.revenue)}`);
    });
  }
  return lines.join('\n');
}

async function main() {
  const channel = process.env.DAILY_REPORT_CHANNEL || 'telegram';
  const target = process.env.DAILY_REPORT_TELEGRAM_TARGET || '8130524019';
  const { report } = await generateDailySalesReport();
  const body = toPlainTelegramSummary(report);

  execFileSync('openclaw', [
    'message', 'send',
    '--channel', channel,
    '--target', target,
    '--message', body
  ], { stdio: 'inherit', timeout: 120000 });

  console.log(`Sent Telegram daily sales summary for ${report.date} to ${target}.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('send-daily-sales-report-telegram failed:', e?.stack || e);
    process.exit(1);
  });
}
