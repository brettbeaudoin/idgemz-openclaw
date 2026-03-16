// Suggest categories for QBO Banking → For Review export (CSV)
// and optionally enrich Amazon lines using Amazon Business Orders export.
//
// Usage:
//   node qbo-for-review-suggest.js \
//     --bank "/Users/bbeaudoin/Downloads/ZenBusiness(1).csv" \
//     --bank "/Users/bbeaudoin/Downloads/ZenBusiness(2).csv" \
//     --amazonOrders "/Users/bbeaudoin/Downloads/orders_from_20250101_to_20260228_20260228_1030.csv" \
//     --out "/tmp/qbo-for-review-suggestions.csv"
//
// Notes:
// - Bank feed exports do NOT include full Amazon order details.
// - Amazon Business "Orders" export only covers placed orders; it will not contain Prime/digital charges
//   and will not contain Amazon seller payouts/settlements.

const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i] ?? '';
    rows.push(obj);
  }
  return rows;
}

function parseAmount(s) {
  const n = Number(String(s).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDateMmDdYyyy(s) {
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  return `${yy}-${mm}-${dd}`;
}

function ymdToEpoch(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getTime();
}

function amtKey(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function csvEscape(x) {
  const s = String(x ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const out = { bank: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bank') {
      out.bank.push(argv[++i]);
    } else if (a === '--amazonOrders') {
      if (!out.amazonOrders) out.amazonOrders = [];
      out.amazonOrders.push(argv[++i]);
    } else if (a === '--out') {
      out.out = argv[++i];
    }
  }
  return out;
}

const FILAMENT_OR_BUILD_PLATE_RE = /(\bfilament\b|\bpla\b|\bpla-cf\b|\bpetg\b|\babs\b|\btpu\b|\basa\b|\bnylon\b|\bbuild plate\b|\bprint(ing)? plate\b|\bpei\b|\bpeo\b|\bpet\b|\bflexible removable\b|\bspring steel\b|\bbambu\b.*\bplate\b|\bflashforge\b.*\bfilament\b|\boverture\b.*\bfilament\b|\bhatchbox\b.*\bfilament\b|\bsunlu\b.*\bfilament\b)/i;

const ZIPLOCK_BAGS_RE = /(\bzip\s*bag(s)?\b|\bziplock\b|\bzipper\s*bag(s)?\b|\bresealable\b|\breclosable\b|\bpoly\s*bag(s)?\b|\bclear\s*plastic\s*bag(s)?\b|\bjewelry\s*bag(s)?\b)/i;

function categorizeFromAmazonTitles(titles) {
  const joined = titles.join(' | ');

  // Per Brett: filament + build plates are COGS
  if (FILAMENT_OR_BUILD_PLATE_RE.test(joined)) {
    return {
      cat: 'Cost of goods sold:Supplies & materials',
      confidence: 0.9,
      reason: 'amazon_title_filament_or_build_plate'
    };
  }

  // Per Brett: small ziplock bags used for badge holders are also COGS
  if (ZIPLOCK_BAGS_RE.test(joined)) {
    return {
      cat: 'Cost of goods sold:Supplies & materials',
      confidence: 0.85,
      reason: 'amazon_title_ziplock_bags'
    };
  }

  return null;
}

function buildLearnedCategoryMap(bankRows) {
  const catCounts = new Map();
  for (const r of bankRows) {
    if (!r.cat) continue;
    const key = norm(r.desc);
    if (!key) continue;
    if (!catCounts.has(key)) catCounts.set(key, new Map());
    const m = catCounts.get(key);
    m.set(r.cat, (m.get(r.cat) || 0) + 1);
  }
  return {
    bestCatForDesc(desc) {
      const m = catCounts.get(norm(desc));
      if (!m) return null;
      let best = null;
      let bn = 0;
      for (const [cat, n] of m.entries()) {
        if (n > bn) {
          bn = n;
          best = cat;
        }
      }
      return best;
    }
  };
}

function suggestBase({ row, learned }) {
  const learnedCat = learned.bestCatForDesc(row.desc);
  if (learnedCat) return { cat: learnedCat, confidence: 0.85, reason: 'learned_from_existing' };

  const d = norm(`${row.desc} ${row.fromTo}`);
  const amt = row.amount;

  if (d.includes('usps')) return { cat: 'Office expenses:Shipping & postage', confidence: 0.95, reason: 'rule_usps' };
  if (d.includes('adobe')) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.9, reason: 'rule_adobe' };
  if (d.includes('openai') || d.includes('chatgpt')) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.9, reason: 'rule_openai' };
  if (d.includes('squarespace')) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.85, reason: 'rule_squarespace' };
  if (d.includes('zenbusiness')) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.9, reason: 'rule_zenbusiness' };

  if (d.includes('etsy') && amt != null && amt < 0) return { cat: 'Channel Selling Fees', confidence: 0.85, reason: 'rule_etsy_fee' };
  if (d.includes('etsy') && amt != null && amt > 0) return { cat: 'Sales', confidence: 0.7, reason: 'rule_etsy_payout' };

  if (d.includes('shopify') && amt != null && amt < 0) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.7, reason: 'rule_shopify_fee' };
  if (d.includes('shopify') && amt != null && amt > 0) return { cat: 'Channel Clearing Account:Shopify - c5e7b1-48 Clearing Account', confidence: 0.7, reason: 'rule_shopify_deposit' };

  if (d.includes('walmart') && amt != null && amt > 0) return { cat: 'Sales', confidence: 0.6, reason: 'rule_walmart_transfer' };

  if (d.includes('intuit') && amt != null && amt < 0) return { cat: 'Office expenses:Software & apps', confidence: 0.7, reason: 'rule_intuit' };

  if (d.includes('amazon') && amt != null && amt < 0) {
    const abs = Math.abs(amt);
    if (abs <= 20) return { cat: 'General business expenses:Memberships & subscriptions', confidence: 0.55, reason: 'rule_amazon_small' };
    return { cat: 'Supplies:Supplies & materials', confidence: 0.55, reason: 'rule_amazon_purchase_generic' };
  }

  return { cat: '', confidence: 0.0, reason: 'no_rule' };
}

function loadAmazonOrders(amazonOrdersPaths) {
  const paths = (Array.isArray(amazonOrdersPaths) ? amazonOrdersPaths : (amazonOrdersPaths ? [amazonOrdersPaths] : [])).filter(Boolean);
  if (!paths.length) return { amazonOrders: [], amazonByAmt: new Map() };

  let rows = [];
  for (const p of paths) {
    rows = rows.concat(parseCsvFile(p));
  }

  const amazonOrders = [];
  for (const r of rows) {
    const ymd = parseDateMmDdYyyy(r['Order Date']);
    const payAmt = parseAmount(r['Payment Amount']);
    const instrument = String(r['Payment Instrument Type'] || '').trim();
    const title = String(r['Title'] || '').trim();
    const orderId = String(r['Order ID'] || '').trim();
    if (!ymd || payAmt == null) continue;
    amazonOrders.push({
      ymd,
      epoch: ymdToEpoch(ymd),
      orderId,
      paymentAmount: payAmt,
      instrument,
      title
    });
  }

  const amazonByAmt = new Map();
  for (const o of amazonOrders) {
    const k = amtKey(o.paymentAmount);
    if (!amazonByAmt.has(k)) amazonByAmt.set(k, []);
    amazonByAmt.get(k).push(o);
  }
  for (const [, arr] of amazonByAmt.entries()) arr.sort((a, b) => a.epoch - b.epoch);

  return { amazonOrders, amazonByAmt };
}

function matchAmazonOrders({ row, amazonByAmt }) {
  if (!amazonByAmt || row.amount == null) return [];
  if (row.amount >= 0) return [];

  const abs = Math.abs(row.amount);
  const key = amtKey(abs);
  const candidates = amazonByAmt.get(key) || [];
  if (!row.ymd) return candidates.slice(0, 5);

  const t = ymdToEpoch(row.ymd);
  // allow ±5 days
  const within = candidates.filter((o) => Math.abs(o.epoch - t) <= 5 * 86400 * 1000);
  return (within.length ? within : candidates).slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.bank.length) throw new Error('Pass at least one --bank file');

  const outPath = args.out || '/tmp/qbo-for-review-suggestions.csv';

  // Bank feed
  let bank = [];
  for (const f of args.bank) {
    const rows = parseCsvFile(f);
    for (const r of rows) {
      const ymd = parseDateMmDdYyyy(r['Date']);
      bank.push({
        src: path.basename(f),
        date: r['Date'],
        ymd,
        desc: r['Bank description'],
        amount: parseAmount(r['Amount']),
        fromTo: r['From/To'],
        cat: r['Match/Categorize']
      });
    }
  }

  const learned = buildLearnedCategoryMap(bank);
  const pending = bank.filter((r) => !r.cat);

  // Amazon Orders
  const { amazonByAmt } = loadAmazonOrders(args.amazonOrders);

  const enriched = pending.map((r) => {
    const s = suggestBase({ row: r, learned });

    const isAmazon = /\bamazon\b/i.test(r.desc || '') || /\bamazon\b/i.test(r.fromTo || '');
    const matches = isAmazon ? matchAmazonOrders({ row: r, amazonByAmt }) : [];

    const titles = matches.map((m) => m.title).filter(Boolean);
    const amazonMatchPreview = titles.slice(0, 3).join(' | ');

    const amazonCat = titles.length ? categorizeFromAmazonTitles(titles) : null;
    if (amazonCat) {
      s.cat = amazonCat.cat;
      s.confidence = Math.max(s.confidence, amazonCat.confidence);
      s.reason = amazonCat.reason;
    }

    return {
      Date: r.date,
      Description: r.desc,
      Amount: r.amount,
      FromTo: r.fromTo,
      Suggested: s.cat,
      Confidence: s.confidence,
      Reason: s.reason,
      AmazonMatch: amazonMatchPreview,
      SourceFile: r.src
    };
  });

  const cols = ['Date', 'Description', 'Amount', 'FromTo', 'Suggested', 'Confidence', 'Reason', 'AmazonMatch', 'SourceFile'];
  const lines = [cols.join(',')];
  for (const row of enriched) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'));

  const amazonPending = enriched.filter((r) => /\bamazon\b/i.test(r.Description || ''));
  const amazonMatched = amazonPending.filter((r) => String(r.AmazonMatch || '').trim());

  console.log('Pending rows:', pending.length);
  console.log('Wrote:', outPath);
  console.log('Amazon pending:', amazonPending.length, 'with order match:', amazonMatched.length);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
