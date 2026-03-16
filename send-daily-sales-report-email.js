#!/usr/bin/env node

// Generates the daily sales report (yesterday PT) and emails it to Brett.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { generateDailySalesReport } = require('./daily-sales-report');

async function main() {
  const to = process.env.DAILY_REPORT_TO || 'brett@nerdwidgets.com';
  const fromAccount = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';

  const { report } = await generateDailySalesReport();

  const htmlPath = '/tmp/idgemz-daily-report.html';
  const html = fs.readFileSync(htmlPath, 'utf8');

  const subject = `IDGemz Daily Sales Report — ${report.date}`;

  execFileSync('gog', [
    'gmail', 'send',
    '--account', fromAccount,
    '--to', to,
    '--subject', subject,
    '--body-html', html
  ], { stdio: 'inherit', timeout: 120000 });

  console.log('Sent:', subject);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('send-daily-sales-report-email failed:', e?.stack || e);
    process.exit(1);
  });
}
