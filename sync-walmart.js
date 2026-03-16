#!/usr/bin/env node

/*
Walmart Marketplace → Postgres sync (orders + order_items).

Env (in .env.local):
  WALMART_CLIENT_ID
  WALMART_CLIENT_SECRET
  WALMART_SELLER_ID

Usage:
  node sync-walmart.js --days-back 2
  node sync-walmart.js --start 2025-01-01 --end 2025-01-03

Notes:
- This uses Walmart Marketplace v3 OAuth client_credentials.
- For totals/pricing, Walmart APIs vary by endpoint; we prefer order detail line charges.
*/

require('dotenv').config({ path: require('path').resolve(__dirname, '.env.local') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { WalmartClient } = require('./walmart-client');
const { ensureCustomerForOrder } = require('./customer-identity');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function has(name) {
  return process.argv.includes(name);
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function safeGet(o, path, def = null) {
  try {
    let cur = o;
    for (const p of path) {
      if (cur == null) return def;
      cur = cur[p];
    }
    return cur == null ? def : cur;
  } catch {
    return def;
  }
}

function toIsoZ(dt) {
  // Walmart accepts RFC3339; ensure UTC Z
  return DateTime.fromISO(dt, { zone: 'utc' }).toUTC().toISO();
}

function parseMoneyObj(m) {
  // common Walmart: { currency: 'USD', amount: 12.34 } or string
  if (m == null) return { amount: null, currency: null };
  if (typeof m === 'number') return { amount: m, currency: null };
  if (typeof m === 'string') return { amount: num(m), currency: null };
  const amount = m.amount != null ? num(m.amount) : (m.value != null ? num(m.value) : null);
  const currency = m.currency || m.currencyCode || m.currency_code || null;
  return { amount, currency };
}

function summarizeLineCharges(line) {
  // Attempt to compute pre-tax, pre-shipping unit_price and totals.
  // Walmart order line charges often include charge: [{ chargeType, chargeName, chargeAmount: { amount, currency } }]
  const charges = line?.charges?.charge || line?.charges || [];
  const arr = Array.isArray(charges) ? charges : (charges?.charge ? charges.charge : []);

  let product = 0;
  let shipping = 0;
  let tax = 0;
  let discount = 0;
  let currency = null;

  for (const c of arr) {
    const type = String(c.chargeType || c.type || '').toUpperCase();
    const name = String(c.chargeName || c.name || '').toUpperCase();
    const { amount, currency: cur } = parseMoneyObj(c.chargeAmount || c.amount || c.chargeAmount?.value || c.chargeAmount);
    if (cur) currency = cur;

    // heuristics
    if (type.includes('TAX') || name.includes('TAX')) tax += amount || 0;
    else if (type.includes('SHIPPING') || name.includes('SHIPPING')) shipping += amount || 0;
    else if (type.includes('DISCOUNT') || name.includes('DISCOUNT') || name.includes('PROMO')) discount += amount || 0;
    else product += amount || 0;
  }

  return { product, shipping, tax, discount, currency };
}

async function ensureWalmartChannel() {
  const creds = {
    sellerId: process.env.WALMART_SELLER_ID,
    clientId: process.env.WALMART_CLIENT_ID ? 'set' : null
  };

  const res = await pool.query(`SELECT id FROM channels WHERE platform='walmart' LIMIT 1`);
  if (res.rows.length) {
    const id = res.rows[0].id;
    await pool.query(
      `UPDATE channels SET api_connected=true, api_credentials = COALESCE(api_credentials,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE id=$1`,
      [id, JSON.stringify(creds)]
    );
    return id;
  }

  const ins = await pool.query(
    `INSERT INTO channels (id, name, platform, api_connected, api_credentials, created_at, updated_at)
     VALUES (gen_random_uuid(), 'Walmart Marketplace', 'walmart', true, $1::jsonb, now(), now())
     RETURNING id`,
    [JSON.stringify(creds)]
  );
  return ins.rows[0].id;
}

async function upsertOrder({ channelId, orderId, orderDateIso, status, customerName, customerEmail, shippingAddress, orderTotal, currency, externalUpdatedAt, rawOrder }) {
  const amountKnown = orderTotal != null;

  const customerId = await ensureCustomerForOrder({
    pool,
    channel: 'walmart',
    buyerName: customerName,
    buyerEmail: customerEmail,
    shippingAddress: shippingAddress || {},
    source: 'walmart_orders_api'
  });

  const r = await pool.query(
    `INSERT INTO orders (
        channel_id, channel_order_id, order_date, customer_id, customer_name,
        customer_email, shipping_address, order_total, currency,
        status, fulfillment_channel, external_updated_at,
        amount_known
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (channel_id, channel_order_id)
      DO UPDATE SET
        order_date = EXCLUDED.order_date,
        customer_id = COALESCE(orders.customer_id, EXCLUDED.customer_id),
        customer_name = COALESCE(EXCLUDED.customer_name, orders.customer_name),
        customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
        shipping_address = COALESCE(EXCLUDED.shipping_address, orders.shipping_address),
        order_total = COALESCE(EXCLUDED.order_total, orders.order_total),
        currency = COALESCE(EXCLUDED.currency, orders.currency),
        status = COALESCE(EXCLUDED.status, orders.status),
        external_updated_at = COALESCE(EXCLUDED.external_updated_at, orders.external_updated_at),
        amount_known = (orders.amount_known OR EXCLUDED.amount_known),
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`,
    [
      channelId,
      orderId,
      orderDateIso,
      customerId,
      customerName,
      customerEmail,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      amountKnown ? orderTotal : 0,
      currency || 'USD',
      status || null,
      null,
      externalUpdatedAt || null,
      amountKnown
    ]
  );

  // Keep raw in order-level diagnostics table if present; otherwise ignore.
  // (We don't have a walmart_orders table yet.)
  return r.rows[0].id;
}

async function upsertOrderItem({ orderPk, channelLineItemId, quantity, unitPrice, shippingPrice, tax, discount, total, raw }) {
  await pool.query(
    `INSERT INTO order_items (
        id, order_id, channel_line_item_id,
        quantity, unit_price, shipping_price, tax, discount, total,
        raw, amount_known, created_at
      ) VALUES (
        gen_random_uuid(), $1, $2,
        $3, $4, $5, $6, $7, $8,
        $9::jsonb, $10, now()
      )
      ON CONFLICT (order_id, channel_line_item_id)
      DO UPDATE SET
        quantity = EXCLUDED.quantity,
        unit_price = COALESCE(EXCLUDED.unit_price, order_items.unit_price),
        shipping_price = COALESCE(EXCLUDED.shipping_price, order_items.shipping_price),
        tax = COALESCE(EXCLUDED.tax, order_items.tax),
        discount = COALESCE(EXCLUDED.discount, order_items.discount),
        total = COALESCE(EXCLUDED.total, order_items.total),
        raw = COALESCE(EXCLUDED.raw, order_items.raw),
        amount_known = (order_items.amount_known OR EXCLUDED.amount_known),
        created_at = COALESCE(order_items.created_at, now())`,
    [
      orderPk,
      channelLineItemId,
      quantity,
      unitPrice,
      shippingPrice,
      tax,
      discount,
      total,
      JSON.stringify(raw || {}),
      unitPrice != null
    ]
  );
}

async function syncRange({ client, channelId, startIso, endIso }) {
  console.log(`Walmart sync range: ${startIso} .. ${endIso}`);

  let nextCursor = null;
  let totalOrders = 0;

  while (true) {
    const { json } = await client.listOrders({
      createdStartDate: startIso,
      createdEndDate: endIso,
      limit: 200,
      nextCursor
    });

    const list = json?.list?.elements?.order || json?.orders || json?.order || [];
    const orders = Array.isArray(list) ? list : [list];

    for (const o of orders) {
      const purchaseOrderId = String(o.purchaseOrderId || o.orderId || o.id || '').trim();
      if (!purchaseOrderId) continue;

      // Fetch full detail for pricing + line items.
      const detail = await client.getOrder(purchaseOrderId);
      const od = detail.json?.order || detail.json;

      let orderDate = od?.orderDate || o.orderDate || od?.createdDate || null;
      // Walmart sometimes returns epoch millis as a string/number.
      if (orderDate != null) {
        const s = String(orderDate).trim();
        if (/^\d{13}$/.test(s)) {
          orderDate = new Date(Number(s)).toISOString();
        }
      }
      const status = od?.status || o?.status || null;

      const shippingInfo = od?.shippingInfo || od?.shipping || {};
      const shipAddr = shippingInfo?.postalAddress || shippingInfo?.address || od?.shippingAddress || null;
      const customerName = shipAddr?.name || shipAddr?.addresseeName || null;
      const customerEmail = od?.customerEmailId || od?.customerEmail || null;

      // Try to compute order_total from summary if present; otherwise leave unknown.
      let orderTotal = null;
      let currency = 'USD';
      const totalObj = od?.orderTotal || od?.totalAmount || null;
      if (totalObj) {
        const m = parseMoneyObj(totalObj);
        if (m.amount != null) orderTotal = m.amount;
        if (m.currency) currency = m.currency;
      }

      const orderPk = await upsertOrder({
        channelId,
        orderId: purchaseOrderId,
        orderDateIso: orderDate || new Date().toISOString(),
        status,
        customerName,
        customerEmail,
        shippingAddress: shipAddr,
        orderTotal,
        currency,
        externalUpdatedAt: od?.lastModifiedDate || od?.lastUpdateDate || null,
        rawOrder: od
      });

      const lines = safeGet(od, ['orderLines', 'orderLine'], []) || safeGet(od, ['orderLine'], []) || [];
      const orderLines = Array.isArray(lines) ? lines : [lines];

      let computedOrderTotal = 0;
      let computedCurrency = currency || 'USD';

      for (const line of orderLines) {
        const lineId = String(line.lineNumber || line.orderLineNumber || line.orderLineId || line.item?.sku || '').trim() || (globalThis.crypto?.randomUUID?.() || String(Math.random()));

        const qtyObj = line?.orderLineQuantity || line?.quantity || {};
        const quantity = num(qtyObj.amount || qtyObj.value || qtyObj || 0) || 0;

        const { product, shipping, tax, discount, currency: cur } = summarizeLineCharges(line);
        if (cur) computedCurrency = cur;

        // If product charge is a line total, derive unit_price.
        const unitPrice = quantity > 0 ? product / quantity : null;
        const total = product + shipping + tax + discount;

        if (Number.isFinite(total)) computedOrderTotal += total;

        await upsertOrderItem({
          orderPk,
          channelLineItemId: lineId,
          quantity: quantity || 1,
          unitPrice: unitPrice != null && Number.isFinite(unitPrice) ? unitPrice : null,
          shippingPrice: shipping || 0,
          tax: tax || 0,
          discount: discount || 0,
          total: total || null,
          raw: line
        });
      }

      // If the order didn't come with a top-level total, compute from items.
      if (orderTotal == null && computedOrderTotal > 0) {
        await pool.query(
          `UPDATE orders
           SET order_total=$2, currency=COALESCE(currency,$3), amount_known=true, updated_at=now()
           WHERE id=$1`,
          [orderPk, computedOrderTotal, computedCurrency]
        );
      }

      totalOrders++;
    }

    nextCursor = json?.list?.meta?.nextCursor || json?.nextCursor || null;
    if (!nextCursor) break;
    await sleep(250);
  }

  console.log(`Walmart sync complete. Orders processed: ${totalOrders}`);
}

async function main() {
  const client = new WalmartClient();
  const channelId = await ensureWalmartChannel();

  let start;
  let end;

  if (has('--start') && has('--end')) {
    start = DateTime.fromISO(arg('--start'), { zone: 'utc' }).startOf('day');
    end = DateTime.fromISO(arg('--end'), { zone: 'utc' }).startOf('day');
  } else {
    const daysBack = num(arg('--days-back') || process.env.WALMART_SYNC_DAYS_BACK || 2);
    end = DateTime.now().setZone('utc');
    start = end.minus({ days: daysBack });
  }

  await syncRange({
    client,
    channelId,
    startIso: start.toUTC().toISO(),
    endIso: end.toUTC().toISO()
  });

  await pool.query(`UPDATE channels SET last_sync_at=now(), updated_at=now() WHERE id=$1`, [channelId]);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('sync-walmart failed:', e?.stack || e);
    process.exit(1);
  }).finally(async () => {
    try { await pool.end(); } catch {}
  });
}
