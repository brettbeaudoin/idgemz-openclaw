const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
require('dotenv').config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return resolve(download(res.headers.location, outPath));
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed HTTP ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(outPath, () => reject(err));
      });
  });
}

function toSnake(s) {
  return String(s)
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^\d/, (m) => `c_${m}`);
}

function fmtYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfMonthUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function addMonthsUtc(d, months) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 0, 0, 0));
}

async function ensureAmazonClient(pool) {
  const chRes = await pool.query(
    `SELECT id, name, api_credentials FROM channels WHERE platform='amazon' AND api_connected=true ORDER BY name LIMIT 1`
  );
  if (!chRes.rows.length) throw new Error('Amazon channel not connected');
  const channelId = chRes.rows[0].id;
  const channelName = chRes.rows[0].name;
  const { refreshToken } = chRes.rows[0].api_credentials;

  const sp = new SellingPartner({
    region: 'na',
    refresh_token: refreshToken,
    options: { auto_request_throttled: true }
  });

  return { sp, channelId, channelName };
}

async function requestReport(sp, reportType, marketplaceIds, startIso, endIso) {
  const resp = await sp.callAPI({
    endpoint: 'reports',
    operation: 'createReport',
    body: {
      reportType,
      dataStartTime: startIso,
      dataEndTime: endIso,
      marketplaceIds: marketplaceIds
    }
  });
  return resp?.reportId || resp?.payload?.reportId;
}

async function loadTsvToRaw({ dbUrl, psqlPath, filePath, tableName, schema = 'raw' }) {
  // Create table from first header line
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 256);
  const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const firstChunk = buf.slice(0, bytes).toString('utf8');
  const headerLine = firstChunk.split(/\r?\n/)[0];

  // Amazon will sometimes return an error as the file body.
  if (!headerLine.includes('\t')) {
    throw new Error(`Unexpected header. First line: ${headerLine.slice(0, 200)}`);
  }

  const headers = headerLine.split('\t');
  if (headers.length < 5) {
    throw new Error(`Unexpected header (too few columns). First line: ${headerLine.slice(0, 200)}`);
  }

  const cols = [];
  const seen = new Map();
  for (const h of headers) {
    let c = toSnake(h);
    if (!c) c = 'col';
    if (seen.has(c)) {
      const n = seen.get(c) + 1;
      seen.set(c, n);
      c = `${c}_${n}`;
    } else {
      seen.set(c, 1);
    }
    cols.push(c);
  }

  const { spawnSync } = require('child_process');

  const createSql = [
    `create schema if not exists ${schema};`,
    `drop table if exists ${schema}.${tableName};`,
    `create table ${schema}.${tableName} (`,
    cols.map((c) => `  ${c} text`).join(',\n'),
    `);`
  ].join('\n');

  const p1 = spawnSync(psqlPath, [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', createSql], { stdio: 'inherit' });
  if (p1.status !== 0) throw new Error('psql create table failed');

  const copyCmd = `\\copy ${schema}.${tableName} from '${filePath.replace(/'/g, "''")}' with (format csv, header true, delimiter E'\\t', quote '"');`;
  const p2 = spawnSync(psqlPath, [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', copyCmd], { stdio: 'inherit' });
  if (p2.status !== 0) throw new Error('psql copy failed');

  return `${schema}.${tableName}`;
}

async function ensureJobs(pool, channelId, { reportType, marketplaceId, startDateUtc, endDateUtc }) {
  // Create jobs in calendar-month chunks (UTC): [YYYY-MM-01, next YYYY-MM-01)
  // This avoids overlapping 30-day windows and matches “month-by-month” expectations.
  const start = startOfMonthUtc(startDateUtc);
  const end = startOfMonthUtc(endDateUtc);

  let cursor = new Date(start.getTime());
  let created = 0;

  while (cursor < end) {
    const next = addMonthsUtc(cursor, 1);
    const startIso = cursor.toISOString();
    const endIso = next.toISOString();

    const res = await pool.query(
      `INSERT INTO backfill.jobs (channel_id, job_type, report_type, marketplace_id, data_start_time, data_end_time, processing_status)
       VALUES ($1,'amazon_report_monthly',$2,$3,$4,$5,'PENDING')
       ON CONFLICT (channel_id, report_type, data_start_time, data_end_time)
       DO NOTHING`,
      [channelId, reportType, marketplaceId, startIso, endIso]
    );
    if (res.rowCount) created += res.rowCount;

    cursor = next;
  }

  return created;
}

async function pickNextJob(pool, channelId, reportType) {
  // Only work the new month-aligned job stream so we don’t keep chewing through legacy overlapping 30-day windows.
  const res = await pool.query(
    `SELECT *
     FROM backfill.jobs
     WHERE channel_id = $1
       AND report_type = $2
       AND job_type = 'amazon_report_monthly'
       AND coalesce(processing_status,'') NOT IN ('LOADED','ERROR','SKIPPED','EMPTY')
     ORDER BY data_start_time ASC
     LIMIT 1`,
    [channelId, reportType]
  );
  return res.rows[0] || null;
}

async function runOnce({ dbUrl, psqlPath, outDir, marketplaceIds }) {
  const pool = new Pool({ connectionString: dbUrl });

  const reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';

  // Backfill window (UTC): run month-by-month until 2026-01-01 (exclusive)
  // NOTE: Date.UTC month is 0-indexed; (2023, 5, 1) = 2023-06-01.
  const startDateUtc = new Date(Date.UTC(2023, 5, 1, 0, 0, 0));
  const endDateUtc = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

  try {
    const { sp, channelId, channelName } = await ensureAmazonClient(pool);
    fs.mkdirSync(outDir, { recursive: true });

    const created = await ensureJobs(pool, channelId, {
      reportType,
      marketplaceId: marketplaceIds[0],
      startDateUtc,
      endDateUtc
    });

    if (created) {
      console.log(`[backfill] ensured jobs: created ${created} month chunks (UTC)`);
    }

    const job = await pickNextJob(pool, channelId, reportType);
    if (!job) {
      console.log('[backfill] no pending jobs');
      return;
    }

    const startIso = new Date(job.data_start_time).toISOString();
    const endIso = new Date(job.data_end_time).toISOString();

    // If we haven't requested it yet, request report
    if (!job.report_id) {
      console.log(`[backfill] Requesting report for ${channelName}: ${reportType} ${startIso} → ${endIso}`);
      const reportId = await requestReport(sp, reportType, marketplaceIds, startIso, endIso);
      if (!reportId) throw new Error('No reportId returned from createReport');

      await pool.query(
        `UPDATE backfill.jobs SET report_id=$1, processing_status='IN_QUEUE', error=NULL WHERE id=$2`,
        [String(reportId), job.id]
      );

      console.log(`[backfill] Created reportId=${reportId}`);
      return;
    }

    // Poll report
    console.log(`[backfill] Polling reportId=${job.report_id} (${startIso} → ${endIso})`);
    const rep = await sp.callAPI({ endpoint: 'reports', operation: 'getReport', path: { reportId: job.report_id } });
    const status = rep?.processingStatus || rep?.payload?.processingStatus;
    const docId = rep?.reportDocumentId || rep?.payload?.reportDocumentId;

    await pool.query(
      `UPDATE backfill.jobs SET processing_status=$1, report_document_id=$2, error=NULL WHERE id=$3`,
      [status || null, docId || null, job.id]
    );

    console.log(`[backfill] status=${status}${docId ? ` doc=${docId}` : ''}`);

    if (status !== 'DONE' || !docId) return;

    // Get report document
    const doc = await sp.callAPI({ endpoint: 'reports', operation: 'getReportDocument', path: { reportDocumentId: docId } });
    const url = doc?.url || doc?.payload?.url;
    const compressionAlgorithm = doc?.compressionAlgorithm || doc?.payload?.compressionAlgorithm;

    if (!url) throw new Error('No url in report document');

    const baseName = `amazon_all_orders_${fmtYmd(new Date(job.data_start_time))}_${fmtYmd(new Date(job.data_end_time))}_${job.report_id}`;
    const rawPath = path.join(outDir, `${baseName}.txt${compressionAlgorithm === 'GZIP' ? '.gz' : ''}`);
    const outPath = path.join(outDir, `${baseName}.txt`);

    // Download
    if (!fs.existsSync(rawPath) && !fs.existsSync(outPath)) {
      console.log(`[backfill] Downloading report document (${compressionAlgorithm || 'none'})…`);
      await download(url, rawPath);
    }

    // Decompress if needed
    if (compressionAlgorithm === 'GZIP') {
      if (!fs.existsSync(outPath)) {
        console.log('[backfill] Decompressing gzip…');
        const gz = fs.createReadStream(rawPath);
        const out = fs.createWriteStream(outPath);
        await new Promise((resolve, reject) => {
          gz.pipe(zlib.createGunzip()).pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
        });
      }
    } else {
      if (!fs.existsSync(outPath)) fs.copyFileSync(rawPath, outPath);
    }

    // Load to raw table
    const tableName = `amazon_all_orders_${fmtYmd(new Date(job.data_start_time))}_${fmtYmd(new Date(job.data_end_time))}`;
    console.log(`[backfill] Loading TSV into raw table raw.${tableName}…`);

    let loadedTable;
    try {
      loadedTable = await loadTsvToRaw({ dbUrl, psqlPath, filePath: outPath, tableName, schema: 'raw' });
    } catch (e) {
      // record error and stop this job
      await pool.query(
        `UPDATE backfill.jobs SET processing_status='ERROR', error=$1 WHERE id=$2`,
        [String(e?.message || e), job.id]
      );
      console.error('[backfill] load error:', e?.message || e);
      return;
    }

    await pool.query(
      `UPDATE backfill.jobs
       SET document_url=$1, compression_algorithm=$2, raw_file_path=$3, loaded_table=$4, processing_status='LOADED', error=NULL
       WHERE id=$5`,
      [url, compressionAlgorithm || null, outPath, loadedTable, job.id]
    );

    console.log(`[backfill] Loaded into ${loadedTable}. Next: transform into orders/order_items.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/idgemz';
  const psqlPath = '/opt/homebrew/opt/postgresql@16/bin/psql';
  const outDir = path.resolve(__dirname, '../reports/amazon');
  const marketplaceIds = ['ATVPDKIKX0DER','A2EUQ1WTGCTBG2','A1AM78C64UM0Y8'];

  runOnce({ dbUrl, psqlPath, outDir, marketplaceIds }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runOnce };
