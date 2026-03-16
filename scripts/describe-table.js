#!/usr/bin/env node
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const table = process.argv[2];
if (!table) {
  console.error('Usage: node scripts/describe-table.js <table_name>');
  process.exit(2);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table]
  );

  const constraints = await pool.query(
    `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
     FROM information_schema.table_constraints tc
     LEFT JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name=kcu.constraint_name
      AND tc.table_schema=kcu.table_schema
     WHERE tc.table_schema='public' AND tc.table_name=$1
     ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position`,
    [table]
  );

  console.log(JSON.stringify({ table, columns: cols.rows, constraints: constraints.rows }, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
