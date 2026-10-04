#!/usr/bin/env node

/**
 * Daily DB Operating Brief
 *
 * A decision-oriented business review for IDGemz. Sales dates use Pacific
 * Time to match Amazon. The brief never turns partial channel data into a
 * production or demand conclusion: source freshness is a hard gate.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { DateTime } = require('luxon');

const REPO_DIR = path.resolve(__dirname, '..');
const CLAWD_DIR = '/Users/bbeaudoin/clawd';
require('dotenv').config({ path: path.join(REPO_DIR, '.env') });
require('dotenv').config({ path: path.join(REPO_DIR, '.env.local'), override: true });

const TELEGRAM_CHANNEL = process.env.DAILY_DB_BRIEF_TELEGRAM_CHANNEL || 'telegram';
const TELEGRAM_TARGET = process.env.DAILY_DB_BRIEF_TELEGRAM_TARGET || '8130524019';
const DRY_RUN = process.argv.includes('--dry-run') || ['1', 'true', 'yes', 'on'].includes(String(process.env.DAILY_DB_BRIEF_DRY_RUN || '').toLowerCase());
const FORCE = process.argv.includes('--force');
const STATE_PATH = path.join(CLAWD_DIR, 'memory', 'daily-db-operating-brief-state.json');
const SOURCE_FRESH_HOURS = 30;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz' });

function money(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0)); }
function num(value) { return Number(value || 0); }
function ptToday() { return DateTime.now().setZone('America/Los_Angeles').startOf('day'); }
function localDate() { return DateTime.now().setZone('America/New_York').toISODate(); }
function sourceFresh(at, expectedDate) {
  if (!at) return false;
  const checkedAt = DateTime.fromJSDate(new Date(at));
  const requiredCoverageEnd = DateTime.fromISO(expectedDate, { zone: 'America/Los_Angeles' }).plus({ days: 1 }).startOf('day');
  return checkedAt >= requiredCoverageEnd && DateTime.now().diff(checkedAt, 'hours').hours <= SOURCE_FRESH_HOURS;
}
async function queryOne(sql, values = []) { return (await pool.query(sql, values)).rows[0] || null; }

async function getSourceHealth(expectedDate) {
  const rows = await pool.query(`
    WITH latest_logs AS (
      SELECT DISTINCT ON (channel_id) channel_id, status, completed_at
      FROM sync_logs WHERE sync_type IN ('orders', 'shopify_orders') AND status = 'completed'
      ORDER BY channel_id, completed_at DESC NULLS LAST, started_at DESC
    )
    SELECT c.platform, c.last_sync_at, l.status AS log_status, l.completed_at,
           CASE WHEN c.platform IN ('etsy', 'walmart') THEN c.last_sync_at ELSE l.completed_at END AS checked_at
    FROM channels c LEFT JOIN latest_logs l ON l.channel_id = c.id
    WHERE c.platform IN ('amazon', 'shopify', 'etsy', 'walmart') ORDER BY c.platform
  `);
  const health = new Map(rows.rows.map((row) => [row.platform, { platform: row.platform, checkedAt: row.checked_at, fresh: sourceFresh(row.checked_at, expectedDate), status: row.log_status || (row.checked_at ? 'completed' : 'unknown') }]));
  for (const platform of ['amazon', 'shopify', 'etsy', 'walmart']) {
    if (!health.has(platform)) health.set(platform, { platform, checkedAt: null, fresh: false, status: 'missing' });
  }
  const amazonMetric = await queryOne(`SELECT date_pt::text, total_sales, order_count, unit_count, fetched_at FROM amazon_daily_metrics WHERE date_pt=$1::date`, [expectedDate]);
  const amazon = health.get('amazon') || { platform: 'amazon', fresh: false, status: 'unknown' };
  amazon.metric = amazonMetric;
  amazon.fresh = amazon.fresh && Boolean(amazonMetric) && sourceFresh(amazonMetric?.fetched_at, expectedDate);
  health.set('amazon', amazon);
  return { health: [...health.values()], amazonMetric };
}

async function getBriefData() {
  const salesDate = ptToday().minus({ days: 1 }).toISODate();
  const { health, amazonMetric } = await getSourceHealth(salesDate);
  const staleSources = health.filter((row) => !row.fresh);
  const nonAmazonDaily = await queryOne(`
    SELECT COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(oi.quantity),0)::int AS units,
           COALESCE(SUM(oi.quantity * oi.unit_price),0)::numeric AS revenue
    FROM orders o JOIN channels c ON c.id=o.channel_id JOIN order_items oi ON oi.order_id=o.id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date=$1::date
      AND c.platform <> 'amazon' AND COALESCE(o.status,'') <> 'Pending'
  `, [salesDate]);
  const daily = { orders: num(nonAmazonDaily.orders) + num(amazonMetric?.order_count), units: num(nonAmazonDaily.units) + num(amazonMetric?.unit_count), revenue: num(nonAmazonDaily.revenue) + num(amazonMetric?.total_sales) };
  const baseline = await queryOne(`
    WITH dates AS (SELECT generate_series($1::date - 7, $1::date - 1, interval '1 day')::date AS day),
    non_amazon AS (
      SELECT (o.order_date AT TIME ZONE 'America/Los_Angeles')::date AS day,
             SUM(oi.quantity * oi.unit_price)::numeric AS revenue, SUM(oi.quantity)::numeric AS units
      FROM orders o JOIN channels c ON c.id=o.channel_id JOIN order_items oi ON oi.order_id=o.id
      WHERE c.platform <> 'amazon' AND COALESCE(o.status,'') <> 'Pending'
        AND (o.order_date AT TIME ZONE 'America/Los_Angeles')::date >= $1::date - 7
        AND (o.order_date AT TIME ZONE 'America/Los_Angeles')::date < $1::date GROUP BY 1
    )
    SELECT AVG(COALESCE(a.total_sales,0)+COALESCE(n.revenue,0))::numeric AS avg_revenue,
           AVG(COALESCE(a.unit_count,0)+COALESCE(n.units,0))::numeric AS avg_units,
           COUNT(a.date_pt)::int AS amazon_days_present
    FROM dates d LEFT JOIN amazon_daily_metrics a ON a.date_pt=d.day LEFT JOIN non_amazon n ON n.day=d.day
  `, [salesDate]);
  const nonAmazonChannels = await pool.query(`
    SELECT c.platform, COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(oi.quantity),0)::int AS units,
           COALESCE(SUM(oi.quantity * oi.unit_price),0)::numeric AS revenue
    FROM orders o JOIN channels c ON c.id=o.channel_id JOIN order_items oi ON oi.order_id=o.id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date=$1::date
      AND c.platform <> 'amazon' AND COALESCE(o.status,'') <> 'Pending'
    GROUP BY c.platform ORDER BY revenue DESC
  `, [salesDate]);
  const channels = [{ platform: 'amazon', orders: num(amazonMetric?.order_count), units: num(amazonMetric?.unit_count), revenue: num(amazonMetric?.total_sales) }, ...nonAmazonChannels.rows];
  const topSkus = await pool.query(`
    SELECT p.internal_sku AS sku, SUM(oi.quantity)::int AS units, COALESCE(SUM(oi.quantity * oi.unit_price),0)::numeric AS revenue
    FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN channel_listings cl ON cl.id=oi.channel_listing_id JOIN products p ON p.id=cl.product_id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date=$1::date AND COALESCE(o.status,'') <> 'Pending'
    GROUP BY p.internal_sku ORDER BY units DESC,revenue DESC LIMIT 3
  `, [salesDate]);
  const bulkOrders = await pool.query(`
    SELECT c.platform,o.channel_order_id,p.internal_sku AS sku,SUM(oi.quantity)::int AS units,COALESCE(SUM(oi.quantity*oi.unit_price),0)::numeric AS revenue
    FROM orders o JOIN channels c ON c.id=o.channel_id JOIN order_items oi ON oi.order_id=o.id JOIN channel_listings cl ON cl.id=oi.channel_listing_id JOIN products p ON p.id=cl.product_id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date=$1::date AND COALESCE(o.status,'') <> 'Pending'
    GROUP BY c.platform,o.channel_order_id,p.internal_sku HAVING SUM(oi.quantity)>=5 ORDER BY units DESC,revenue DESC LIMIT 3
  `, [salesDate]);
  const inventory = await pool.query(`
    WITH recent_sales AS (
      SELECT cl.product_id,SUM(oi.quantity)::int AS units_60d FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN channel_listings cl ON cl.id=oi.channel_listing_id
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date >= $1::date - 60 AND COALESCE(o.status,'') <> 'Pending' GROUP BY cl.product_id
    )
    SELECT p.internal_sku AS sku,SUM(i.quantity_available)::int AS available,SUM(i.quantity_inbound)::int AS inbound,MAX(rs.units_60d)::int AS units_60d
    FROM inventory i JOIN channels c ON c.id=i.channel_id JOIN products p ON p.id=i.product_id JOIN channel_listings cl ON cl.product_id=p.id AND cl.channel_id=c.id JOIN recent_sales rs ON rs.product_id=p.id
    WHERE c.platform='amazon' AND i.last_updated >= now()-interval '36 hours' AND COALESCE(p.deprecated,false)=false AND cl.status='active' AND COALESCE(p.title,'') <> '-'
    GROUP BY p.internal_sku HAVING SUM(i.quantity_available)+SUM(i.quantity_inbound) < GREATEST(5, CEIL(MAX(rs.units_60d)::numeric*14/60))
    ORDER BY (SUM(i.quantity_available)+SUM(i.quantity_inbound)) ASC,MAX(rs.units_60d) DESC,p.internal_sku LIMIT 5
  `, [salesDate]);
  return { salesDate, complete: staleSources.length === 0, staleSources, health, daily, baseline, channels, topSkus: topSkus.rows, bulkOrders: bulkOrders.rows, inventory: inventory.rows };
}

function formatSource(row) { return `${row.platform}${row.checkedAt ? ` (${DateTime.fromJSDate(new Date(row.checkedAt)).toFormat('MMM d h:mma')})` : ' (no successful sync recorded)'}`; }
function buildBrief(data) {
  const actions = []; const happened = []; const dataHealth = [];
  const baselineComplete = num(data.baseline.amazon_days_present) === 7;
  if (!data.complete) {
    actions.push(`Restore/verify source sync before using sales for production: ${data.staleSources.map(formatSource).join(', ')}.`);
    dataHealth.push('Sales and production conclusions are suppressed because one or more channels are not freshly verified.');
  } else {
    const revenue = num(data.daily.revenue); const units = num(data.daily.units); const avgRevenue = num(data.baseline.avg_revenue); const avgUnits = num(data.baseline.avg_units);
    const revenueDelta = avgRevenue > 0 ? revenue / avgRevenue - 1 : 0; const unitDelta = avgUnits > 0 ? units / avgUnits - 1 : 0;
    happened.push(`${data.salesDate}: ${money(revenue)} from ${data.daily.orders} orders / ${units} units.`);
    if (baselineComplete && avgRevenue > 0) {
      happened.push(`Versus prior 7 calendar days: revenue ${revenueDelta >= 0 ? '+' : ''}${Math.round(revenueDelta*100)}%; units ${unitDelta >= 0 ? '+' : ''}${Math.round(unitDelta*100)}%.`);
      if (revenueDelta >= .75 || unitDelta >= .75) actions.push(`Check production capacity for the sales spike${data.topSkus[0] ? `; ${data.topSkus[0].sku} led tracked units` : ''}.`);
      if (revenueDelta <= -.60 && avgRevenue >= 100) actions.push('Review the low-sales day against listings, ads, and channel availability before treating it as demand loss.');
    } else dataHealth.push('Seven-day baseline is incomplete; anomaly alerts are suppressed.');
    happened.push(`Channel mix: ${data.channels.map((row) => `${row.platform} ${money(row.revenue)} / ${row.units}u`).join('; ')}.`);
    if (data.topSkus.length) happened.push(`Top tracked SKUs: ${data.topSkus.map((row) => `${row.sku} ${row.units}u`).join('; ')}. Amazon detail may lag its authoritative total.`);
    for (const row of data.bulkOrders) actions.push(`Review possible bulk/B2B order: ${row.platform} ${row.channel_order_id}, ${row.sku}, ${row.units} units (${money(row.revenue)}).`);
    dataHealth.push('All sales channels have a recent successful sync; Amazon totals use SP-API Sales metrics.');
  }
  for (const row of data.inventory) actions.push(`Confirm Amazon replenishment for ${row.sku}: ${row.available} sellable + ${row.inbound} inbound; ${row.units_60d} units sold in 60 days. Reserved units are excluded.`);
  if (!actions.length) actions.push('No verified production, inventory, or sales anomaly crossed the action threshold today.');
  return [`DB Daily Operating Brief — ${localDate()}`, '', 'ACTIONS TODAY', ...actions.slice(0,5).map((item,i)=>`${i+1}. ${item}`), '', 'WHAT HAPPENED', ...(happened.length ? happened.map(x=>`• ${x}`) : ['• Sales summary withheld until source freshness is restored.']), '', 'DATA HEALTH', ...dataHealth.map(x=>`• ${x}`)].join('\n');
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH,'utf8')); } catch { return {}; } }
function writeState(state) { fs.mkdirSync(path.dirname(STATE_PATH),{recursive:true}); fs.writeFileSync(`${STATE_PATH}.tmp`,JSON.stringify(state,null,2)); fs.renameSync(`${STATE_PATH}.tmp`,STATE_PATH); }
function upsertDailyNote(brief) {
  const notePath=path.join(CLAWD_DIR,'memory',`${localDate()}.md`); const heading=`## ${localDate()} DB Daily Operating Brief`; const prior=fs.existsSync(notePath)?fs.readFileSync(notePath,'utf8'):''; const esc=heading.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  fs.writeFileSync(notePath,`${prior.replace(new RegExp(`\\n?${esc}[\\s\\S]*?(?=\\n## |$)`,'g'),'').trimEnd()}\n\n${heading}\n\n${brief}\n`);
}
function sendTelegram(message) { const r=spawnSync('openclaw',['message','send','--channel',TELEGRAM_CHANNEL,'--target',TELEGRAM_TARGET,'--message',message],{cwd:REPO_DIR,encoding:'utf8',timeout:90000,env:{...process.env,HOME:process.env.HOME||'/Users/bbeaudoin',PATH:process.env.PATH||'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}}); if(r.status!==0) throw new Error(`Telegram delivery failed: ${(r.stderr||r.stdout||`exit ${r.status}`).trim()}`); }
async function main() {
  const data=await getBriefData(); const brief=buildBrief(data); const state=readState();
  if(DRY_RUN){console.log(brief);return;}
  if(!FORCE && (state.lastDeliveredSalesDate===data.salesDate || state.lastAttemptedSalesDate===data.salesDate)) {
    console.log(`Brief for ${data.salesDate} was already attempted; skipping duplicate.`); return;
  }
  // Persist an attempt before delivery. Telegram has no idempotency key here,
  // so suppressing a possible duplicate is safer than automatic retries after
  // an ambiguous timeout. A failed run can be reviewed and resent with --force.
  writeState({lastAttemptedSalesDate:data.salesDate,attemptedAt:new Date().toISOString(),delivery:'attempting'});
  sendTelegram(brief);
  writeState({lastAttemptedSalesDate:data.salesDate,lastDeliveredSalesDate:data.salesDate,deliveredAt:new Date().toISOString(),delivery:'delivered'});
  upsertDailyNote(brief);
}
main().catch((error)=>{console.error(error?.stack||error);process.exitCode=1;}).finally(()=>pool.end());
