#!/usr/bin/env node

// Legacy helper: generates the daily sales report (yesterday PT) and sends it via Gmail.
// The live daily report pipeline is Telegram-first; this script is for explicit manual use only.
// Keep cron/report automation pointed at send-daily-sales-report-telegram.js.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('./gog-env');

const { generateDailySalesReport } = require('./daily-sales-report');

async function main() {
  const to = process.env.DAILY_REPORT_TO || 'brett@nerdwidgets.com';
  const fromAccount = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

  const { report } = await generateDailySalesReport();

  const htmlPath = '/tmp/idgemz-daily-report.html';
  const html = fs.readFileSync(htmlPath, 'utf8');

  const subject = `IDGemz Daily Sales Report — ${report.date}`;

  try {
    execFileSync('gog', [
      'gmail', 'send',
      '--account', fromAccount,
      '--to', to,
      '--subject', subject,
      '--body-html', html
    ], { stdio: 'inherit', timeout: 120000 });
  } catch (error) {
    const detail = error?.stderr?.toString?.() || error?.message || String(error);
    const normalized = String(detail).trim();
    const authHint = /unauthorized_client|invalid_grant|cannot fetch token|oauth2/i.test(normalized)
      ? ' Gmail OAuth is currently broken for this account; re-auth in gog before retrying.'
      : '';
    const wrapped = new Error(
      `Gmail send failed for ${fromAccount} → ${to}. ` +
      `The report was still generated at ${htmlPath}. Root cause: ${normalized}.${authHint}`
    );
    wrapped.cause = error;
    throw wrapped;
  }

  console.log('Sent:', subject);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('send-daily-sales-report-email failed:', e?.stack || e);
    process.exit(1);
  });
}
