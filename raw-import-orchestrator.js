// Orchestrator: when Amazon backfill is done, import raw.amazon_all_orders_all into public tables once.
// Sends a Telegram when complete.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKFILL_STATE = path.resolve(__dirname, '../memory/amazon-backfill-state.json');
const IMPORT_STATE = path.resolve(__dirname, '../memory/raw-amazon-import-state.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function main() {
  const backfill = readJson(BACKFILL_STATE);
  if (!backfill?.done) {
    console.log('Backfill not done; skipping raw import.');
    return;
  }

  const imp = readJson(IMPORT_STATE) || { done: false };
  if (imp.done) {
    console.log('Raw import already done; skipping.');
    return;
  }

  const startedAt = new Date().toISOString();
  console.log('Starting raw->public import...');

  execSync('node raw-amazon-all-orders-to-public.js', {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env
  });

  const finishedAt = new Date().toISOString();
  writeJson(IMPORT_STATE, { done: true, startedAt, finishedAt });

  console.log('Raw->public import done.');
}

if (require.main === module) {
  main();
}
