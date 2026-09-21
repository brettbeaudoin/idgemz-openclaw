#!/usr/bin/env node

/**
 * Stateful Gmail triage for dangerboatai@gmail.com.
 * Alerts Brett only for new unread messages that look important/actionable.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';
const TELEGRAM_TARGET = process.env.GMAIL_TRIAGE_TELEGRAM_TARGET || '8130524019';
const TELEGRAM_CHANNEL = process.env.GMAIL_TRIAGE_CHANNEL || 'telegram';
const STATE_PATH = process.env.GMAIL_TRIAGE_STATE || path.join(__dirname, '..', 'memory', 'gmail-triage-state.json');
const MAX_MESSAGES = Number(process.env.GMAIL_TRIAGE_MAX || 50);
const QUERY = process.env.GMAIL_TRIAGE_QUERY || 'label:unread in:inbox newer_than:30d';
const DRY_RUN = process.argv.includes('--dry-run');
const SEED = process.argv.includes('--seed-current') || process.argv.includes('--seed');
const LIST_ALL = process.argv.includes('--list-all');
const GOG_KEYRING_PASSWORD_FILE = '/Users/bbeaudoin/.config/gogcli-keyring-password';

function loadGogKeyringPassword() {
  if (process.env.GOG_KEYRING_PASSWORD) return process.env.GOG_KEYRING_PASSWORD;
  try {
    return fs.readFileSync(GOG_KEYRING_PASSWORD_FILE, 'utf8').trim();
  } catch {
    return undefined;
  }
}

const env = {
  ...process.env,
  HOME: process.env.HOME || '/Users/bbeaudoin',
  USER: process.env.USER || 'bbeaudoin',
  LOGNAME: process.env.LOGNAME || 'bbeaudoin',
  SHELL: process.env.SHELL || '/bin/zsh',
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/bbeaudoin/.local/bin:${process.env.PATH || ''}`,
  GOG_ACCOUNT: ACCOUNT,
  GOG_KEYRING_PASSWORD: loadGogKeyringPassword()
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { seen: {}, alerted: {}, lastRunAt: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function gog(args) {
  const out = execFileSync('gog', args, { encoding: 'utf8', env, timeout: 90000 });
  return JSON.parse(out);
}

function norm(s) { return String(s || '').toLowerCase(); }
function header(headers, name) { return headers?.[name.toLowerCase()] || headers?.[name] || ''; }

function getMessage(id) {
  try {
    return gog(['gmail', 'get', id, '--format=full', '--json', '--no-input']);
  } catch (e) {
    return null;
  }
}

function classify(m, full) {
  const from = norm(m.from || header(full?.headers, 'from'));
  const subj = String(m.subject || header(full?.headers, 'subject') || '(no subject)');
  const s = norm(subj);
  const body = norm(full?.body || full?.message?.snippet || '');
  const text = `${from}\n${s}\n${body}`;

  const reasons = [];
  let priority = 0;

  const routine = [
    /amazon business <no-reply@business\.amazon\.com>/,
    /mailer@shopify\.com.*payout for/,
    /transaction@etsy\.com.*you made a sale on etsy/,
    /ebay@ebay\.com/,
    /notion.*unlock|promo|newsletter|survey/i
  ];
  if (routine.some((re) => re.test(`${from} ${s}`))) {
    return { important: false, category: 'routine', reasons: ['routine commerce/marketing notice'] };
  }

  if (/brett@nerdwidgets\.com|bbeaudoin@gmail\.com/.test(from)) {
    priority += 100;
    reasons.push('from Brett');
  }
  if (/read the attachment|contact me|please|can you|action needed|urgent|important/.test(text)) {
    priority += 30;
    reasons.push('requests action/review');
  }
  if (/security alert|suspicious|unauthorized|password|oauth|token|access granted|account access/.test(text)) {
    priority += 45;
    reasons.push('security/auth related');
  }
  if (/tax|taxes|due|deadline|invoice|bill|billing|payment|trial.*ended|upgrade to paid|deleted after \d+ days|keep what you.ve built/.test(text)) {
    priority += 40;
    reasons.push('billing/tax/deadline risk');
  }
  if (/amazon seller|seller central|sp-api|product support|return|refund|chargeback|claim|complaint|negative feedback|a-to-z|deactivation|suspend|policy violation/.test(text)) {
    priority += 35;
    reasons.push('Amazon/customer/account issue');
  }
  if (/ship by|late shipment|overdue|cancellation|failed|exception|unable to process/.test(text) && !/you made a sale on etsy/.test(text)) {
    priority += 30;
    reasons.push('order/shipping exception');
  }

  return {
    important: priority >= 35,
    category: priority >= 100 ? 'direct-request' : priority >= 45 ? 'urgent-review' : priority >= 35 ? 'review' : 'low-signal',
    priority,
    reasons: [...new Set(reasons)]
  };
}

function summarizeMessage(m, full, cls) {
  const body = String(full?.body || full?.message?.snippet || m.snippet || '').replace(/\s+/g, ' ').trim();
  const attachments = full?.attachments?.map((a) => `${a.filename}${a.sizeHuman ? ` (${a.sizeHuman})` : ''}`) || [];
  const lines = [
    `• ${m.subject || '(no subject)'}`,
    `  From: ${m.from || header(full?.headers, 'from') || '(unknown)'}`,
    `  Date: ${m.date || header(full?.headers, 'date') || '(unknown)'}`,
    `  Why: ${cls.reasons.join(', ') || cls.category}`
  ];
  if (attachments.length) lines.push(`  Attachments: ${attachments.join(', ')}`);
  if (body) lines.push(`  Summary: ${body.slice(0, 420)}${body.length > 420 ? '…' : ''}`);
  return lines.join('\n');
}

function sendTelegram(text) {
  const result = spawnSync('openclaw', [
    'message', 'send',
    '--channel', TELEGRAM_CHANNEL,
    '--target', TELEGRAM_TARGET,
    '--message', text
  ], { encoding: 'utf8', env, timeout: 90000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`openclaw message send failed: ${result.stdout}\n${result.stderr}`.trim());
}

function main() {
  const state = loadState();
  const now = new Date().toISOString();
  const res = gog(['gmail', 'messages', 'search', QUERY, '--max', String(MAX_MESSAGES), '--json', '--no-input']);
  const messages = res.messages || [];
  const importantNew = [];
  const reviewed = [];

  for (const m of messages) {
    const id = m.id;
    const full = getMessage(id);
    const cls = classify(m, full);
    reviewed.push({ id, subject: m.subject, from: m.from, date: m.date, classification: cls.category, important: cls.important, reasons: cls.reasons });

    if (SEED) {
      state.seen[id] = { at: now, seeded: true, subject: m.subject };
      if (cls.important) state.alerted[id] = { at: now, seeded: true, subject: m.subject };
      continue;
    }

    if (state.seen[id]) continue;
    state.seen[id] = { at: now, subject: m.subject, important: cls.important, category: cls.category };
    if (cls.important && !state.alerted[id]) {
      state.alerted[id] = { at: now, subject: m.subject, category: cls.category };
      importantNew.push({ m, full, cls });
    }
  }

  state.lastRunAt = now;
  state.lastQuery = QUERY;
  state.lastReviewedCount = messages.length;
  state.lastImportantNewCount = importantNew.length;

  if (LIST_ALL || DRY_RUN || SEED) {
    console.log(JSON.stringify({ dryRun: DRY_RUN, seed: SEED, query: QUERY, reviewedCount: messages.length, importantNewCount: importantNew.length, reviewed }, null, 2));
  }

  if (!DRY_RUN && importantNew.length) {
    const body = importantNew.map(({ m, full, cls }) => summarizeMessage(m, full, cls)).join('\n\n');
    sendTelegram(`📬 Important unread Gmail item${importantNew.length === 1 ? '' : 's'}\n\n${body}`);
  }

  if (!DRY_RUN) saveState(state);
}

try {
  main();
} catch (e) {
  console.error(e?.stack || e);
  process.exit(1);
}
