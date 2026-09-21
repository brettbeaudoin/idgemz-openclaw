#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..');
const CLAWD_DIR = '/Users/bbeaudoin/clawd';
const STACK_DIR = path.join(REPO_DIR, 'memory-stack');
const PLUGIN_DIR = path.join(REPO_DIR, 'openclaw-memory-milvus');
const LOG_DIR = path.join(REPO_DIR, 'logs');
const TELEGRAM_CHANNEL = process.env.SELF_IMPROVEMENT_TELEGRAM_CHANNEL || 'telegram';
const TELEGRAM_TARGET = process.env.SELF_IMPROVEMENT_TELEGRAM_TARGET || '8130524019';
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes(String(process.env.SELF_IMPROVEMENT_DRY_RUN || '').toLowerCase());

const changes = [];
const ok = [];
const needsPermission = [];
const needsAttention = [];

function nowIso() {
  return new Date().toISOString();
}

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_DIR,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    env: {
      ...process.env,
      HOME: process.env.HOME || '/Users/bbeaudoin',
      PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    }
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n').trim();
  return {
    name,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    output,
    ok: result.status === 0
  };
}

function addResult(result, successMessage, failureMessage) {
  if (result.ok) {
    ok.push(successMessage);
  } else {
    needsAttention.push(`${failureMessage}: ${summarizeOutput(result)}`);
  }
}

function summarizeOutput(result, max = 700) {
  const text = result.output || `exit ${result.status}${result.signal ? ` signal ${result.signal}` : ''}`;
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function sendTelegram(text) {
  const result = run('send telegram', 'openclaw', [
    'message', 'send',
    '--channel', TELEGRAM_CHANNEL,
    '--target', TELEGRAM_TARGET,
    '--message', text
  ], { timeout: 90000 });
  if (!result.ok) {
    throw new Error(`openclaw message send failed: ${summarizeOutput(result)}`);
  }
}

function appendDailyNote(summaryLines) {
  const memoryDir = path.join(CLAWD_DIR, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const notePath = path.join(memoryDir, `${localDate()}.md`);
  const body = [
    '',
    `## ${localDate()} Weekly Self-Improvement Maintenance`,
    `- Ran at ${nowIso()} from \`${path.relative(CLAWD_DIR, __filename)}\`.`,
    ...summaryLines.map((line) => `- ${line}`)
  ].join('\n');
  fs.appendFileSync(notePath, `${body}\n`);
  changes.push(`Appended weekly self-improvement summary to ${path.relative(CLAWD_DIR, notePath)}`);
}

function gitStatus() {
  return run('git status', 'git', ['status', '--short', '--branch'], { cwd: REPO_DIR });
}

function maybePushCleanAheadBranch() {
  const status = gitStatus();
  if (!status.ok) {
    needsAttention.push(`Could not inspect git status: ${summarizeOutput(status)}`);
    return;
  }
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0] || '';
  const dirty = lines.slice(1);
  if (dirty.length > 0) {
    needsAttention.push(`Repo has uncommitted changes; skipped push until reviewed: ${dirty.slice(0, 6).join('; ')}`);
    return;
  }
  if (!/\[ahead \d+\]/.test(branchLine)) {
    ok.push('GitHub branch is clean with no local commits waiting to push');
    return;
  }
  const push = run('git push', 'git', ['push'], { cwd: REPO_DIR, timeout: 180000 });
  if (push.ok) {
    changes.push('Pushed clean local commits to GitHub');
  } else {
    needsAttention.push(`GitHub push failed: ${summarizeOutput(push)}`);
  }
}

function checkMemoryStack() {
  addResult(
    run('docker compose config', 'docker', ['compose', '--env-file', '.env', 'config', '--quiet'], { cwd: STACK_DIR }),
    'Docker Compose memory-stack config is valid',
    'Docker Compose config check failed'
  );
  addResult(
    run('hindsight health', 'curl', ['-fsS', 'http://localhost:8888/health'], { timeout: 30000 }),
    'Hindsight health endpoint is reachable',
    'Hindsight health check failed'
  );
  addResult(
    run('milvus health', 'curl', ['-fsS', 'http://localhost:9091/healthz'], { timeout: 30000 }),
    'Milvus health endpoint is reachable',
    'Milvus health check failed'
  );

  const dryRun = run('memory dry-run', 'npm', ['run', 'dry-run'], { cwd: STACK_DIR, timeout: 180000 });
  addResult(dryRun, 'Canonical memory files scan cleanly', 'Memory dry-run failed');

  const milvus = run('memory index-milvus', 'npm', ['run', 'index-milvus'], { cwd: STACK_DIR, timeout: 600000 });
  if (milvus.ok) {
    changes.push('Refreshed Postgres manifest and Milvus derived index from canonical files');
  } else {
    needsAttention.push(`Milvus refresh failed: ${summarizeOutput(milvus)}`);
  }

  const hindsight = run('memory retain', 'npm', ['run', 'retain'], { cwd: STACK_DIR, timeout: 600000 });
  if (hindsight.ok) {
    changes.push('Refreshed Hindsight retain queue from canonical files');
  } else {
    needsAttention.push(`Hindsight retain failed: ${summarizeOutput(hindsight)}`);
  }
}

function checkRecallPlugin() {
  addResult(
    run('plugin tests', 'npm', ['test'], { cwd: PLUGIN_DIR, timeout: 180000 }),
    'memory_recall plugin tests pass',
    'memory_recall plugin tests failed'
  );
  addResult(
    run('plugin validate', 'npm', ['run', 'plugin:validate'], { cwd: PLUGIN_DIR, timeout: 180000 }),
    'memory_recall plugin validates for OpenClaw',
    'memory_recall plugin validation failed'
  );
}

function checkRuntimeBasics() {
  addResult(
    run('docker compose version', 'docker', ['compose', 'version'], { timeout: 30000 }),
    'docker compose is wired as a Docker subcommand',
    'docker compose subcommand check failed'
  );
  addResult(
    run('node version', 'node', ['--version'], { timeout: 30000 }),
    'Node is available for cron scripts',
    'Node version check failed'
  );
}

function buildMessage() {
  const lines = ['Weekly DB self-improvement report', `Time: ${nowIso()}`, ''];
  const changed = changes.length ? changes : ['No source/code changes were needed; safe maintenance checks ran.'];
  lines.push('Changed:');
  changed.slice(0, 8).forEach((item) => lines.push(`- ${item}`));
  if (ok.length) {
    lines.push('', 'Verified:');
    ok.slice(0, 8).forEach((item) => lines.push(`- ${item}`));
  }
  if (needsPermission.length) {
    lines.push('', 'Needs permission:');
    needsPermission.slice(0, 6).forEach((item) => lines.push(`- ${item}`));
  }
  if (needsAttention.length) {
    lines.push('', 'Needs attention:');
    needsAttention.slice(0, 6).forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  checkRuntimeBasics();
  checkMemoryStack();
  checkRecallPlugin();
  maybePushCleanAheadBranch();

  needsPermission.push('Skipped LLM-backed self-review/code edits because that can spend API money; approve a one-off review when you want that lane run.');

  if (!DRY_RUN) {
    appendDailyNote([
      ...changes.map((item) => `Changed: ${item}`),
      ...ok.slice(0, 8).map((item) => `Verified: ${item}`),
      ...needsPermission.map((item) => `Needs permission: ${item}`),
      ...needsAttention.slice(0, 8).map((item) => `Needs attention: ${item}`)
    ]);
  }

  const message = buildMessage();
  if (DRY_RUN) {
    console.log(message);
  } else {
    sendTelegram(message);
  }
}

try {
  main();
} catch (error) {
  const text = `Weekly DB self-improvement report\nTime: ${nowIso()}\n\nNeeds attention:\n- Self-improvement runner crashed: ${error?.stack || error}`;
  try {
    sendTelegram(text);
  } catch (sendError) {
    console.error(sendError?.stack || sendError);
  }
  console.error(error?.stack || error);
  process.exit(1);
}
