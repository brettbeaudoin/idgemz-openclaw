const { SellingPartner } = require('amazon-sp-api');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
require('dotenv').config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {
    year: 2023,
    pollSeconds: 20,
    timeoutMinutes: 40,
    outDir: path.resolve(__dirname, '../reports/amazon'),
    psql: '/opt/homebrew/opt/postgresql@16/bin/psql',
    dbUrl: process.env.DATABASE_URL || 'postgresql://localhost/idgemz'
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') args.year = parseInt(argv[++i], 10);
    else if (a === '--poll-seconds') args.pollSeconds = parseInt(argv[++i], 10);
    else if (a === '--timeout-minutes') args.timeoutMinutes = parseInt(argv[++i], 10);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--psql') args.psql = argv[++i];
    else if (a === '--db-url') args.dbUrl = argv[++i];
  }
  return args;
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

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return resolve(download(res.headers.location, outPath));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      fs.unlink(outPath, () => reject(err));
    });
  });
}

async function run() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });

  const pool = new Pool({ connectionString: args.dbUrl });

  try {
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

    const start = new Date(Date.UTC(args.year, 0, 1, 0, 0, 0));
    const end = new Date(Date.UTC(args.year + 1, 0, 1, 0, 0, 0));

    const reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';

    console.log(`Requesting report: ${reportType}`);
    console.log(`Channel: ${channelName} (${channelId})`);
    console.log(`Range: ${start.toISOString()} → ${end.toISOString()}`);

    const createResp = await sp.callAPI({
      endpoint: 'reports',
      operation: 'createReport',
      body: {
        reportType,
        dataStartTime: start.toISOString(),
        dataEndTime: end.toISOString(),
        marketplaceIds: ['ATVPDKIKX0DER']
      }
    });

    const reportId = createResp?.reportId || createResp?.payload?.reportId;
    if (!reportId) throw new Error(`No reportId in response: ${JSON.stringify(createResp).slice(0, 400)}`);

    console.log(`Report created: reportId=${reportId}`);

    const deadline = Date.now() + args.timeoutMinutes * 60 * 1000;
    let status;
    let reportDocumentId;

    while (Date.now() < deadline) {
      const rep = await sp.callAPI({
        endpoint: 'reports',
        operation: 'getReport',
        path: { reportId }
      });
      status = rep?.processingStatus || rep?.payload?.processingStatus;
      reportDocumentId = rep?.reportDocumentId || rep?.payload?.reportDocumentId;

      console.log(`Status: ${status}${reportDocumentId ? ` doc=${reportDocumentId}` : ''}`);

      if (status === 'DONE' && reportDocumentId) break;
      if (status === 'CANCELLED' || status === 'FATAL') throw new Error(`Report failed: status=${status}`);

      await sleep(args.pollSeconds * 1000);
    }

    if (!(status === 'DONE' && reportDocumentId)) {
      throw new Error(`Timed out waiting for report. status=${status} doc=${reportDocumentId}`);
    }

    const doc = await sp.callAPI({
      endpoint: 'reports',
      operation: 'getReportDocument',
      path: { reportDocumentId }
    });

    const url = doc?.url || doc?.payload?.url;
    const compressionAlgorithm = doc?.compressionAlgorithm || doc?.payload?.compressionAlgorithm;
    if (!url) throw new Error('No download url in report document response');

    const baseName = `amazon_all_orders_${args.year}_${reportId}`;
    const rawPath = path.join(args.outDir, `${baseName}.txt${compressionAlgorithm === 'GZIP' ? '.gz' : ''}`);
    const outPath = path.join(args.outDir, `${baseName}.txt`);

    console.log(`Downloading report document… (${compressionAlgorithm || 'none'})`);
    await download(url, rawPath);

    if (compressionAlgorithm === 'GZIP') {
      console.log('Decompressing gzip…');
      const gz = fs.createReadStream(rawPath);
      const out = fs.createWriteStream(outPath);
      await new Promise((resolve, reject) => {
        gz.pipe(zlib.createGunzip()).pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
    } else {
      fs.copyFileSync(rawPath, outPath);
    }

    // Read header line to generate a raw table
    const fd = fs.openSync(outPath, 'r');
    const buf = Buffer.alloc(1024 * 128);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstChunk = buf.slice(0, bytes).toString('utf8');
    const headerLine = firstChunk.split(/\r?\n/)[0];
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

    const schema = 'raw';
    const table = `amazon_all_orders_${args.year}`;

    const createSql = [
      `create schema if not exists ${schema};`,
      `drop table if exists ${schema}.${table};`,
      `create table ${schema}.${table} (`,
      cols.map((c) => `  ${c} text`).join(',\n'),
      `);`
    ].join('\n');

    // Create table
    console.log(`Creating table ${schema}.${table} (${cols.length} columns)…`);
    const p1 = spawnSync(args.psql, [args.dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', createSql], { stdio: 'inherit' });
    if (p1.status !== 0) throw new Error('psql create table failed');

    // Load data (TSV)
    console.log(`Loading data into ${schema}.${table}…`);
    const copyCmd = `\\copy ${schema}.${table} from '${outPath.replace(/'/g, "''")}' with (format csv, header true, delimiter E'\\t', quote '"');`;
    const p2 = spawnSync(args.psql, [args.dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', copyCmd], { stdio: 'inherit' });
    if (p2.status !== 0) throw new Error('psql copy failed');

    // quick count
    const p3 = spawnSync(args.psql, [args.dbUrl, '-c', `select count(*) as rows from ${schema}.${table};`], { stdio: 'inherit' });
    if (p3.status !== 0) throw new Error('psql count failed');

    console.log('Done. Next: transform from raw.amazon_all_orders_* into orders/order_items.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { run };
