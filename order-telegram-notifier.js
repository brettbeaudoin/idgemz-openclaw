#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('./gog-env');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/idgemz';
const TELEGRAM_TARGET = process.env.ORDER_ALERT_TELEGRAM_TARGET || '8130524019';
const TELEGRAM_CHANNEL = process.env.ORDER_ALERT_TELEGRAM_CHANNEL || 'telegram';

function parseArgs(argv) {
  const args = {
    channels: ['shopify', 'etsy'],
    markExisting: false,
    sinceHours: Number(process.env.ORDER_ALERT_SINCE_HOURS || 168)
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channels') {
      args.channels = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--channel') {
      args.channels = [String(argv[++i] || '').trim().toLowerCase()].filter(Boolean);
    } else if (arg === '--mark-existing') {
      args.markExisting = true;
    } else if (arg === '--since-hours') {
      args.sinceHours = Number(argv[++i]);
    }
  }

  if (!args.channels.length) throw new Error('At least one channel is required');
  if (!Number.isFinite(args.sinceHours) || args.sinceHours <= 0) args.sinceHours = 72;
  return args;
}

function money(value) {
  const n = Number(value || 0);
  return `$${n.toFixed(2)}`;
}

function quantity(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function ensureNotificationTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.order_telegram_notifications (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      channel_id uuid NOT NULL REFERENCES public.channels(id),
      channel_order_id text NOT NULL,
      notification_type text NOT NULL DEFAULT 'new_order',
      status text NOT NULL,
      message text,
      sent_at timestamptz,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (channel_id, channel_order_id, notification_type)
    );
  `);
}

async function markExistingOrders(pool, channels) {
  const res = await pool.query(
    `INSERT INTO public.order_telegram_notifications (
       channel_id, channel_order_id, notification_type, status, sent_at, message
     )
     SELECT o.channel_id,
            o.channel_order_id,
            'new_order',
            'suppressed_existing',
            now(),
            'Existing order before Telegram order alerts were enabled'
     FROM public.orders o
     JOIN public.channels c ON c.id = o.channel_id
     WHERE c.platform = ANY($1::text[])
     ON CONFLICT (channel_id, channel_order_id, notification_type) DO NOTHING`,
    [channels]
  );
  return res.rowCount;
}

async function loadPendingOrders(pool, channels, sinceHours) {
  const res = await pool.query(
    `SELECT o.id,
            o.channel_id,
            o.channel_order_id,
            o.order_date,
            o.order_total,
            c.platform,
            COALESCE(so.name, o.channel_order_id) AS display_order_id
     FROM public.orders o
     JOIN public.channels c ON c.id = o.channel_id
     LEFT JOIN public.shopify_orders so ON so.order_id = o.id
     WHERE c.platform = ANY($1::text[])
       AND o.order_date >= now() - ($2::text || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1
         FROM public.order_telegram_notifications n
         WHERE n.channel_id = o.channel_id
           AND n.channel_order_id = o.channel_order_id
           AND n.notification_type = 'new_order'
       )
     ORDER BY o.order_date ASC`,
    [channels, String(Math.ceil(sinceHours))]
  );
  return res.rows;
}

async function loadOrderLines(pool, orderId) {
  const res = await pool.query(
    `SELECT oi.quantity,
            oi.unit_price,
            oi.total,
            oi.raw,
            cl.channel_sku,
            p.internal_sku
     FROM public.order_items oi
     LEFT JOIN public.channel_listings cl ON cl.id = oi.channel_listing_id
     LEFT JOIN public.products p ON p.id = cl.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.created_at ASC, oi.id ASC`,
    [orderId]
  );

  return res.rows.map((row) => {
    const raw = row.raw || {};
    const sku = String(
      row.channel_sku
      || raw.sku
      || raw.SKU
      || raw.SellerSKU
      || row.internal_sku
      || 'UNKNOWN'
    ).trim();
    const qty = quantity(row.quantity);
    const total = row.total == null && row.unit_price != null
      ? Number(row.unit_price) * qty
      : Number(row.total || 0);
    return { sku, qty, total };
  });
}

function summarizeLines(lines) {
  const bySku = new Map();
  for (const line of lines) {
    const current = bySku.get(line.sku) || { sku: line.sku, qty: 0, total: 0 };
    current.qty += line.qty;
    current.total += Number(line.total || 0);
    bySku.set(line.sku, current);
  }
  return Array.from(bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
}

function buildMessage(order, lines) {
  const platform = order.platform === 'shopify' ? 'Shopify' : 'Etsy';
  const summary = summarizeLines(lines);
  const unitCount = summary.reduce((sum, line) => sum + line.qty, 0);
  const skuText = summary.length
    ? summary.map((line) => `${line.sku} x${line.qty}`).join(', ')
    : 'UNKNOWN';

  return [
    `New ${platform} order`,
    `Order: ${order.display_order_id}`,
    `Total: ${money(order.order_total)}`,
    `Qty: ${unitCount}`,
    `SKUs: ${skuText}`
  ].join('\n');
}

function sendTelegram(message) {
  const result = spawnSync('openclaw', [
    'message', 'send',
    '--channel', TELEGRAM_CHANNEL,
    '--target', TELEGRAM_TARGET,
    '--message', message
  ], {
    encoding: 'utf8',
    timeout: 120000
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(combined || `openclaw message send failed with status ${result.status}`);
  }
}

async function reserveNotification(pool, order) {
  const res = await pool.query(
    `INSERT INTO public.order_telegram_notifications (
       channel_id, channel_order_id, notification_type, status
     ) VALUES ($1, $2, 'new_order', 'sending')
     ON CONFLICT (channel_id, channel_order_id, notification_type) DO NOTHING
     RETURNING id`,
    [order.channel_id, order.channel_order_id]
  );
  return res.rows[0]?.id || null;
}

async function markSent(pool, notificationId, message) {
  await pool.query(
    `UPDATE public.order_telegram_notifications
     SET status = 'sent',
         message = $2,
         sent_at = now(),
         error_message = NULL,
         updated_at = now()
     WHERE id = $1`,
    [notificationId, message]
  );
}

async function releaseFailedReservation(pool, notificationId, error) {
  await pool.query(
    `DELETE FROM public.order_telegram_notifications
     WHERE id = $1 AND status = 'sending'`,
    [notificationId]
  );
  console.error(error?.stack || error);
}

async function sendPendingNotifications(pool, channels, sinceHours) {
  const orders = await loadPendingOrders(pool, channels, sinceHours);
  let sent = 0;

  for (const order of orders) {
    const notificationId = await reserveNotification(pool, order);
    if (!notificationId) continue;

    try {
      const lines = await loadOrderLines(pool, order.id);
      const message = buildMessage(order, lines);
      sendTelegram(message);
      await markSent(pool, notificationId, message);
      sent++;
      console.log(`Sent ${order.platform} order alert for ${order.display_order_id}.`);
    } catch (error) {
      await releaseFailedReservation(pool, notificationId, error);
      throw error;
    }
  }

  return sent;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    await ensureNotificationTable(pool);
    if (args.markExisting) {
      const marked = await markExistingOrders(pool, args.channels);
      console.log(`Marked ${marked} existing ${args.channels.join(', ')} orders as already handled.`);
      return;
    }

    const sent = await sendPendingNotifications(pool, args.channels, args.sinceHours);
    console.log(`Sent ${sent} order alert(s) for ${args.channels.join(', ')}.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('order-telegram-notifier failed:', error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  ensureNotificationTable,
  markExistingOrders,
  sendPendingNotifications
};
