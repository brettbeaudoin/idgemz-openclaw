#!/usr/bin/env node

// Hourly Etsy email pipeline:
// 1) Import forwarded Etsy sale emails into Postgres.
// 2) Rebuild today's Orders sheet block from Postgres so imported orders are visible.

const { execFileSync } = require('child_process');
const path = require('path');

const cwd = __dirname;

function formatDateInLosAngeles(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function todayInLosAngeles() {
  return formatDateInLosAngeles(new Date());
}

function yesterdayInLosAngeles() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateInLosAngeles(d);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
    ...options
  });
}

function main() {
  const importOutput = run('node', ['import-etsy-forwarded-emails.js']);
  process.stdout.write(importOutput);

  const requestedDatePt = process.env.DATE_PT || todayInLosAngeles();
  const datePts = Array.from(new Set([yesterdayInLosAngeles(), requestedDatePt]));

  for (const datePt of datePts) {
    const syncOutput = run('node', ['postgres-sheet-orders-sync.js'], {
      env: { ...process.env, DATE_PT: datePt }
    });
    process.stdout.write(syncOutput);
  }

  console.log(`Etsy email pipeline complete: sheet synced for DATE_PT=${datePts.join(', ')}`);
}

try {
  main();
} catch (err) {
  if (err.stdout) process.stdout.write(String(err.stdout));
  if (err.stderr) process.stderr.write(String(err.stderr));
  console.error(err?.stack || err);
  process.exit(1);
}
